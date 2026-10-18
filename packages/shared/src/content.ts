import { z } from 'zod';
import { BLOCK_TYPES, LEGACY_COLOR_PROPS, blockDefinition, type BlockDefinition, type BlockType, type FieldDef, type Props } from './blocks.js';
import { PALETTE_IDS, type PaletteId } from './palettes.js';

// ---------- Email content: what is stored for every campaign draft and revision ----------

export type BlockInstance = {
  id: string; // unique within the email
  type: BlockType;
  sourceVersion: number; // version of the library definition it was created from
  props: Props; // this instance's own copy: edits never reach the library
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

export type EmailContent = {
  schemaVersion: 1;
  settings: EmailSettings;
  blocks: BlockInstance[];
};

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
  const c = JSON.parse(JSON.stringify(input)) as { settings?: Record<string, unknown>; blocks?: { type?: string; props?: Record<string, unknown> }[] };
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
  return c as T;
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
  if (newIds) copy.blocks = copy.blocks.map((b) => ({ ...b, id: crypto.randomUUID() }));
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

const envelope = z.object({
  schemaVersion: z.literal(1),
  settings: z.record(z.string(), z.unknown()),
  blocks: z.array(z.object({ id: z.string().uuid(), type: z.string(), sourceVersion: z.number().int().min(1), props: z.record(z.string(), z.unknown()) }).strict()).max(MAX_BLOCKS),
}).strict();

export type ValidationResult = { ok: true; content: EmailContent } | { ok: false; error: string };

/** Full structural and value validation. The server runs this on every save; nothing unvalidated is stored or rendered. */
export function validateContent(input: unknown): ValidationResult {
  const parsed = envelope.safeParse(normalizeContent(input));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid email content.' };
  const c = parsed.data;

  const { palette, ...otherSettings } = c.settings;
  if (typeof palette !== 'string' || !(PALETTE_IDS as readonly string[]).includes(palette)) {
    return { ok: false, error: 'Email settings: unknown template colors' };
  }
  const settingsErr = checkFields(SETTINGS_FIELDS, otherSettings, 'Email settings');
  if (settingsErr) return { ok: false, error: settingsErr };

  const seen = new Set<string>();
  for (const [i, b] of c.blocks.entries()) {
    if (seen.has(b.id)) return { ok: false, error: `Block ${i + 1}: duplicate id` };
    seen.add(b.id);
    if (!(BLOCK_TYPES as readonly string[]).includes(b.type)) return { ok: false, error: `Block ${i + 1}: unknown block type "${b.type}"` };
    const def = blockDefinition(b.type)!;
    if (def.category !== 'shared' && def.category !== palette) {
      return { ok: false, error: `Block ${i + 1} (${def.label}) belongs to the ${def.category} template and cannot be used in this email.` };
    }
    const err = checkFields(def.fields, b.props, `Block ${i + 1} (${def.label})`);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, content: c as unknown as EmailContent };
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
