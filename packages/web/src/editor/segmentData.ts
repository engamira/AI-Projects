import { useCallback, useEffect, useState } from 'react';
import {
  activeLanguageVersions, activeVariants, blocksShownFor, defaultEmailName, derivedSegments, pickVersion, routeKeyFor, segmentCode, segmentKey, versionName,
  type ContactField, type EmailContent, type SegmentVersion, type SegmentsResponse, type TestContactDto,
} from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';
import { useEditor } from './store';

export type AudienceInfo = { audience: { fields: string[] }; available: ContactField[]; test: TestContactDto[] };
export type Mode = 'conditions' | 'copies';
export type Cell = string | number | boolean | null;
/** One segment of the campaign: where it comes from and the values a made-up contact for it would have. */
export type SegmentRow = { key: string; code: string; values: Cell[]; fields: string[]; samples: string[] | null; total?: number; eligible?: number; hasTest: boolean };

/** The build choice of a campaign; none until the Builder chooses (older campaigns are read from the versions they already have). */
export function modeOf(content: EmailContent): Mode | undefined {
  if (content.versioning) return content.versioning.mode;
  if (content.variants?.length) return content.variants.some((v) => v.kind === 'language') ? 'conditions' : 'copies';
  return undefined;
}

export const plainLabel = (label: string): string => label.replace(/ \(.*\)$/, '');

/** Everything the Segments and Versions tabs need to know about the campaign's segments and which email each one receives. */
export function useSegmentData(campaignId: string, refreshKey: number) {
  const { can } = useSession();
  const content = useEditor((s) => s.content);
  const [info, setInfo] = useState<AudienceInfo | null>(null);
  const [segs, setSegs] = useState<SegmentsResponse | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    const i = await api<AudienceInfo>('GET', `/api/campaigns/${campaignId}/audience`);
    setInfo(i);
    if (can('audience.manage') && i.audience.fields.length) setSegs(await api<SegmentsResponse>('GET', `/api/audience/segments?fields=${i.audience.fields.join(',')}`));
    else setSegs(null);
  }, [campaignId, can]);
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))); }, [load, refreshKey]);

  const mode = modeOf(content);
  const chosen = info?.audience.fields ?? [];
  const chosenFields = chosen.map((k) => info?.available.find((f) => f.key === k)).filter((f): f is ContactField => !!f);
  const test = info?.test ?? [];
  const languageField = mode === 'conditions' ? chosen[0] : undefined;
  const typeOf = (k: string) => info?.available.find((f) => f.key === k)?.type;
  const routes = content.versioning?.routes ?? {};

  const copies = activeVariants(content, chosen);
  const languages: SegmentVersion[] = mode === 'conditions' && languageField ? activeLanguageVersions(content, chosen) : [];
  const unused = (content.variants ?? []).filter((v) => !copies.includes(v) && !languages.includes(v));

  // languages found in the segments (contact list and test audience), plus languages that already have an email
  const found = new Map<string, { value: string; contacts: number }>();
  if (languageField) {
    const at = chosen.indexOf(languageField);
    const note = (raw: unknown, n: number) => {
      const v = raw === null || raw === undefined ? '' : String(raw).trim();
      if (!v) return;
      const k = v.toLowerCase();
      found.set(k, { value: found.get(k)?.value ?? v, contacts: (found.get(k)?.contacts ?? 0) + n });
    };
    for (const s of segs?.segments ?? []) note(s.values[at], s.total);
    for (const c of test) note(c.data[languageField], 0);
    for (const v of languages) note(v.values[0], 0);
  }

  const testCodes = new Set(test.map((c) => c.code.toLowerCase()));
  const rowList: SegmentRow[] = [];
  let tooMany = false;
  if (mode === 'conditions' && languageField) {
    // English is the Default email, so its rules make segments too
    const langs = [...found.values()].map((l) => l.value);
    if (!langs.some((l) => l.toLowerCase() === 'en')) langs.push('en');
    const d = derivedSegments(content, chosen, langs, typeOf);
    tooMany = d.tooMany;
    // the "any other case" of a language (Default-ar) is the language's email itself, not a segment
    for (const r of d.rows.filter((x) => !x.template)) {
      const at = segs?.segments.find((s) => segmentKey(chosen, s.values) === segmentKey([languageField], [r.language]));
      rowList.push({
        key: r.key, code: r.code, values: r.values.map((x) => x || null), fields: r.fields, samples: r.samples,
        hasTest: testCodes.has(r.code.toLowerCase()) || (r.fields.length === 1 && testCodes.has(segmentCode([r.language]).toLowerCase())),
        ...(r.fields.length === 1 && at ? { total: at.total, eligible: at.eligible } : {}),
      });
    }
  } else if (mode === 'copies') {
    const seen = new Set<string>();
    const add = (vals: Cell[], extra: Partial<SegmentRow> = {}) => {
      const key = segmentKey(chosen, vals);
      if (seen.has(key)) return;
      seen.add(key);
      const code = segmentCode(vals);
      rowList.push({ key, code, values: vals, fields: chosen, samples: null, hasTest: testCodes.has(code.toLowerCase()), ...extra });
    };
    for (const s of segs?.segments ?? []) if (!s.values.every((v) => v === null || v === '')) add(s.values, { total: s.total, eligible: s.eligible });
    for (const c of test) add(chosenFields.map((f) => c.data[f.key] ?? null));
    for (const v of copies) add(v.values);
  }

  const contactOf = (r: SegmentRow) => Object.fromEntries(r.fields.map((k, i) => [k, r.values[i] ?? null]));
  /** A made-up contact whose fields really fall into this segment (used to ask the server which email it gets). */
  const sampleContact = (r: SegmentRow) => (r.samples ? Object.fromEntries(r.fields.map((k, i) => [k, r.samples![i] === '' ? null : r.samples![i]])) : contactOf(r));
  const withoutRoutes: EmailContent = (() => { const { routes: _r, ...rest } = content.versioning ?? { mode: 'copies' as Mode }; return { ...content, versioning: rest as EmailContent['versioning'] }; })();
  const resolve = (r: SegmentRow, c: EmailContent) => {
    const contact = sampleContact(r);
    const pick = pickVersion(c, chosen, contact, typeOf);
    const src = pick.variant ?? content;
    return { ...pick, shown: blocksShownFor(src.blocks, contact, typeOf).length, total: src.blocks.length };
  };
  const nameOf = (variantId: string | null | undefined): string => {
    const v = (content.variants ?? []).find((x) => x.id === variantId);
    if (v) return `${versionName(v)}${v.kind ? ' email' : ' version'}`;
    return mode === 'conditions' ? `${defaultEmailName(content)} email` : 'Default email';
  };
  const routeKey = (r: SegmentRow): string => routeKeyFor(content, chosen, sampleContact(r), typeOf);
  const routeOf = (r: SegmentRow): string => routes[routeKey(r)] ?? '';
  /** The made-up test contact of a segment, if one was built. */
  const testFor = (r: SegmentRow): TestContactDto | undefined =>
    test.find((c) => c.code.toLowerCase() === r.code.toLowerCase()) ?? (r.fields.length === 1 ? test.find((c) => c.code.toLowerCase() === segmentCode([r.values[0] ?? null]).toLowerCase()) : undefined);

  return {
    content, info, segs, load, loadError, mode, chosen, chosenFields, test, languageField, typeOf, routes, copies, languages, unused, found,
    rowList, tooMany, contactOf, sampleContact, withoutRoutes, resolve, nameOf, routeKey, routeOf, testFor,
  };
}
