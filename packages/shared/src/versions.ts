import type { BlockInstance, EmailContent, EmailVersion, SegmentVersion } from './content.js';
import { evaluateCondition, isGroup, type ConditionGroup } from './conditions.js';
import { segmentCode, type ContactFieldType } from './contacts.js';

// Versions of an email for segments of the audience. The Default version is the email itself; a segment version is a
// full, independent copy written for one segment. A contact whose segment has no version gets the Default.

type Value = string | number | boolean | null | undefined;

/** How a value appears in a segment name: blank = '', yes/no for booleans. */
export function segmentPart(v: Value): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v).trim().replace(/\s+/g, ' ');
}

/** Identifies a segment for matching: the fields and the values, ignoring capitals (UAE and uae are the same segment). */
export function segmentKey(fields: string[], values: Value[]): string {
  return JSON.stringify([fields, values.map((v) => segmentPart(v).toLowerCase())]);
}

/** The short name of a segment version, for example UAE-ar. */
export const variantCode = (v: Pick<SegmentVersion, 'values'>): string => segmentCode(v.values.map((x) => x || null));

/** The words and blocks being edited: the Default (id null) or one segment version. Falls back to the Default if the id is unknown. */
export function versionOf(content: EmailContent, variantId: string | null): EmailVersion {
  const v = variantId ? content.variants?.find((x) => x.id === variantId) : undefined;
  return v ?? content;
}

/** Where a contact's email comes from. */
export type VersionLayer = 'copy' | 'language' | 'default' | 'mapped';

/** Blocks the contact sees: those with no condition, or whose condition the contact meets. */
export function blocksShownFor(blocks: BlockInstance[], contact: Record<string, Value>, typeOf?: (field: string) => ContactFieldType | undefined): BlockInstance[] {
  return blocks.filter((b) => !b.showWhen || evaluateCondition(b.showWhen, (f) => contact[f], typeOf));
}

/**
 * The email as one plain version (no variants), ready to render. When a contact is given, blocks whose "show when"
 * condition the contact does not meet are left out.
 */
export function flatContent(content: EmailContent, variant: SegmentVersion | null, opts: { contact?: Record<string, Value> | null; typeOf?: (field: string) => ContactFieldType | undefined } = {}): EmailContent {
  const src = variant ?? content;
  return { schemaVersion: 1, settings: src.settings, blocks: opts.contact ? blocksShownFor(src.blocks, opts.contact, opts.typeOf) : src.blocks };
}

/**
 * The email a contact receives, in this order: (1) a copy written for exactly their segment, (2) the default for their
 * language (when the campaign builds versions with conditions), (3) the overall Default (variant null).
 * `audienceFields` are the campaign's segment fields.
 */
export function pickVersion(content: EmailContent, audienceFields: string[], contact: Record<string, Value>): { variant: SegmentVersion | null; layer: VersionLayer } {
  const list = content.variants ?? [];
  const routes = content.versioning?.routes;
  if (routes && audienceFields.length) {
    const target = routes[routeKeyFor(content, audienceFields, contact)];
    if (target === 'default') return { variant: null, layer: 'mapped' };
    const mapped = target ? list.find((v) => v.id === target) : undefined;
    if (mapped) return { variant: mapped, layer: 'mapped' };
  }
  if (!list.length || audienceFields.length === 0) return { variant: null, layer: 'default' };
  const key = segmentKey(audienceFields, audienceFields.map((k) => contact[k]));
  const copy = list.find((v) => !v.kind && v.key === key && v.fields.join(',') === audienceFields.join(','));
  if (copy) return { variant: copy, layer: 'copy' };
  const lf = content.versioning?.languageField;
  if (content.versioning?.mode === 'conditions' && lf && audienceFields.includes(lf)) {
    const lkey = segmentKey([lf], [contact[lf]]);
    const lang = list.find((v) => v.kind === 'language' && v.key === lkey && v.fields.join(',') === lf);
    if (lang) return { variant: lang, layer: 'language' };
  }
  return { variant: null, layer: 'default' };
}

// ---------- Segments created by block conditions ----------
// When a campaign is built "one email per language", the show/hide conditions split each language into more segments:
// if blocks show only for Country UAE or SA, English contacts fall into UAE-en, SA-en and Default-en ("any other country").

export type DerivedSegment = { fields: string[]; values: string[]; key: string; code: string; language: string };

/** Values that rules compare with "is" or "is one of", per field (first spelling kept). */
function mentionedValues(g: ConditionGroup, out: Map<string, string[]>): void {
  for (const r of g.rules) {
    if (isGroup(r)) { mentionedValues(r, out); continue; }
    if (r.op !== 'is' && r.op !== 'is_one_of') continue;
    const list = out.get(r.field) ?? [];
    for (const raw of r.values) {
      const v = raw.trim();
      if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
    }
    out.set(r.field, list);
  }
}

/** The values the block conditions of one version look for, per field. */
export function mentionedIn(version: EmailVersion, exclude: string[] = []): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of version.blocks) if (b.showWhen) mentionedValues(b.showWhen, out);
  for (const k of exclude) out.delete(k);
  for (const [k, v] of [...out]) if (v.length === 0) out.delete(k);
  return out;
}

const MAX_DERIVED = 2000;

/**
 * Segments made by the block conditions of a language default: one for every combination of the values its conditions
 * mention ('' = any other value, shown as "Default"), for each language.
 */
export function derivedSegments(content: EmailContent, audienceFields: string[], languages: string[]): { rows: DerivedSegment[]; tooMany: boolean } {
  const lf = content.versioning?.languageField;
  const rows: DerivedSegment[] = [];
  if (content.versioning?.mode !== 'conditions' || !lf || !audienceFields.includes(lf)) return { rows, tooMany: false };
  for (const language of languages) {
    const lkey = segmentKey([lf], [language]);
    const v = (content.variants ?? []).find((x) => x.kind === 'language' && x.key === lkey && x.fields.join(',') === lf);
    const mentioned = v ? mentionedIn(v, [lf]) : new Map<string, string[]>();
    const fields = [...mentioned.keys()];
    const lists = fields.map((f) => [...mentioned.get(f)!, '']);
    const combos = lists.reduce<string[][]>((acc, l) => acc.flatMap((a) => l.map((x) => [...a, x])), [[]]);
    for (const c of combos) {
      const values = [...c, language];
      rows.push({ fields: [...fields, lf], values, key: segmentKey([...fields, lf], values), code: values.map((x) => x || 'Default').join('-'), language });
      if (rows.length >= MAX_DERIVED) return { rows, tooMany: true };
    }
  }
  return { rows, tooMany: false };
}

/** Which segment (for sending one segment the email of another) a contact falls into. */
export function routeKeyFor(content: EmailContent, audienceFields: string[], contact: Record<string, Value>): string {
  const lf = content.versioning?.languageField;
  if (content.versioning?.mode === 'conditions' && lf && audienceFields.includes(lf)) {
    const lkey = segmentKey([lf], [contact[lf]]);
    const v = (content.variants ?? []).find((x) => x.kind === 'language' && x.key === lkey && x.fields.join(',') === lf);
    const mentioned = v ? mentionedIn(v, [lf]) : new Map<string, string[]>();
    const fields = [...mentioned.keys()];
    const values = fields.map((f) => {
      const have = segmentPart(contact[f]).toLowerCase();
      return mentioned.get(f)!.find((x) => x.toLowerCase() === have) ?? '';
    });
    return segmentKey([...fields, lf], [...values, contact[lf]]);
  }
  return segmentKey(audienceFields, audienceFields.map((k) => contact[k]));
}

/** The version that a contact with these values receives, or null for the Default. */
export const pickVariant = (content: EmailContent, audienceFields: string[], contact: Record<string, Value>): SegmentVersion | null => pickVersion(content, audienceFields, contact).variant;

/** A new version, starting as an independent copy of `from` (the Default or another version). Blocks keep their ids so a shared fix can be copied across versions. */
export function newVariant(from: EmailVersion, fields: string[], values: Value[], kind?: 'language'): SegmentVersion {
  const copy = JSON.parse(JSON.stringify({ settings: from.settings, blocks: from.blocks })) as EmailVersion;
  return { id: crypto.randomUUID(), fields, values: values.map(segmentPart), key: segmentKey(fields, values), settings: copy.settings, blocks: copy.blocks, ...(kind ? { kind } : {}) };
}

/** Copies written for exactly one segment of the campaign's current segment fields (the others are kept but unused until the fields match again). */
export function activeVariants(content: EmailContent, audienceFields: string[]): SegmentVersion[] {
  return (content.variants ?? []).filter((v) => !v.kind && v.fields.join(',') === audienceFields.join(','));
}

/** Language defaults in use: the campaign builds with conditions, Language is one of its segment fields, and the default is for that field. */
export function activeLanguageVersions(content: EmailContent, audienceFields: string[]): SegmentVersion[] {
  const lf = content.versioning?.languageField;
  if (content.versioning?.mode !== 'conditions' || !lf || !audienceFields.includes(lf)) return [];
  return (content.variants ?? []).filter((v) => v.kind === 'language' && v.fields.join(',') === lf);
}

/** The name shown for a version: UAE-ar for a segment copy, "ar default" for a language default. */
export const versionName = (v: Pick<SegmentVersion, 'values' | 'kind'>): string => (v.kind === 'language' ? `${v.values[0] || 'blank'} default` : variantCode(v));
