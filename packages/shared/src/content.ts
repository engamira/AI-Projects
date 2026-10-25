import { z } from 'zod';
import { BLOCK_TYPES, LEGACY_COLOR_PROPS, blockDefinition, type BlockDefinition, type BlockType, type FieldDef, type Props } from './blocks.js';
import { PALETTE_IDS, type PaletteId } from './palettes.js';
import { validateCondition, type ConditionGroup } from './conditions.js';

// ---------- Email content: what is stored for every campaign draft and revision ----------

export type BlockInstance = {
  id: string; // unique within the email
  type: BlockType;
  sourceVersion: number; // version of the library definition it was created from
  props: Props; // this instance's own copy: edits never reach the library
  /** Show this block only to contacts who meet the condition (about the campaign's segment fields). Absent = everyone. */
  showWhen?: ConditionGroup;
};

export type EmailSettings = {
  subject: string;
  preheader: string;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  /** Template colors. Chosen when the campaign is created and locked afterwards. */
  palette: PaletteId;
  contentWidth: number;
  fontFamily: string;
};

/** The words and blocks of one email: the campaign's Default version, or the version made for one segment. */
export type EmailVersion = { settings: EmailSettings; blocks: BlockInstance[] };

/**
 * An email written for one segment of the audience (for example Country UAE + Language ar = "UAE-ar"). It is a full,
 * independent copy: later changes to the Default do not reach it. Contacts in a segment without a version get the Default.
 */
export type SegmentVersion = EmailVersion & {
  id: string;
  /** The contact fields that define the segment, in order (their keys). */
  fields: string[];
  /** The value of each field as shown in the segment name; '' = blank. */
  values: string[];
  /** Identifies the combination for matching (see segmentKey in versions.ts). */
  key: string;
  /** "language": the default email for one language (it holds every block any segment of that language needs, shown by conditions). Absent: a copy written for exactly one segment. */
  kind?: 'language';
};

/** How this campaign's versions are built. */
export type Versioning = {
  /** "conditions": one default email per language with show/hide conditions on blocks. "copies": a separate copy per segment. */
  mode: 'conditions' | 'copies';
  /** The contact field that holds the language (one of the campaign's segment fields). */
  languageField?: string;
  /** Sends one segment the email of another: segment key (see routeKeyFor in versions.ts) -> "default" or the id of a version. Absent: the automatic choice. */
  routes?: Record<string, string>;
};

export type EmailContent = {
  schemaVersion: 1;
  settings: EmailSettings;
  blocks: BlockInstance[];
  /** Versions written for particular segments. Absent when there are none. */
  variants?: SegmentVersion[];
  versioning?: Versioning;
};

export const MAX_VARIANTS = 200;

export const MAX_BLOCKS = 100;

export const FONT_OPTIONS = [
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: "'Trebuchet MS', Helvetica, sans-serif", label: 'Trebuchet' },
  { value: 'Tahoma, Geneva, sans-serif', label: 'Tahoma' },
  { value: "Georgia, 'Times New Roman', serif", label: 'Georgia' },
  { value: "'Times New Roman', Times, serif", label: 'Times New Roman' },
  { value: "'Courier New', Courier, monospace", label: 'Courier New' },
];

export const SETTINGS_FIELDS: FieldDef[] = [
  { key: 'subject', label: 'Subject line', kind: 'text', group: 'content', max: 200 },
  { key: 'preheader', label: 'Preview text (preheader)', kind: 'text', group: 'content', max: 200, help: 'The short line shown next to the subject in the inbox.' },
  { key: 'senderName', label: 'Sender name', kind: 'text', group: 'content', max: 100 },
  { key: 'senderEmail', label: 'Sender email', kind: 'text', group: 'content', max: 254 },
  { key: 'replyTo', label: 'Reply-to email', kind: 'text', group: 'content', max: 254 },
  { key: 'contentWidth', label: 'Email width', kind: 'number', group: 'style', min: 480, max: 700, unit: 'px' },
  { key: 'fontFamily', label: 'Font', kind: 'select', group: 'style', options: FONT_OPTIONS },
];

export const defaultSettings = (palette: PaletteId = 'travel'): EmailSettings => ({
  subject: '',
  preheader: '',
  senderName: '',
  senderEmail: '',
  replyTo: '',
  palette,
  contentWidth: 600,
  fontFamily: FONT_OPTIONS[0]!.value,
});

export const emptyContent = (palette: PaletteId = 'travel'): EmailContent => ({ schemaVersion: 1, settings: defaultSettings(palette), blocks: [] });

/**
 * Cleans content saved by earlier versions so it matches the current rules: color properties are
 * dropped (colors now come from the template palette) and a missing palette defaults to Travel.
 * Always run before validating or rendering stored content.
 */
export function normalizeContent<T>(input: T): T {
  if (!input || typeof input !== 'object') return input;
  const c = JSON.parse(JSON.stringify(input)) as { settings?: Record<string, unknown>; blocks?: { type?: string; props?: Record<string, unknown> }[]; variants?: unknown };
  cleanVersion(c);
  if (Array.isArray(c.variants)) for (const v of c.variants) if (v && typeof v === 'object') cleanVersion(v as { settings?: Record<string, unknown>; blocks?: { type?: string; props?: Record<string, unknown> }[] });
  return c as T;
}

function cleanVersion(c: { settings?: Record<string, unknown>; blocks?: { type?: string; props?: Record<string, unknown> }[] }): void {
  if (c.settings && typeof c.settings === 'object') {
    delete c.settings.backgroundColor;
    delete c.settings.contentBackground;
    if (!c.settings.palette) c.settings.palette = 'travel';
  }
  if (Array.isArray(c.blocks)) {
    // The header and footer are now shared brand elements: older emails that carried their own copies lose them.
    c.blocks = c.blocks.filter((b) => !(b && (b.type === 'header' || b.type === 'footer')));
    for (const b of c.blocks) {
      const legacy = b && typeof b.type === 'string' ? LEGACY_COLOR_PROPS[b.type] : undefined;
      if (legacy && b.props && typeof b.props === 'object') for (const k of legacy) delete b.props[k];
    }
  }
}

/** Dropping a block creates an independent copy: nothing is shared with the library definition. */
export function createInstance(def: BlockDefinition): BlockInstance {
  return {
    id: crypto.randomUUID(),
    type: def.type,
    sourceVersion: def.version,
    props: JSON.parse(JSON.stringify(def.defaults)) as Props,
  };
}

/** Deep copy with new block ids (used when duplicating a block or a campaign). */
export function cloneBlock(b: BlockInstance): BlockInstance {
  return { ...JSON.parse(JSON.stringify(b)), id: crypto.randomUUID() } as BlockInstance;
}

export function cloneContent(c: EmailContent, newIds = false): EmailContent {
  const copy = JSON.parse(JSON.stringify(c)) as EmailContent;
  if (newIds) {
    // the same block keeps the same new id in every version, so "copy this block to all versions" still works in the copy
    const ids = new Map<string, string>();
    const fresh = (id: string) => { let n = ids.get(id); if (!n) { n = crypto.randomUUID(); ids.set(id, n); } return n; };
    copy.blocks = copy.blocks.map((b) => ({ ...b, id: fresh(b.id) }));
    if (copy.variants) copy.variants = copy.variants.map((v) => ({ ...v, id: crypto.randomUUID(), blocks: v.blocks.map((b) => ({ ...b, id: fresh(b.id) })) }));
  }
  return copy;
}

// ---------- Validation ----------

const URL_OK = /^(https?:\/\/[^\s<>"'`\\]+|mailto:[^\s<>"'`\\]+|tel:[+0-9() -]+)$/i;
const HTTPS_OK = /^https:\/\/[^\s<>"'`\\]+$/i;
/** A picture from the asset library, stored as "asset:<id>" so emails do not depend on the web address of the app. */
export const ASSET_REF = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Every asset id referenced anywhere inside the given value (blocks, brand header/footer, ...). */
export function collectAssetIds(value: unknown, out = new Set<string>()): string[] {
  if (typeof value === 'string') {
    const m = ASSET_REF.exec(value);
    if (m) out.add(m[1]!.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const v of value) collectAssetIds(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectAssetIds(v, out);
  }
  return [...out];
}
export const PLACEHOLDER = /^\{\{\s*[a-z_][a-z0-9_]*\s*\}\}$/;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Returns an error message, or null when the value is valid for the field. */
export function checkField(f: FieldDef, v: unknown): string | null {
  const bad = (msg: string) => `${f.label}: ${msg}`;
  switch (f.kind) {
    case 'toggle':
      return typeof v === 'boolean' ? null : bad('must be on or off');
    case 'number':
      if (typeof v !== 'number' || !Number.isInteger(v)) return bad('must be a whole number');
      if (f.min !== undefined && v < f.min) return bad(`must be at least ${f.min}`);
      if (f.max !== undefined && v > f.max) return bad(`must be at most ${f.max}`);
      return null;
    case 'select':
      return typeof v === 'string' && f.options!.some((o) => o.value === v) ? null : bad('is not an allowed choice');
    default: {
      if (typeof v !== 'string') return bad('must be text');
      const max = f.kind === 'url' || f.kind === 'image' ? 2000 : (f.max ?? 200);
      if (v.length > max) return bad(`is too long (max ${max} characters)`);
      if (CONTROL.test(v)) return bad('contains invalid characters');
      if (v === '') return null;
      if (f.kind === 'url') return URL_OK.test(v) || PLACEHOLDER.test(v) || /^https?:\/\/[^\s<>"'`\\]*\{\{[^}]*\}\}/.test(v) ? null : bad('must start with https://, http://, mailto: or tel:');
      if (f.kind === 'image') return HTTPS_OK.test(v) || ASSET_REF.test(v) ? null : bad('must be a picture from the asset library or a secure https:// image address');
      if (f.key === 'senderEmail' || f.key === 'replyTo') return EMAIL.test(v) ? null : bad('is not a valid email address');
      return null;
    }
  }
}

export function checkFields(fields: FieldDef[], values: Record<string, unknown>, label: string): string | null {
  const keys = new Set(fields.map((f) => f.key));
  for (const k of Object.keys(values)) if (!keys.has(k)) return `${label}: unknown setting "${k}"`;
  for (const f of fields) {
    if (!(f.key in values)) {
      if (f.optional) continue; // saved before this field existed
      return `${label}: missing "${f.label}"`;
    }
    const err = checkField(f, values[f.key]);
    if (err) return `${label} – ${err}`;
  }
  return null;
}

const blockShape = z.object({ id: z.string().uuid(), type: z.string(), sourceVersion: z.number().int().min(1), props: z.record(z.string(), z.unknown()), showWhen: z.unknown().optional() }).strict();

const envelope = z.object({
  schemaVersion: z.literal(1),
  settings: z.record(z.string(), z.unknown()),
  blocks: z.array(blockShape).max(MAX_BLOCKS),
  variants: z.array(z.object({
    id: z.string().uuid(),
    fields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).min(1).max(10),
    values: z.array(z.string().max(200)).min(1).max(10),
    key: z.string().min(1).max(2500),
    kind: z.literal('language').optional(),
    settings: z.record(z.string(), z.unknown()),
    blocks: z.array(blockShape).max(MAX_BLOCKS),
  }).strict()).max(MAX_VARIANTS).optional(),
  versioning: z.object({ mode: z.enum(['conditions', 'copies']), languageField: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional(), routes: z.record(z.string().max(2000), z.string().max(40)).optional() }).strict().optional(),
}).strict();

export type ValidationResult = { ok: true; content: EmailContent } | { ok: false; error: string };

/** Full structural and value validation. The server runs this on every save; nothing unvalidated is stored or rendered. */
export function validateContent(input: unknown): ValidationResult {
  const parsed = envelope.safeParse(normalizeContent(input));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid email content.' };
  const c = parsed.data;

  const { palette } = c.settings;
  if (typeof palette !== 'string' || !(PALETTE_IDS as readonly string[]).includes(palette)) {
    return { ok: false, error: 'Email settings: unknown template colors' };
  }
  const main = checkVersion(c.settings, c.blocks, palette, '');
  if (main) return { ok: false, error: main };

  const variants = c.variants ?? [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const v of variants) {
    const name = `${v.kind === 'language' ? 'Language default' : 'Version for segment'} ${v.values.map((x) => x || 'blank').join('-')}: `;
    if (ids.has(v.id)) return { ok: false, error: `${name}duplicate id` };
    ids.add(v.id);
    const uniq = `${v.kind ?? 'segment'}|${v.key}`;
    if (keys.has(uniq)) return { ok: false, error: `${name}there are two versions for the same segment` };
    keys.add(uniq);
    if (v.fields.length !== v.values.length) return { ok: false, error: `${name}the values do not match the fields` };
    if (v.settings.palette !== palette) return { ok: false, error: `${name}the template colors must be the same as the Default version` };
    const err = checkVersion(v.settings, v.blocks, palette, name);
    if (err) return { ok: false, error: err };
  }
  const out = { ...c } as unknown as EmailContent;
  if (!variants.length) delete out.variants; // an email without versions is stored exactly as before
  return { ok: true, content: out };
}

/** Checks the settings and blocks of one version (the Default or a segment's). Returns an error message or null. */
function checkVersion(settings: Record<string, unknown>, blocks: { id: string; type: string; props: Record<string, unknown>; showWhen?: unknown }[], palette: string, prefix: string): string | null {
  const { palette: _p, ...otherSettings } = settings;
  const settingsErr = checkFields(SETTINGS_FIELDS, otherSettings, `${prefix}Email settings`);
  if (settingsErr) return settingsErr;
  const seen = new Set<string>();
  for (const [i, b] of blocks.entries()) {
    if (seen.has(b.id)) return `${prefix}Block ${i + 1}: duplicate id`;
    seen.add(b.id);
    if (!(BLOCK_TYPES as readonly string[]).includes(b.type)) return `${prefix}Block ${i + 1}: unknown block type "${b.type}"`;
    const def = blockDefinition(b.type)!;
    if (b.showWhen !== undefined) {
      const ce = validateCondition(b.showWhen);
      if (ce) return `${prefix}Block ${i + 1} (${def.label}): ${ce}`;
    }
    if (def.category !== 'shared' && def.category !== palette) {
      return `${prefix}Block ${i + 1} (${def.label}) belongs to the ${def.category} template and cannot be used in this email.`;
    }
    const err = checkFields(def.fields, b.props, `${prefix}Block ${i + 1} (${def.label})`);
    if (err) return err;
  }
  return null;
}

/** Stable JSON (sorted keys) so the same content always has the same hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    // Like JSON.stringify: keys whose value is undefined do not exist.
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
