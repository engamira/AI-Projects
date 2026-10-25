import type { BlockInstance, EmailContent, EmailVersion, SegmentVersion } from './content.js';
import { evaluateCondition, isGroup, valueList, type Comparison, type ConditionGroup, type ConditionRule } from './conditions.js';
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
export function pickVersion(content: EmailContent, audienceFields: string[], contact: Record<string, Value>, typeOf: (field: string) => ContactFieldType | undefined = () => 'text'): { variant: SegmentVersion | null; layer: VersionLayer } {
  const list = content.variants ?? [];
  const routes = content.versioning?.routes;
  if (routes && audienceFields.length) {
    const target = routes[routeKeyFor(content, audienceFields, contact, typeOf)];
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
// Every comparison makes a segment with a short name: "UAE" (is), "not UAE", "has ua" (contains), "no ua", "over 10",
// "under 10", "after 2025-01-01", "before 2025-01-01", "blank" and "filled". A contact belongs to the first one it meets
// (the plain "is" values first), or to "Default" when it meets none.

type TypeOf = (field: string) => ContactFieldType | undefined;

export type Atom = { code: string; rule: ConditionRule; /** a made-up value that meets this atom and no earlier one; null = could not be made */ sample: string | null };

export type DerivedSegment = {
  fields: string[]; values: string[]; key: string; code: string; language: string;
  /** A value to give a made-up test contact for each field ('' = blank), or null when this segment cannot be built (an earlier rule always wins). */
  samples: string[] | null;
};

function atomsOfRule(r: ConditionRule, type: ContactFieldType): Omit<Atom, 'sample'>[] {
  const vals = valueList(r.values);
  const one = (code: string, op: Comparison): Omit<Atom, 'sample'>[] => (vals[0] ? [{ code, rule: { field: r.field, op, values: [vals[0]] } }] : []);
  switch (r.op) {
    case 'is':
    case 'is_one_of': return vals.map((v) => ({ code: v, rule: { field: r.field, op: 'is' as const, values: [v] } }));
    case 'is_not': return vals.map((v) => ({ code: `not ${v}`, rule: { field: r.field, op: 'is_not' as const, values: [v] } }));
    case 'contains': return one(`has ${vals[0]}`, 'contains');
    case 'not_contains': return one(`no ${vals[0]}`, 'not_contains');
    case 'greater': return one(`${type === 'date' ? 'after' : 'over'} ${vals[0]}`, 'greater');
    case 'less': return one(`${type === 'date' ? 'before' : 'under'} ${vals[0]}`, 'less');
    case 'is_blank': return [{ code: 'blank', rule: { field: r.field, op: 'is_blank', values: [] } }];
    case 'is_not_blank': return [{ code: 'filled', rule: { field: r.field, op: 'is_not_blank', values: [] } }];
  }
}

const addDays = (d: string, n: number): string | null => {
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t + n * 86400000).toISOString().slice(0, 10);
};

/** Which atom of a field a value belongs to: the first one it meets, or '' (any other value). */
export function bucketOf(atoms: Atom[], field: string, raw: Value, typeOf: TypeOf): string {
  for (const a of atoms) if (evaluateCondition({ match: 'all', rules: [a.rule] }, () => raw, (f) => (f === field ? typeOf(f) : undefined))) return a.code;
  return '';
}

/** The atoms (segment parts) that the block conditions of one version use, per field, in the order they are tried. */
export function atomsIn(version: EmailVersion, exclude: string[] = [], typeOf: TypeOf = () => 'text'): Map<string, Atom[]> {
  const rules: ConditionRule[] = [];
  const walk = (g: ConditionGroup): void => { for (const r of g.rules) { if (isGroup(r)) walk(r); else rules.push(r); } };
  for (const b of version.blocks) if (b.showWhen) walk(b.showWhen);
  const raw = new Map<string, Omit<Atom, 'sample'>[]>();
  for (const r of rules) {
    if (exclude.includes(r.field)) continue;
    const list = raw.get(r.field) ?? [];
    for (const a of atomsOfRule(r, typeOf(r.field) ?? 'text')) if (!list.some((x) => x.code.toLowerCase() === a.code.toLowerCase())) list.push(a);
    raw.set(r.field, list);
  }
  const out = new Map<string, Atom[]>();
  for (const [field, list] of raw) {
    if (list.length === 0) continue;
    const type = typeOf(field) ?? 'text';
    const sorted = [...list.filter((a) => a.rule.op === 'is'), ...list.filter((a) => a.rule.op !== 'is')];
    const atoms: Atom[] = sorted.map((a) => ({ ...a, sample: null }));
    for (const a of atoms) {
      const v = a.rule.values[0] ?? '';
      const candidates: string[] = [];
      switch (a.rule.op) {
        case 'is': candidates.push(v); break;
        case 'is_not': candidates.push('Other', 'x'); break;
        case 'contains': candidates.push(v); break;
        case 'not_contains': candidates.push('Other', 'x', '0'); break;
        case 'greater': candidates.push(type === 'date' ? addDays(v, 1) ?? '' : String(Number(v) + 1)); break;
        case 'less': candidates.push(type === 'date' ? addDays(v, -1) ?? '' : String(Number(v) - 1)); break;
        case 'is_blank': candidates.push(''); break;
        case 'is_not_blank': candidates.push(type === 'number' ? '1' : type === 'date' ? '2000-01-01' : 'x'); break;
      }
      a.sample = candidates.find((c) => (c !== '' || a.rule.op === 'is_blank') && bucketOf(atoms, field, c, typeOf) === a.code) ?? (a.rule.op === 'is_blank' && bucketOf(atoms, field, '', typeOf) === a.code ? '' : null);
    }
    out.set(field, atoms);
  }
  return out;
}

const MAX_DERIVED = 2000;
const OTHER_SAMPLES = ['', 'Other', 'x', '0', '1900-01-01'];

/**
 * Segments made by the block conditions of a language default: one for every combination of the parts its conditions
 * use ("Default" = any other value), for each language.
 */
export function derivedSegments(content: EmailContent, audienceFields: string[], languages: string[], typeOf: TypeOf = () => 'text'): { rows: DerivedSegment[]; tooMany: boolean } {
  const lf = content.versioning?.languageField;
  const rows: DerivedSegment[] = [];
  if (content.versioning?.mode !== 'conditions' || !lf || !audienceFields.includes(lf)) return { rows, tooMany: false };
  for (const language of languages) {
    const lkey = segmentKey([lf], [language]);
    const v = (content.variants ?? []).find((x) => x.kind === 'language' && x.key === lkey && x.fields.join(',') === lf);
    const atoms = v ? atomsIn(v, [lf], typeOf) : new Map<string, Atom[]>();
    const fields = [...atoms.keys()];
    type Part = { code: string; sample: string | null };
    const lists: Part[][] = fields.map((f) => {
      const list = atoms.get(f)!;
      const other = OTHER_SAMPLES.find((s) => bucketOf(list, f, s, typeOf) === '');
      return [...list.map((a) => ({ code: a.code, sample: a.sample })), ...(other !== undefined ? [{ code: '', sample: other }] : [])];
    });
    const combos = lists.reduce<Part[][]>((acc, l) => acc.flatMap((a) => l.map((x) => [...a, x])), [[]]);
    for (const c of combos) {
      const values = [...c.map((p) => p.code), language];
      rows.push({
        fields: [...fields, lf], values, key: segmentKey([...fields, lf], values), code: values.map((x) => x || 'Default').join('-'), language,
        samples: c.every((p) => p.sample !== null) ? [...c.map((p) => p.sample as string), language] : null,
      });
      if (rows.length >= MAX_DERIVED) return { rows, tooMany: true };
    }
  }
  return { rows, tooMany: false };
}

/** Which segment (for sending one segment the email of another) a contact falls into. */
export function routeKeyFor(content: EmailContent, audienceFields: string[], contact: Record<string, Value>, typeOf: TypeOf = () => 'text'): string {
  const lf = content.versioning?.languageField;
  if (content.versioning?.mode === 'conditions' && lf && audienceFields.includes(lf)) {
    const lkey = segmentKey([lf], [contact[lf]]);
    const v = (content.variants ?? []).find((x) => x.kind === 'language' && x.key === lkey && x.fields.join(',') === lf);
    const atoms = v ? atomsIn(v, [lf], typeOf) : new Map<string, Atom[]>();
    const fields = [...atoms.keys()];
    const values = fields.map((f) => bucketOf(atoms.get(f)!, f, contact[f], typeOf));
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
