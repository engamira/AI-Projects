import Papa from 'papaparse';
import {
  CONTACT_FIELDS, CONTACT_LIMIT_CEILING, CUSTOM_FIELD_LABEL_MAX, DEFAULT_CONTACT_LIMIT, IMPORT_MAX_ROWS, MAX_CUSTOM_FIELDS,
  asField, customFieldKey, emailKey, exclusionReason, isStandardField, isValidEmail, parseCell, segmentContacts,
  type ContactDto, type ContactField, type ContactFieldType, type CustomFieldDto, type ImportPreview, type ImportRowIssue, type NewFieldRequest, type ParsedValue, type SegmentsResponse,
} from '@cl/shared';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';

// Contacts, the CSV import, custom fields and segments. The import is a two-step flow: analyse (nothing is saved) and
// commit (saves what the analysis said would fit). Both run the very same analysis, so preview and result cannot disagree.

/** Built-in contact property key -> database column. */
const COLUMN: Record<string, string> = {
  email: 'email', first_name: 'first_name', last_name: 'last_name', company: 'company', country: 'country', city: 'city',
  language: 'language', customer_since: 'customer_since', orders: 'orders', vip: 'vip', marketing_permission: 'marketing_active',
};

type Row = {
  id: string; email: string; first_name: string | null; last_name: string | null; company: string | null; country: string | null; city: string | null;
  language: string | null; customer_since: string | null; orders: number | null; vip: boolean | null; marketing_active: boolean; custom: Record<string, string | number | boolean | null>;
  unsubscribed_at: Date | null; suppressed_reason: 'bounce' | 'complaint' | 'manual' | null; created_at: Date;
};

const SELECT = `id, email, first_name, last_name, company, country, city, language, to_char(customer_since, 'YYYY-MM-DD') AS customer_since, orders, vip,
                marketing_active, custom, unsubscribed_at, suppressed_reason, created_at`;

export function toContactDto(r: Row): ContactDto {
  const dto = {
    id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, company: r.company, country: r.country, city: r.city, language: r.language,
    customerSince: r.customer_since, orders: r.orders, vip: r.vip, custom: r.custom ?? {}, marketingActive: r.marketing_active,
    unsubscribedAt: r.unsubscribed_at?.toISOString() ?? null, suppressedReason: r.suppressed_reason, createdAt: r.created_at.toISOString(),
  };
  return { ...dto, excludedReason: exclusionReason(dto) };
}

export async function listContacts(q: Queryable): Promise<ContactDto[]> {
  const r = await q.query<Row>(`SELECT ${SELECT} FROM contact WHERE workspace_id = $1 ORDER BY created_at, email_key`, [DEFAULT_WORKSPACE_ID]);
  return r.rows.map(toContactDto);
}

export async function getContact(q: Queryable, id: string): Promise<ContactDto | null> {
  const r = await q.query<Row>(`SELECT ${SELECT} FROM contact WHERE id = $1 AND workspace_id = $2`, [id, DEFAULT_WORKSPACE_ID]);
  return r.rows[0] ? toContactDto(r.rows[0]) : null;
}

export const countContacts = async (q: Queryable): Promise<number> =>
  Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM contact WHERE workspace_id = $1', [DEFAULT_WORKSPACE_ID])).rows[0]!.n);

// ---------- Limit setting ----------
export async function getContactLimit(q: Queryable): Promise<number> {
  const r = await q.query<{ contact_limit: number }>('SELECT contact_limit FROM audience_setting WHERE workspace_id = $1', [DEFAULT_WORKSPACE_ID]);
  return r.rows[0]?.contact_limit ?? DEFAULT_CONTACT_LIMIT;
}

export async function setContactLimit(q: Queryable, limit: number, userId: string): Promise<{ limit: number } | { error: string }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > CONTACT_LIMIT_CEILING) return { error: `The limit must be a whole number from 1 to ${CONTACT_LIMIT_CEILING}.` };
  await q.query("SELECT pg_advisory_xact_lock(hashtext('contact_cap:' || $1))", [DEFAULT_WORKSPACE_ID]);
  const stored = await countContacts(q);
  if (limit < stored) return { error: `You have ${stored} contacts stored. Delete some first, or choose ${stored} or more.` };
  await q.query(
    `INSERT INTO audience_setting (workspace_id, contact_limit, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id) DO UPDATE SET contact_limit = EXCLUDED.contact_limit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [DEFAULT_WORKSPACE_ID, limit, userId],
  );
  return { limit };
}

// ---------- Custom fields ----------
export async function listCustomFields(q: Queryable): Promise<CustomFieldDto[]> {
  const r = await q.query<CustomFieldDto>('SELECT key, label, type FROM contact_field WHERE workspace_id = $1 ORDER BY created_at, key', [DEFAULT_WORKSPACE_ID]);
  return r.rows;
}

/** Every field a contact can have: built-in first, then custom. */
export async function allFields(q: Queryable): Promise<ContactField[]> {
  return [...CONTACT_FIELDS, ...(await listCustomFields(q)).map(asField)];
}

const TYPES: ContactFieldType[] = ['text', 'number', 'date', 'boolean'];

export async function addCustomField(q: Queryable, labelIn: string, type: string, userId: string): Promise<{ field: CustomFieldDto } | { error: string; status: number }> {
  const label = labelIn.trim().replace(/\s+/g, ' ');
  if (!label) return { error: 'Give the field a name.', status: 400 };
  if (label.length > CUSTOM_FIELD_LABEL_MAX) return { error: `A field name can have at most ${CUSTOM_FIELD_LABEL_MAX} characters.`, status: 400 };
  if (!TYPES.includes(type as ContactFieldType)) return { error: 'Choose what kind of values the field holds.', status: 400 };
  const existing = await listCustomFields(q);
  if (existing.length >= MAX_CUSTOM_FIELDS) return { error: `You can add at most ${MAX_CUSTOM_FIELDS} custom fields.`, status: 409 };
  const key = customFieldKey(label);
  const clash = CONTACT_FIELDS.some((f) => f.label.toLowerCase() === label.toLowerCase()) || existing.some((f) => f.key === key || f.label.toLowerCase() === label.toLowerCase());
  if (clash) return { error: `A field called "${label}" already exists.`, status: 409 };
  await q.query('INSERT INTO contact_field (workspace_id, key, label, type, created_by) VALUES ($1, $2, $3, $4, $5)', [DEFAULT_WORKSPACE_ID, key, label, type, userId]);
  return { field: { key, label, type: type as ContactFieldType } };
}

/** Removing a field also removes its values from every contact. */
export async function removeCustomField(q: Queryable, key: string): Promise<CustomFieldDto | null> {
  const r = await q.query<CustomFieldDto>('DELETE FROM contact_field WHERE workspace_id = $1 AND key = $2 RETURNING key, label, type', [DEFAULT_WORKSPACE_ID, key]);
  if (!r.rows[0]) return null;
  await q.query('UPDATE contact SET custom = custom - $2 WHERE workspace_id = $1 AND custom ? $2', [DEFAULT_WORKSPACE_ID, key]);
  return r.rows[0];
}

// ---------- Segments ----------
/** Splits the stored contacts by the chosen fields (built-in or custom). */
export async function segments(q: Queryable, keys: string[]): Promise<SegmentsResponse | { error: string }> {
  const fields = await allFields(q);
  const chosen: ContactField[] = [];
  for (const k of keys) {
    const f = fields.find((x) => x.key === k);
    if (!f) return { error: `There is no field called "${k}".` };
    if (!chosen.includes(f)) chosen.push(f);
  }
  if (chosen.length === 0) return { error: 'Choose at least one field to segment by.' };
  if (chosen.length > 5) return { error: 'Choose at most 5 fields.' };
  const contacts = await listContacts(q);
  return {
    fields: chosen,
    segments: segmentContacts(contacts, chosen),
    totalContacts: contacts.length,
    totalEligible: contacts.filter((c) => !c.excludedReason).length,
  };
}

// ---------- Reading the file ----------
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export type ParsedCsv = { columns: string[]; rows: Record<string, string>[] } | { error: string };

export function parseCsv(csv: string): ParsedCsv {
  const text = csv.replace(/^﻿/, '');
  if (!text.trim()) return { error: 'The file is empty.' };
  const res = Papa.parse<Record<string, string>>(text, {
    header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim(), delimitersToGuess: [',', ';', '\t', '|'],
  });
  const fatal = res.errors.find((e) => e.type === 'Quotes' || e.type === 'Delimiter');
  if (fatal && res.data.length === 0) return { error: `This file could not be read as a table (${fatal.message}). Save it as a CSV and try again.` };
  const columns = (res.meta.fields ?? []).filter((c) => c !== '');
  if (columns.length === 0) return { error: 'No column names were found in the first row.' };
  if (new Set(columns.map(norm)).size !== columns.length) return { error: 'Two columns have the same name. Rename one of them and try again.' };
  if (res.data.length === 0) return { error: 'The file has column names but no rows.' };
  if (res.data.length > IMPORT_MAX_ROWS) return { error: `The file has ${res.data.length} rows. At most ${IMPORT_MAX_ROWS} rows can be imported at once.` };
  return { columns, rows: res.data };
}

/** Matches each field to a column by name ("First Name", "first_name" and "firstname" all work). */
export function autoMapping(columns: string[], fields: ContactField[] = CONTACT_FIELDS): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (f: ContactField, hit: string | undefined) => { if (hit && !(f.key in out) && !Object.values(out).includes(hit)) out[f.key] = hit; };
  // first an exact match on the field's own name (so a custom "Country of residence" gets its own column), then known alternative names
  for (const f of fields) take(f, columns.find((c) => norm(c) === norm(f.key) || norm(c) === norm(f.label)));
  for (const f of fields) take(f, columns.find((c) => f.synonyms.some((s) => norm(c) === norm(s))));
  return out;
}

// ---------- The analysis ----------
type Action = 'add' | 'update' | 'skip_existing' | 'over_limit' | 'duplicate' | 'invalid';
type Planned = { row: number; key: string; email: string; values: Record<string, ParsedValue>; action: Action };

export type Analysis = { preview: ImportPreview; planned: Planned[]; newFields: CustomFieldDto[] };

/** Turns requested new fields into custom field definitions, skipping any that already exist. */
function resolveNewFields(requested: NewFieldRequest[] | undefined, existing: CustomFieldDto[], columns: string[]): { add: CustomFieldDto[]; map: Record<string, string> } | { error: string } {
  const add: CustomFieldDto[] = [];
  const map: Record<string, string> = {};
  for (const n of requested ?? []) {
    if (!columns.includes(n.column)) continue;
    const label = n.label.trim().replace(/\s+/g, ' ');
    if (!label || label.length > CUSTOM_FIELD_LABEL_MAX) return { error: `A new field name must be 1 to ${CUSTOM_FIELD_LABEL_MAX} characters.` };
    if (!TYPES.includes(n.type)) return { error: 'Choose what kind of values each new field holds.' };
    const key = customFieldKey(label);
    const known = existing.find((f) => f.key === key) ?? add.find((f) => f.key === key);
    if (!known) {
      if (CONTACT_FIELDS.some((f) => f.label.toLowerCase() === label.toLowerCase())) return { error: `"${label}" is already a built-in field. Choose that field for the column instead.` };
      add.push({ key, label, type: n.type });
    }
    map[key] = n.column;
  }
  if (existing.length + add.length > MAX_CUSTOM_FIELDS) return { error: `You can have at most ${MAX_CUSTOM_FIELDS} custom fields.` };
  return { add, map };
}

export async function analyse(
  q: Queryable,
  csv: string,
  mappingIn: Record<string, string> | undefined,
  updateExisting: boolean,
  newFieldsIn?: NewFieldRequest[],
): Promise<Analysis | { error: string }> {
  const parsed = parseCsv(csv);
  if ('error' in parsed) return parsed;
  const { columns, rows } = parsed;

  const existingCustom = await listCustomFields(q);
  const nf = resolveNewFields(newFieldsIn, existingCustom, columns);
  if ('error' in nf) return nf;
  const fields: ContactField[] = [...CONTACT_FIELDS, ...existingCustom.map(asField), ...nf.add.map(asField)];

  // keep only mappings that point to a real column and a known field; never the same column twice
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  // columns the person asked to bring in as new fields win; everything else is matched by name (or uses the mapping they chose)
  const requested = new Set(Object.values(nf.map));
  const rest = mappingIn ?? autoMapping(columns.filter((c) => !requested.has(c)), fields);
  const wanted = { ...rest, ...nf.map };
  for (const [field, col] of Object.entries(wanted)) {
    if (!col || !columns.includes(col) || !fields.some((f) => f.key === field) || used.has(col)) continue;
    mapping[field] = col;
    used.add(col);
  }
  if (!mapping.email) return { error: 'Choose which column holds the email address.' };

  const limit = await getContactLimit(q);
  const stored = (await q.query<{ email_key: string }>('SELECT email_key FROM contact WHERE workspace_id = $1', [DEFAULT_WORKSPACE_ID])).rows;
  const storedKeys = new Set(stored.map((s) => s.email_key));
  let free = Math.max(0, limit - stored.length);

  const planned: Planned[] = [];
  const issues: ImportRowIssue[] = [];
  const seen = new Set<string>();
  const counts: Record<Action, number> = { add: 0, update: 0, skip_existing: 0, over_limit: 0, duplicate: 0, invalid: 0 };

  rows.forEach((raw, i) => {
    const row = i + 2; // line number in the file (line 1 is the column names)
    const emailRaw = (raw[mapping.email!] ?? '').trim();
    const problems: string[] = [];
    if (!emailRaw) problems.push('The email address is empty');
    else if (!isValidEmail(emailRaw)) problems.push(`"${emailRaw.slice(0, 60)}" is not a valid email address`);

    const values: Planned['values'] = {};
    for (const f of fields) {
      const col = mapping[f.key];
      if (!col || f.key === 'email') continue;
      const cell = parseCell(f, raw[col] ?? '');
      if ('error' in cell) problems.push(cell.error);
      else if (cell.value !== null) values[f.key] = cell.value;
    }

    const key = emailKey(emailRaw);
    let action: Action;
    if (problems.length) {
      action = 'invalid';
      issues.push({ row, email: emailRaw && isValidEmail(emailRaw) ? emailRaw : null, message: problems.join('; ') });
    } else if (seen.has(key)) {
      action = 'duplicate';
      issues.push({ row, email: emailRaw, message: 'Same email as an earlier row in this file, so it was skipped' });
    } else {
      seen.add(key);
      if (storedKeys.has(key)) action = updateExisting ? 'update' : 'skip_existing';
      else if (free > 0) { action = 'add'; free--; }
      else {
        action = 'over_limit';
        issues.push({ row, email: emailRaw, message: `Not saved: the limit of ${limit} contacts is full` });
      }
    }
    counts[action]++;
    planned.push({ row, key, email: emailRaw, values, action });
  });

  const preview: ImportPreview = {
    columns, mapping, fields, totalRows: rows.length,
    willAdd: counts.add, existing: counts.update + counts.skip_existing, willUpdate: counts.update,
    duplicatesInFile: counts.duplicate, overLimit: counts.over_limit, invalid: counts.invalid,
    issues: issues.slice(0, 50),
    capacity: { max: limit, stored: stored.length, free: Math.max(0, limit - stored.length) },
    sample: planned.slice(0, 15).map((p) => ({
      email: p.email, firstName: (p.values.first_name as string | undefined) ?? null, lastName: (p.values.last_name as string | undefined) ?? null, status: p.action,
    })),
  };
  return { preview, planned, newFields: nf.add };
}

// ---------- Saving ----------
/** Splits typed values into built-in columns and the custom-values object. */
function split(values: Record<string, ParsedValue>): { columns: Record<string, ParsedValue>; custom: Record<string, ParsedValue> } {
  const columns: Record<string, ParsedValue> = {};
  const custom: Record<string, ParsedValue> = {};
  for (const [k, v] of Object.entries(values)) (isStandardField(k) ? columns : custom)[k] = v;
  return { columns, custom };
}

function setClause(columns: Record<string, ParsedValue>, custom: Record<string, ParsedValue>, firstParam: number): { sql: string; params: unknown[] } {
  const keys = Object.keys(columns).filter((k) => COLUMN[k]);
  const parts = keys.map((k, i) => `${COLUMN[k]} = $${firstParam + i}`);
  const params: unknown[] = keys.map((k) => columns[k]);
  if (Object.keys(custom).length) {
    parts.push(`custom = custom || $${firstParam + params.length}::jsonb`);
    params.push(JSON.stringify(custom));
  }
  return { sql: parts.join(', '), params };
}

export async function commitImport(
  q: Queryable, // must be a transaction
  csv: string,
  mapping: Record<string, string> | undefined,
  updateExisting: boolean,
  userId: string,
  filename: string | null,
  newFields?: NewFieldRequest[],
): Promise<{ result: ImportPreview & { batchId: string; added: number; updated: number } } | { error: string }> {
  // Serialise imports: the second one waits, then counts again from what the first one saved.
  await q.query("SELECT pg_advisory_xact_lock(hashtext('contact_cap:' || $1))", [DEFAULT_WORKSPACE_ID]);
  const a = await analyse(q, csv, mapping, updateExisting, newFields);
  if ('error' in a) return a;
  const { preview, planned } = a;

  for (const f of a.newFields) {
    await q.query('INSERT INTO contact_field (workspace_id, key, label, type, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [DEFAULT_WORKSPACE_ID, f.key, f.label, f.type, userId]);
  }

  const batch = await q.query<{ id: string }>(
    `INSERT INTO import_batch (workspace_id, filename, total_rows, added, updated, duplicates_in_file, over_limit, invalid, update_existing, issues, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, filename?.slice(0, 200) ?? null, preview.totalRows, preview.willAdd, preview.willUpdate, preview.duplicatesInFile, preview.overLimit, preview.invalid, updateExisting,
      JSON.stringify(preview.issues.map((i) => ({ row: i.row, message: i.message.replace(/"[^"]*@[^"]*"/g, '"(email)"') }))), userId],
  );
  const batchId = batch.rows[0]!.id;

  for (const p of planned) {
    const { columns, custom } = split(p.values);
    if (p.action === 'add') {
      const cols = ['workspace_id', 'email', 'email_key', 'import_batch_id', 'created_by', ...Object.keys(columns).map((k) => COLUMN[k]!)];
      const params: unknown[] = [DEFAULT_WORKSPACE_ID, p.email.trim(), p.key, batchId, userId, ...Object.values(columns)];
      if (Object.keys(custom).length) { cols.push('custom'); params.push(JSON.stringify(custom)); }
      await q.query(`INSERT INTO contact (${cols.join(', ')}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})`, params);
    } else if (p.action === 'update' && Object.keys(p.values).length) {
      const { sql, params } = setClause(columns, custom, 3);
      await q.query(`UPDATE contact SET ${sql}, updated_at = now() WHERE workspace_id = $1 AND email_key = $2`, [DEFAULT_WORKSPACE_ID, p.key, ...params]);
    }
  }
  return { result: { ...preview, batchId, added: preview.willAdd, updated: preview.willUpdate } };
}

// ---------- One contact at a time ----------
export type ContactInput = Partial<Record<string, string>>;

/** Validates typed-in values from the edit form (same rules as the import). */
export function parseContactInput(input: ContactInput, fields: ContactField[], requireEmail: boolean): { values: Record<string, ParsedValue>; email?: string } | { error: string } {
  const values: Record<string, ParsedValue> = {};
  let email: string | undefined;
  for (const f of fields) {
    const raw = input[f.key];
    if (raw === undefined) continue;
    if (f.key === 'email') {
      const e = raw.trim();
      if (!isValidEmail(e)) return { error: `"${e.slice(0, 60)}" is not a valid email address.` };
      email = e;
      continue;
    }
    const cell = parseCell(f, raw);
    if ('error' in cell) return { error: cell.error + '.' };
    values[f.key] = cell.value;
  }
  if (requireEmail && !email) return { error: 'An email address is required.' };
  return { values, email };
}

export async function createContact(q: Queryable, input: ContactInput, userId: string): Promise<{ contact: ContactDto } | { error: string; status: number }> {
  const p = parseContactInput(input, await allFields(q), true);
  if ('error' in p) return { error: p.error, status: 400 };
  await q.query("SELECT pg_advisory_xact_lock(hashtext('contact_cap:' || $1))", [DEFAULT_WORKSPACE_ID]);
  const limit = await getContactLimit(q);
  if ((await countContacts(q)) >= limit) return { error: `The limit of ${limit} contacts is full. Delete a contact first.`, status: 409 };
  const key = emailKey(p.email!);
  if ((await q.query('SELECT 1 FROM contact WHERE workspace_id = $1 AND email_key = $2', [DEFAULT_WORKSPACE_ID, key])).rowCount) return { error: 'A contact with this email address already exists.', status: 409 };
  const present = Object.fromEntries(Object.entries(p.values).filter(([, v]) => v !== null));
  const { columns, custom } = split(present);
  const cols = ['workspace_id', 'email', 'email_key', 'created_by', ...Object.keys(columns).map((k) => COLUMN[k]!)];
  const params: unknown[] = [DEFAULT_WORKSPACE_ID, p.email, key, userId, ...Object.values(columns)];
  if (Object.keys(custom).length) { cols.push('custom'); params.push(JSON.stringify(custom)); }
  const r = await q.query<{ id: string }>(`INSERT INTO contact (${cols.join(', ')}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, params);
  return { contact: (await getContact(q, r.rows[0]!.id))! };
}

export async function updateContact(q: Queryable, id: string, input: ContactInput): Promise<{ contact: ContactDto } | { error: string; status: number }> {
  const p = parseContactInput(input, await allFields(q), false);
  if ('error' in p) return { error: p.error, status: 400 };
  if (!(await getContact(q, id))) return { error: 'Contact not found.', status: 404 };
  const values: Record<string, ParsedValue> = { ...p.values };
  if (p.email) {
    const key = emailKey(p.email);
    const clash = await q.query('SELECT 1 FROM contact WHERE workspace_id = $1 AND email_key = $2 AND id <> $3', [DEFAULT_WORKSPACE_ID, key, id]);
    if (clash.rowCount) return { error: 'Another contact already uses this email address.', status: 409 };
    await q.query('UPDATE contact SET email = $2, email_key = $3 WHERE id = $1', [id, p.email, key]);
  }
  // a marketing permission left blank means "no change"; everything else typed blank clears the value
  if (values.marketing_permission === null) delete values.marketing_permission;
  const { columns, custom } = split(values);
  const clearedCustom = Object.entries(custom).filter(([, v]) => v === null).map(([k]) => k);
  const setCustom = Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null));
  if (Object.keys(columns).length || Object.keys(setCustom).length) {
    const { sql, params } = setClause(columns, setCustom, 2);
    await q.query(`UPDATE contact SET ${sql}, updated_at = now() WHERE id = $1`, [id, ...params]);
  }
  for (const k of clearedCustom) await q.query('UPDATE contact SET custom = custom - $2, updated_at = now() WHERE id = $1', [id, k]);
  return { contact: (await getContact(q, id))! };
}

export async function deleteContact(q: Queryable, id: string): Promise<boolean> {
  return (await q.query('DELETE FROM contact WHERE id = $1 AND workspace_id = $2', [id, DEFAULT_WORKSPACE_ID])).rowCount === 1;
}

/** Records that a person opted out or must not be mailed. One-way here: real opt-outs and bounces arrive automatically with sending (M7). */
export async function markExcluded(q: Queryable, id: string, kind: 'unsubscribed' | 'suppressed'): Promise<ContactDto | null> {
  const sql = kind === 'unsubscribed'
    ? 'UPDATE contact SET unsubscribed_at = COALESCE(unsubscribed_at, now()), updated_at = now() WHERE id = $1 AND workspace_id = $2'
    : "UPDATE contact SET suppressed_reason = COALESCE(suppressed_reason, 'manual'), suppressed_at = COALESCE(suppressed_at, now()), updated_at = now() WHERE id = $1 AND workspace_id = $2";
  const r = await q.query(sql, [id, DEFAULT_WORKSPACE_ID]);
  return r.rowCount === 1 ? getContact(q, id) : null;
}
