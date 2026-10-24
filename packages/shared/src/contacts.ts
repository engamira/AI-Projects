// Audience: contacts, CSV import, custom fields and segments. Shared so the server (which decides) and the screen (which explains) agree.

/** The contact limit while the app is being tested. An Admin can raise it (up to the ceiling) in Audience settings. */
export const DEFAULT_CONTACT_LIMIT = 10;
/** The most an Admin can set the limit to for now. */
export const CONTACT_LIMIT_CEILING = 1000;
export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_ROWS = 1000;
export const MAX_CUSTOM_FIELDS = 20;

export type ContactFieldType = 'text' | 'number' | 'date' | 'boolean';

export type ContactField = {
  key: string;
  label: string;
  type: ContactFieldType;
  required?: boolean;
  /** Column names that are matched to this field automatically (compared ignoring capitals, spaces and punctuation). */
  synonyms: string[];
  max?: number;
  /** True for fields an Admin or Builder added themselves (stored with each contact). */
  custom?: boolean;
};

export type StandardFieldKey =
  | 'email' | 'first_name' | 'last_name' | 'company' | 'country' | 'city' | 'language' | 'customer_since' | 'orders' | 'vip' | 'marketing_permission';

/** The built-in fields. */
export const CONTACT_FIELDS: ContactField[] = [
  { key: 'email', label: 'Email address', type: 'text', required: true, synonyms: ['email', 'emailaddress', 'mail', 'e-mail'], max: 254 },
  { key: 'first_name', label: 'First name', type: 'text', synonyms: ['firstname', 'first', 'givenname', 'forename'], max: 100 },
  { key: 'last_name', label: 'Last name', type: 'text', synonyms: ['lastname', 'last', 'surname', 'familyname'], max: 100 },
  { key: 'company', label: 'Company', type: 'text', synonyms: ['company', 'organisation', 'organization', 'employer'], max: 150 },
  { key: 'country', label: 'Country', type: 'text', synonyms: ['country', 'countrycode', 'countryofresidence', 'residence'], max: 100 },
  { key: 'city', label: 'City', type: 'text', synonyms: ['city', 'town'], max: 100 },
  { key: 'language', label: 'Language', type: 'text', synonyms: ['language', 'lang', 'locale'], max: 50 },
  { key: 'customer_since', label: 'Customer since (date)', type: 'date', synonyms: ['customersince', 'since', 'joined', 'signupdate', 'createdat'] },
  { key: 'orders', label: 'Number of orders', type: 'number', synonyms: ['orders', 'ordercount', 'numberoforders', 'purchases'] },
  { key: 'vip', label: 'VIP (yes/no)', type: 'boolean', synonyms: ['vip', 'isvip'] },
  { key: 'marketing_permission', label: 'Marketing permission (active/inactive)', type: 'boolean', synonyms: ['marketingpermission', 'permission', 'optin', 'consent', 'subscribed', 'marketing'] },
];
const STANDARD_KEYS = new Set(CONTACT_FIELDS.map((f) => f.key));
export const isStandardField = (key: string): boolean => STANDARD_KEYS.has(key);

/** A field someone added (for example "Country of residence" or "Interest"). */
export type CustomFieldDto = { key: string; label: string; type: ContactFieldType };

export const CUSTOM_FIELD_LABEL_MAX = 40;

/** A safe internal name for a custom field, made from its label. Never clashes with a built-in field. */
export function customFieldKey(label: string): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  const key = /^[a-z]/.test(base) ? base : `f_${base}`;
  return STANDARD_KEYS.has(key) || key === 'f_' ? `${key}_2` : key;
}

export const asField = (c: CustomFieldDto): ContactField => ({ key: c.key, label: c.label, type: c.type, synonyms: [c.label, c.key], max: 200, custom: true });

/** The identity of a contact: trimmed, lowercase email. */
export const emailKey = (email: string): string => email.trim().toLowerCase();

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
export const isValidEmail = (email: string): boolean => email.length <= 254 && EMAIL.test(email) && !email.includes('..');

export type ParsedValue = string | number | boolean | null;

/** Turns one typed-in cell into a value of the field's type. Empty means "no value". */
export function parseCell(field: Pick<ContactField, 'label' | 'type' | 'max'>, raw: string): { value: ParsedValue } | { error: string } {
  const v = raw.trim();
  if (v === '') return { value: null };
  switch (field.type) {
    case 'text':
      if (field.max && v.length > field.max) return { error: `${field.label} is longer than ${field.max} characters` };
      return { value: v };
    case 'number': {
      if (!/^-?\d+$/.test(v)) return { error: `${field.label} must be a whole number (got "${v.slice(0, 30)}")` };
      const n = Number(v);
      if (n < 0 || n > 1_000_000) return { error: `${field.label} must be between 0 and 1,000,000` };
      return { value: n };
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!m) return { error: `${field.label} must be a date written as YYYY-MM-DD (got "${v.slice(0, 30)}")` };
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return { error: `${field.label} is not a real date (${v})` };
      return { value: v };
    }
    case 'boolean': {
      const l = v.toLowerCase();
      if (['yes', 'y', 'true', '1', 'active', 'subscribed'].includes(l)) return { value: true };
      if (['no', 'n', 'false', '0', 'inactive', 'unsubscribed'].includes(l)) return { value: false };
      return { error: `${field.label} must be yes or no (got "${v.slice(0, 30)}")` };
    }
  }
}

export type ContactDto = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  country: string | null;
  city: string | null;
  language: string | null;
  customerSince: string | null;
  orders: number | null;
  vip: boolean | null;
  /** Values of the custom fields, by field key. */
  custom: Record<string, string | number | boolean | null>;
  /** Permission to send marketing email. A person who has not given it (or withdrew it) is never sent to. */
  marketingActive: boolean;
  unsubscribedAt: string | null;
  suppressedReason: 'bounce' | 'complaint' | 'manual' | null;
  createdAt: string;
  /** Why this contact would be left out of a send, or null when they are eligible. */
  excludedReason: ExclusionReason | null;
};

/** The value of any field (built-in or custom) for a contact, as shown in tables and used to segment. */
export function fieldValue(c: ContactDto, key: string): string | number | boolean | null {
  switch (key) {
    case 'email': return c.email;
    case 'first_name': return c.firstName;
    case 'last_name': return c.lastName;
    case 'company': return c.company;
    case 'country': return c.country;
    case 'city': return c.city;
    case 'language': return c.language;
    case 'customer_since': return c.customerSince;
    case 'orders': return c.orders;
    case 'vip': return c.vip;
    case 'marketing_permission': return c.marketingActive;
    default: return c.custom[key] ?? null;
  }
}

export type ExclusionReason = 'no_permission' | 'unsubscribed' | 'suppressed';
export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  no_permission: 'No marketing permission',
  unsubscribed: 'Unsubscribed',
  suppressed: 'Suppressed (bounce, complaint or manual)',
};

/** Eligible = may be sent marketing email. (Whether they match a segment is a separate question.) */
export function exclusionReason(c: { marketingActive: boolean; unsubscribedAt: string | null; suppressedReason: string | null }): ExclusionReason | null {
  if (c.unsubscribedAt) return 'unsubscribed';
  if (c.suppressedReason) return 'suppressed';
  if (!c.marketingActive) return 'no_permission';
  return null;
}

export type ContactsResponse = {
  contacts: ContactDto[];
  /** The current limit on stored contacts. */
  max: number;
  ceiling: number;
  /** Every field a contact can have: built-in first, then custom. */
  fields: ContactField[];
};

export type AudienceSettingsRequest = { contactLimit: number };

// ---------- Segments ----------
/** One group of contacts that share the same values in the chosen fields (for example Country = UAE and Language = en). */
export type SegmentDto = {
  /** Stable text identifying the combination (the values joined), used to select it. */
  id: string;
  /** The value of each chosen field, in the order of the chosen fields. null = blank. */
  values: (string | number | boolean | null)[];
  label: string;
  total: number;
  /** Of the total, how many may be sent marketing email. */
  eligible: number;
  /** A few addresses from this segment (for orientation and for testing). */
  sampleEmails: string[];
};

export type SegmentsResponse = { fields: ContactField[]; segments: SegmentDto[]; totalContacts: number; totalEligible: number };

export const BLANK_LABEL = '(blank)';

/** Text for a value of a segment field. */
export function valueLabel(v: string | number | boolean | null): string {
  if (v === null || v === '') return BLANK_LABEL;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/** Splits contacts into segments by the chosen fields. Blank values form their own segment. */
export function segmentContacts(contacts: ContactDto[], fields: ContactField[]): SegmentDto[] {
  const groups = new Map<string, SegmentDto>();
  for (const c of contacts) {
    const values = fields.map((f) => fieldValue(c, f.key));
    const id = JSON.stringify(values.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v)));
    let g = groups.get(id);
    if (!g) {
      g = { id, values, label: fields.map((f, i) => `${f.label}: ${valueLabel(values[i]!)}`).join(' · '), total: 0, eligible: 0, sampleEmails: [] };
      groups.set(id, g);
    }
    g.total++;
    if (!c.excludedReason) g.eligible++;
    if (g.sampleEmails.length < 3) g.sampleEmails.push(c.email);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// ---------- Import ----------
export type NewFieldRequest = { column: string; label: string; type: ContactFieldType };

export type ImportRequest = {
  csv: string;
  /** field key -> the CSV column name chosen for it (omitted or empty = not imported) */
  mapping?: Record<string, string>;
  /** Columns to bring in as new custom fields (their values are then imported like any other field). */
  newFields?: NewFieldRequest[];
  /** Update contacts that already exist (blank cells never erase anything). Default: skip them. */
  updateExisting?: boolean;
  filename?: string;
};

export type ImportRowIssue = { row: number; email: string | null; message: string };

export type ImportPreview = {
  columns: string[];
  mapping: Record<string, string>;
  /** The fields available for mapping: built-in, existing custom, and the new ones requested. */
  fields: ContactField[];
  totalRows: number;
  /** New contacts that fit under the limit and would be added. */
  willAdd: number;
  /** Rows for contacts already stored (updated only when "update existing" is on; they never use capacity). */
  existing: number;
  willUpdate: number;
  /** Later rows with an email that appeared earlier in the same file. */
  duplicatesInFile: number;
  /** New contacts that are valid but would go over the limit, so would not be saved. */
  overLimit: number;
  invalid: number;
  issues: ImportRowIssue[];
  capacity: { max: number; stored: number; free: number };
  sample: { email: string; firstName: string | null; lastName: string | null; status: 'add' | 'update' | 'skip_existing' | 'over_limit' | 'duplicate' | 'invalid' }[];
};

export type ImportResult = ImportPreview & { batchId: string; added: number; updated: number };

// ---------- A campaign's audience and test audience ----------
/** The short name of a segment, made from its values in the order of the chosen fields: UAE-en, EG-ar, ... */
export function segmentCode(values: (string | number | boolean | null)[]): string {
  return values
    .map((v) => (v === null || v === '' ? 'blank' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v).trim().replace(/\s+/g, ' ')))
    .join('-');
}

export type CampaignAudienceDto = { fields: string[] };

/** A made-up contact generated to test an email for one segment. Never part of the real contact list and never mailed. */
export type TestContactDto = { id: string; code: string; email: string; data: Record<string, string | number | boolean | null> };

export type TestAudienceRequest = {
  /** "sheet": one test contact for each segment that exists in your contact list. "all": every combination of the values (from your list plus the extra values below). */
  mode: 'sheet' | 'all';
  /** Extra values to include for a field (field key -> values), for combinations your list does not have yet. */
  extraValues?: Record<string, string[]>;
};
export const TEST_AUDIENCE_MAX = 60;

export type PreviewRecipient = { id: string; label: string };
export type PreviewRecipientGroup = { title: string; recipients: PreviewRecipient[] };
export type PreviewRecipientsResponse = { segmentFields: ContactField[]; groups: PreviewRecipientGroup[] };
