// Audience: contacts, CSV import and their rules. Shared so the server (which decides) and the screen (which explains) agree.

/** The most contacts the app will ever store (a hard rule of this version). */
export const MAX_CONTACTS = 10;
export const IMPORT_MAX_BYTES = 100 * 1024;
export const IMPORT_MAX_ROWS = 500;

export type ContactFieldType = 'text' | 'number' | 'date' | 'boolean';

export type ContactField = {
  key: ContactFieldKey;
  label: string;
  type: ContactFieldType;
  required?: boolean;
  /** Column names (lowercase, letters and digits only) that are matched to this field automatically. */
  synonyms: string[];
  max?: number;
};

export type ContactFieldKey =
  | 'email' | 'first_name' | 'last_name' | 'company' | 'country' | 'city' | 'language' | 'customer_since' | 'orders' | 'vip' | 'marketing_permission';

export const CONTACT_FIELDS: ContactField[] = [
  { key: 'email', label: 'Email address', type: 'text', required: true, synonyms: ['email', 'emailaddress', 'mail', 'e-mail'], max: 254 },
  { key: 'first_name', label: 'First name', type: 'text', synonyms: ['firstname', 'first', 'givenname', 'forename'], max: 100 },
  { key: 'last_name', label: 'Last name', type: 'text', synonyms: ['lastname', 'last', 'surname', 'familyname'], max: 100 },
  { key: 'company', label: 'Company', type: 'text', synonyms: ['company', 'organisation', 'organization', 'employer'], max: 150 },
  { key: 'country', label: 'Country', type: 'text', synonyms: ['country', 'countrycode'], max: 100 },
  { key: 'city', label: 'City', type: 'text', synonyms: ['city', 'town'], max: 100 },
  { key: 'language', label: 'Language', type: 'text', synonyms: ['language', 'lang', 'locale'], max: 50 },
  { key: 'customer_since', label: 'Customer since (date)', type: 'date', synonyms: ['customersince', 'since', 'joined', 'signupdate', 'createdat'] },
  { key: 'orders', label: 'Number of orders', type: 'number', synonyms: ['orders', 'ordercount', 'numberoforders', 'purchases'] },
  { key: 'vip', label: 'VIP (yes/no)', type: 'boolean', synonyms: ['vip', 'isvip'] },
  { key: 'marketing_permission', label: 'Marketing permission (active/inactive)', type: 'boolean', synonyms: ['marketingpermission', 'permission', 'optin', 'consent', 'subscribed', 'marketing'] },
];

export const contactField = (key: string): ContactField | undefined => CONTACT_FIELDS.find((f) => f.key === key);

/** The identity of a contact: trimmed, lowercase email. */
export const emailKey = (email: string): string => email.trim().toLowerCase();

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
export const isValidEmail = (email: string): boolean => email.length <= 254 && EMAIL.test(email) && !email.includes('..');

export type ParsedValue = string | number | boolean | null;

/** Turns one typed-in cell into a value of the field's type. Empty means "no value". */
export function parseCell(field: ContactField, raw: string): { value: ParsedValue } | { error: string } {
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
  /** Permission to send marketing email. A person who has not given it (or withdrew it) is never sent to. */
  marketingActive: boolean;
  unsubscribedAt: string | null;
  suppressedReason: 'bounce' | 'complaint' | 'manual' | null;
  createdAt: string;
  /** Why this contact would be left out of a send, or null when they are eligible. */
  excludedReason: ExclusionReason | null;
};

export type ExclusionReason = 'no_permission' | 'unsubscribed' | 'suppressed';
export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  no_permission: 'No marketing permission',
  unsubscribed: 'Unsubscribed',
  suppressed: 'Suppressed (bounce, complaint or manual)',
};

/** Eligible = may be sent marketing email. (Whether they match a filter is a separate question.) */
export function exclusionReason(c: { marketingActive: boolean; unsubscribedAt: string | null; suppressedReason: string | null }): ExclusionReason | null {
  if (c.unsubscribedAt) return 'unsubscribed';
  if (c.suppressedReason) return 'suppressed';
  if (!c.marketingActive) return 'no_permission';
  return null;
}

export type ContactsResponse = { contacts: ContactDto[]; max: number };

// ---------- Import ----------
export type ImportRequest = {
  csv: string;
  /** field key -> the CSV column name chosen for it (omitted or empty = not imported) */
  mapping?: Record<string, string>;
  /** Update contacts that already exist (blank cells never erase anything). Default: skip them. */
  updateExisting?: boolean;
  filename?: string;
};

export type ImportRowIssue = { row: number; email: string | null; message: string };

export type ImportPreview = {
  columns: string[];
  mapping: Record<string, string>;
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
