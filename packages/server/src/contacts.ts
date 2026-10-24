import Papa from 'papaparse';
import {
  CONTACT_FIELDS, IMPORT_MAX_ROWS, MAX_CONTACTS, emailKey, exclusionReason, isValidEmail, parseCell,
  type ContactDto, type ContactField, type ImportPreview, type ImportRowIssue, type ParsedValue,
} from '@cl/shared';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';

// Contacts and the CSV import. The import is a two-step flow: analyse (nothing is saved) and commit (saves what the
// analysis said would fit). Both run the very same analysis, so the preview and the result can never disagree.

/** Contact property key -> database column. */
const COLUMN: Record<string, string> = {
  email: 'email', first_name: 'first_name', last_name: 'last_name', company: 'company', country: 'country', city: 'city',
  language: 'language', customer_since: 'customer_since', orders: 'orders', vip: 'vip', marketing_permission: 'marketing_active',
};

type Row = {
  id: string; email: string; first_name: string | null; last_name: string | null; company: string | null; country: string | null; city: string | null;
  language: string | null; customer_since: string | null; orders: number | null; vip: boolean | null; marketing_active: boolean;
  unsubscribed_at: Date | null; suppressed_reason: 'bounce' | 'complaint' | 'manual' | null; created_at: Date;
};

const SELECT = `id, email, first_name, last_name, company, country, city, language, to_char(customer_since, 'YYYY-MM-DD') AS customer_since, orders, vip,
                marketing_active, unsubscribed_at, suppressed_reason, created_at`;

export function toContactDto(r: Row): ContactDto {
  const dto = {
    id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, company: r.company, country: r.country, city: r.city, language: r.language,
    customerSince: r.customer_since, orders: r.orders, vip: r.vip, marketingActive: r.marketing_active,
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
  if (res.data.length > IMPORT_MAX_ROWS) return { error: `The file has ${res.data.length} rows. At most ${IMPORT_MAX_ROWS} rows can be imported at once (and only ${MAX_CONTACTS} contacts can be stored).` };
  return { columns, rows: res.data };
}

/** Matches each field to a column by name ("First Name", "first_name" and "firstname" all work). */
export function autoMapping(columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of CONTACT_FIELDS) {
    const hit = columns.find((c) => norm(c) === norm(f.key) || f.synonyms.some((s) => norm(c) === norm(s)));
    if (hit && !Object.values(out).includes(hit)) out[f.key] = hit;
  }
  return out;
}

// ---------- The analysis ----------
type Action = 'add' | 'update' | 'skip_existing' | 'over_limit' | 'duplicate' | 'invalid';
type Planned = { row: number; key: string; email: string; values: Partial<Record<string, ParsedValue>>; action: Action };

export type Analysis = { preview: ImportPreview; planned: Planned[] };

export async function analyse(
  q: Queryable,
  csv: string,
  mappingIn: Record<string, string> | undefined,
  updateExisting: boolean,
): Promise<Analysis | { error: string }> {
  const parsed = parseCsv(csv);
  if ('error' in parsed) return parsed;
  const { columns, rows } = parsed;

  // keep only mappings that point to a real column and a known field; never the same column twice
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const [field, col] of Object.entries(mappingIn ?? autoMapping(columns))) {
    if (!col || !columns.includes(col) || !COLUMN[field] || used.has(col)) continue;
    mapping[field] = col;
    used.add(col);
  }
  if (!mapping.email) return { error: 'Choose which column holds the email address.' };

  const stored = (await q.query<{ email_key: string }>('SELECT email_key FROM contact WHERE workspace_id = $1', [DEFAULT_WORKSPACE_ID])).rows;
  const storedKeys = new Set(stored.map((s) => s.email_key));
  let free = Math.max(0, MAX_CONTACTS - stored.length);

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
    for (const f of CONTACT_FIELDS) {
      const col = mapping[f.key];
      if (!col || f.key === 'email') continue;
      const cell = parseCell(f as ContactField, raw[col] ?? '');
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
        issues.push({ row, email: emailRaw, message: `Not saved: the limit of ${MAX_CONTACTS} contacts is full` });
      }
    }
    counts[action]++;
    planned.push({ row, key, email: emailRaw, values, action });
  });

  const preview: ImportPreview = {
    columns, mapping, totalRows: rows.length,
    willAdd: counts.add, existing: counts.update + counts.skip_existing, willUpdate: counts.update,
    duplicatesInFile: counts.duplicate, overLimit: counts.over_limit, invalid: counts.invalid,
    issues: issues.slice(0, 50),
    capacity: { max: MAX_CONTACTS, stored: stored.length, free: Math.max(0, MAX_CONTACTS - stored.length) },
    sample: planned.slice(0, 15).map((p) => ({
      email: p.email, firstName: (p.values.first_name as string | undefined) ?? null, lastName: (p.values.last_name as string | undefined) ?? null, status: p.action,
    })),
  };
  return { preview, planned };
}

// ---------- Saving ----------
function setClause(values: Planned['values'], firstParam: number): { sql: string; params: ParsedValue[] } {
  const keys = Object.keys(values).filter((k) => COLUMN[k]);
  return { sql: keys.map((k, i) => `${COLUMN[k]} = $${firstParam + i}`).join(', '), params: keys.map((k) => values[k] as ParsedValue) };
}

export async function commitImport(
  q: Queryable, // must be a transaction
  csv: string,
  mapping: Record<string, string> | undefined,
  updateExisting: boolean,
  userId: string,
  filename: string | null,
): Promise<{ result: ImportPreview & { batchId: string; added: number; updated: number } } | { error: string }> {
  // Serialise imports: the second one waits, then counts again from what the first one saved.
  await q.query("SELECT pg_advisory_xact_lock(hashtext('contact_cap:' || $1))", [DEFAULT_WORKSPACE_ID]);
  const a = await analyse(q, csv, mapping, updateExisting);
  if ('error' in a) return a;
  const { preview, planned } = a;

  const batch = await q.query<{ id: string }>(
    `INSERT INTO import_batch (workspace_id, filename, total_rows, added, updated, duplicates_in_file, over_limit, invalid, update_existing, issues, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, filename?.slice(0, 200) ?? null, preview.totalRows, preview.willAdd, preview.willUpdate, preview.duplicatesInFile, preview.overLimit, preview.invalid, updateExisting,
      JSON.stringify(preview.issues.map((i) => ({ row: i.row, message: i.message.replace(/"[^"]*@[^"]*"/g, '"(email)"') }))), userId],
  );
  const batchId = batch.rows[0]!.id;

  for (const p of planned) {
    if (p.action === 'add') {
      const cols = ['workspace_id', 'email', 'email_key', 'import_batch_id', 'created_by', ...Object.keys(p.values).map((k) => COLUMN[k]!)];
      const params: unknown[] = [DEFAULT_WORKSPACE_ID, p.email.trim(), p.key, batchId, userId, ...Object.values(p.values)];
      await q.query(`INSERT INTO contact (${cols.join(', ')}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})`, params);
    } else if (p.action === 'update' && Object.keys(p.values).length) {
      const { sql, params } = setClause(p.values, 3);
      await q.query(`UPDATE contact SET ${sql}, updated_at = now() WHERE workspace_id = $1 AND email_key = $2`, [DEFAULT_WORKSPACE_ID, p.key, ...params]);
    }
  }
  return { result: { ...preview, batchId, added: preview.willAdd, updated: preview.willUpdate } };
}

// ---------- One contact at a time ----------
export type ContactInput = Partial<Record<string, string>>;

/** Validates typed-in values from the edit form (same rules as the import). */
export function parseContactInput(input: ContactInput, requireEmail: boolean): { values: Record<string, ParsedValue>; email?: string } | { error: string } {
  const values: Record<string, ParsedValue> = {};
  let email: string | undefined;
  for (const f of CONTACT_FIELDS) {
    const raw = input[f.key];
    if (raw === undefined) continue;
    if (f.key === 'email') {
      const e = raw.trim();
      if (!isValidEmail(e)) return { error: `"${e.slice(0, 60)}" is not a valid email address.` };
      email = e;
      continue;
    }
    const cell = parseCell(f as ContactField, raw);
    if ('error' in cell) return { error: cell.error + '.' };
    values[f.key] = cell.value;
  }
  if (requireEmail && !email) return { error: 'An email address is required.' };
  return { values, email };
}

export async function createContact(q: Queryable, input: ContactInput, userId: string): Promise<{ contact: ContactDto } | { error: string; status: number }> {
  const p = parseContactInput(input, true);
  if ('error' in p) return { error: p.error, status: 400 };
  await q.query("SELECT pg_advisory_xact_lock(hashtext('contact_cap:' || $1))", [DEFAULT_WORKSPACE_ID]);
  if ((await countContacts(q)) >= MAX_CONTACTS) return { error: `The limit of ${MAX_CONTACTS} contacts is full. Delete a contact first.`, status: 409 };
  const key = emailKey(p.email!);
  if ((await q.query('SELECT 1 FROM contact WHERE workspace_id = $1 AND email_key = $2', [DEFAULT_WORKSPACE_ID, key])).rowCount) return { error: 'A contact with this email address already exists.', status: 409 };
  const cols = ['workspace_id', 'email', 'email_key', 'created_by', ...Object.keys(p.values).filter((k) => p.values[k] !== null).map((k) => COLUMN[k]!)];
  const params: unknown[] = [DEFAULT_WORKSPACE_ID, p.email, key, userId, ...Object.values(p.values).filter((v) => v !== null)];
  const r = await q.query<{ id: string }>(`INSERT INTO contact (${cols.join(', ')}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, params);
  return { contact: (await getContact(q, r.rows[0]!.id))! };
}

export async function updateContact(q: Queryable, id: string, input: ContactInput): Promise<{ contact: ContactDto } | { error: string; status: number }> {
  const p = parseContactInput(input, false);
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
  const keys = Object.keys(values);
  if (keys.length) {
    const { sql, params } = setClause(values, 2);
    await q.query(`UPDATE contact SET ${sql}, updated_at = now() WHERE id = $1`, [id, ...params]);
  }
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
