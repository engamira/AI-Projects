// Personalization: {{first_name | fallback: "there"}} placeholders, with a mandatory fallback.
// Used by preview, QA and sending alike, so what you preview is what a recipient gets.

export const PERSONAL_FIELDS = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'company', label: 'Company' },
  { key: 'email', label: 'Email address' },
] as const;
export type PersonalField = (typeof PERSONAL_FIELDS)[number]['key'];
/** Values for one recipient. A missing or empty value means the fallback is used. */
export type Recipient = Partial<Record<PersonalField, string | null>>;

const FIELD_KEYS = new Set<string>(PERSONAL_FIELDS.map((f) => f.key));
const Q = '(?:"|&quot;)'; // the same text is also seen after HTML escaping
const TOKEN = new RegExp(String.raw`\{\{\s*([A-Za-z_]\w*)\s*(?:\|\s*fallback\s*:\s*${Q}((?:(?!${Q}).)*)${Q}\s*)?\}\}`, 'g');

export type PlaceholderIssue = {
  kind: 'missing_fallback' | 'unknown_field' | 'malformed';
  /** The text as typed, for showing to the person who must fix it. */
  text: string;
  message: string;
};

/** Fields that always have a value for every recipient, so no fallback is needed. */
const ALWAYS_PRESENT = new Set<string>(['email']);

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

/** Finds placeholders that would reach a recipient broken: unknown field, no fallback, or half-typed braces. */
export function findPlaceholderIssues(value: unknown): PlaceholderIssue[] {
  const issues: PlaceholderIssue[] = [];
  const seen = new Set<string>();
  const add = (i: PlaceholderIssue) => { const k = i.kind + i.text; if (!seen.has(k)) { seen.add(k); issues.push(i); } };
  for (const str of allStrings(value)) {
    for (const m of str.matchAll(TOKEN)) {
      const [text, field, fallback] = m;
      if (!FIELD_KEYS.has(field!)) {
        add({ kind: 'unknown_field', text, message: `"${field}" is not a known field. Use one of: ${PERSONAL_FIELDS.map((f) => f.key).join(', ')}.` });
      } else if (!ALWAYS_PRESENT.has(field!) && (fallback === undefined || fallback.trim() === '')) {
        add({ kind: 'missing_fallback', text, message: `Add a fallback, for example {{${field} | fallback: "there"}}, so nobody sees an empty gap.` });
      }
    }
    const rest = str.replace(TOKEN, '');
    if (/\{\{|\}\}/.test(rest)) {
      const at = rest.search(/\{\{|\}\}/);
      add({ kind: 'malformed', text: rest.slice(Math.max(0, at - 10), at + 30).trim(), message: 'Curly braces that do not form a complete placeholder. Format: {{first_name | fallback: "there"}}.' });
    }
  }
  return issues;
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Replaces placeholders for one recipient. `html: true` for HTML (values are escaped; fallbacks were already
 * escaped when the email was rendered). Anything that cannot be resolved is left as typed so it stays visible.
 */
export function personalize(source: string, recipient: Recipient | null, opts: { html: boolean }): string {
  return source.replace(TOKEN, (whole, field: string, fallback: string | undefined) => {
    if (!FIELD_KEYS.has(field)) return whole;
    const v = recipient?.[field as PersonalField];
    if (typeof v === 'string' && v.trim() !== '') return opts.html ? escHtml(v.trim()) : v.trim();
    if (fallback !== undefined && fallback.trim() !== '') return fallback;
    return whole;
  });
}

/** Built-in example recipients for "Preview as...". Real contacts arrive with the audience feature. */
export const SAMPLE_RECIPIENTS = [
  { id: 'sample', label: 'Sample contact (Alex Morgan)', recipient: { first_name: 'Alex', last_name: 'Morgan', company: 'Example Co', email: 'alex@example.com' } as Recipient },
  { id: 'empty', label: 'Contact with no details (shows fallbacks)', recipient: { email: 'someone@example.com' } as Recipient },
  { id: 'raw', label: 'Show placeholders as typed', recipient: null },
] as const;
export type SampleId = (typeof SAMPLE_RECIPIENTS)[number]['id'];
