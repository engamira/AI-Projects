import {
  SAMPLE_RECIPIENTS, TEST_AUDIENCE_MAX, fieldValue, parseCell, segmentCode, segmentContacts,
  type ContactDto, type ContactField, type PreviewRecipientGroup, type PreviewRecipientsResponse, type Recipient, type TestAudienceRequest, type TestContactDto,
} from '@cl/shared';
import { allFields, listContacts } from './contacts.js';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';

// A campaign's audience set-up: which fields segment it, a generated TEST audience (made-up contacts, one per segment,
// never part of the real list and never mailed), and who "Preview as..." can show the email to.

const MAX_FIELDS = 5;

export async function getAudienceFields(q: Queryable, campaignId: string): Promise<string[]> {
  const r = await q.query<{ fields: string[] }>('SELECT fields FROM campaign_audience WHERE campaign_id = $1', [campaignId]);
  return r.rows[0]?.fields ?? [];
}

export async function setAudienceFields(q: Queryable, campaignId: string, keys: string[], userId: string): Promise<{ fields: string[] } | { error: string }> {
  const known = await allFields(q);
  const clean: string[] = [];
  for (const k of keys) {
    if (!known.some((f) => f.key === k)) return { error: `There is no field called "${k}".` };
    if (k === 'email' || k === 'marketing_permission') return { error: 'The email address and marketing permission cannot be used to segment.' };
    if (!clean.includes(k)) clean.push(k);
  }
  if (clean.length > MAX_FIELDS) return { error: `Choose at most ${MAX_FIELDS} fields.` };
  await q.query(
    `INSERT INTO campaign_audience (campaign_id, workspace_id, fields, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (campaign_id) DO UPDATE SET fields = EXCLUDED.fields, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [campaignId, DEFAULT_WORKSPACE_ID, JSON.stringify(clean), userId],
  );
  // test contacts were made for the old choice: they no longer match, so they are removed (never left behind to confuse a test)
  await q.query('DELETE FROM campaign_test_contact WHERE campaign_id = $1', [campaignId]);
  return { fields: clean };
}

type TestRow = { id: string; code: string; email: string; data: TestContactDto['data'] };
const toTest = (r: TestRow): TestContactDto => ({ id: r.id, code: r.code, email: r.email, data: r.data });

export async function listTestContacts(q: Queryable, campaignId: string): Promise<TestContactDto[]> {
  const r = await q.query<TestRow>('SELECT id, code, email, data FROM campaign_test_contact WHERE campaign_id = $1 ORDER BY code', [campaignId]);
  return r.rows.map(toTest);
}

export async function clearTestContacts(q: Queryable, campaignId: string): Promise<void> {
  await q.query('DELETE FROM campaign_test_contact WHERE campaign_id = $1', [campaignId]);
}

const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Robin', 'Casey', 'Morgan', 'Riley', 'Jamie', 'Quinn'];
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

type Value = string | number | boolean;
const same = (a: Value, b: Value): boolean => (typeof a === 'string' && typeof b === 'string' ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b);

/** Replaces the campaign's test audience with one made-up contact per segment. */
export async function generateTestAudience(q: Queryable, campaignId: string, req: TestAudienceRequest): Promise<{ contacts: TestContactDto[] } | { error: string }> {
  const keys = await getAudienceFields(q, campaignId);
  if (keys.length === 0) return { error: 'Choose the fields that segment this campaign first.' };
  const fields = (await allFields(q)).filter((f) => keys.includes(f.key));
  const ordered = keys.map((k) => fields.find((f) => f.key === k)!).filter(Boolean);
  const real = await listContacts(q);

  let combos: Value[][] = [];
  if (req.mode === 'sheet') {
    for (const s of segmentContacts(real, ordered)) {
      if (s.values.every((v) => v === null || v === '')) continue; // a segment with nothing in it is not worth testing
      combos.push(s.values.map((v) => (v === null || v === '' ? '' : v)));
    }
  }
  // values per field: those in the contact list plus any the person typed in
  const lists: Value[][] = [];
  for (const f of ordered) {
    const vals: Value[] = [];
    const add = (v: Value) => { if (!vals.some((x) => same(x, v))) vals.push(v); };
    for (const c of real) { const v = fieldValue(c, f.key); if (v !== null && v !== '') add(v); }
    for (const raw of req.extraValues?.[f.key] ?? []) {
      const cell = parseCell(f, raw);
      if ('error' in cell) return { error: cell.error + '.' };
      if (cell.value !== null) add(cell.value);
    }
    lists.push(vals);
  }
  if (req.mode === 'all') {
    if (lists.some((l) => l.length === 0)) return { error: 'There are no values to combine yet. Add some in the boxes below, or import contacts first.' };
    combos = lists.reduce<Value[][]>((acc, l) => acc.flatMap((a) => l.map((v) => [...a, v])), [[]]);
  } else if (req.extraValues && Object.values(req.extraValues).some((l) => l.length)) {
    // "sheet" mode plus typed-in values: also make the combinations that use them
    const all = lists.every((l) => l.length > 0) ? lists.reduce<Value[][]>((acc, l) => acc.flatMap((a) => l.map((v) => [...a, v])), [[]]) : [];
    for (const c of all) if (!combos.some((x) => x.every((v, i) => same(v, c[i]!)))) combos.push(c);
  }
  if (combos.length === 0) return { error: 'No segments to create test contacts for. Import contacts first, or add values and choose "every combination".' };
  if (combos.length > TEST_AUDIENCE_MAX) return { error: `That would make ${combos.length} test contacts. The most is ${TEST_AUDIENCE_MAX}: use fewer values or fewer fields.` };

  await clearTestContacts(q, campaignId);
  const used = new Set<string>();
  const out: TestContactDto[] = [];
  for (const [i, c] of combos.entries()) {
    let code = segmentCode(c.map((v) => (v === '' ? null : v)));
    if (used.has(code)) code = `${code}-${i + 1}`;
    used.add(code);
    const data: TestContactDto['data'] = {
      first_name: FIRST_NAMES[i % FIRST_NAMES.length]!, last_name: 'Test', company: 'Test Co', email: `${slug(code)}@test-audience.invalid`,
    };
    ordered.forEach((f, j) => { data[f.key] = c[j] === '' ? null : (c[j] as Value); });
    const r = await q.query<{ id: string }>(
      'INSERT INTO campaign_test_contact (workspace_id, campaign_id, code, email, data) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [DEFAULT_WORKSPACE_ID, campaignId, code, data.email, JSON.stringify(data)],
    );
    out.push({ id: r.rows[0]!.id, code, email: String(data.email), data });
  }
  return { contacts: out };
}

// ---------- "Preview as..." ----------
const asRecipient = (c: ContactDto): Recipient => ({
  email: c.email, first_name: c.firstName, last_name: c.lastName, company: c.company, country: c.country, city: c.city, language: c.language,
  customer_since: c.customerSince, orders: c.orders, vip: c.vip, ...c.custom,
});

/** Who the preview can be shown as. Real contacts are only listed for people allowed to see the audience. */
export async function previewRecipients(q: Queryable, campaignId: string, canSeeContacts: boolean): Promise<PreviewRecipientsResponse> {
  const keys = await getAudienceFields(q, campaignId);
  const all = await allFields(q);
  const segmentFields = keys.map((k) => all.find((f) => f.key === k)).filter((f): f is ContactField => !!f);
  const groups: PreviewRecipientGroup[] = [{ title: 'Built-in examples', recipients: SAMPLE_RECIPIENTS.map((s) => ({ id: s.id, label: s.label })) }];

  const tests = await listTestContacts(q, campaignId);
  if (tests.length) groups.push({ title: 'Test audience (made up for this campaign)', recipients: tests.map((t) => ({ id: `test:${t.id}`, label: `${t.code}  ·  ${String(t.data.first_name ?? '')} (test)` })) });

  if (canSeeContacts) {
    const contacts = (await listContacts(q)).filter((c) => !c.excludedReason).slice(0, 100);
    if (segmentFields.length) {
      for (const s of segmentContacts(contacts, segmentFields)) {
        const code = segmentCode(s.values);
        groups.push({
          title: `Contacts in segment ${code}`,
          recipients: contacts.filter((c) => segmentCode(segmentFields.map((f) => fieldValue(c, f.key))) === code).map((c) => ({ id: `contact:${c.id}`, label: `${code}  ·  ${c.email}` })),
        });
      }
    } else if (contacts.length) {
      groups.push({ title: 'Contacts from your list', recipients: contacts.map((c) => ({ id: `contact:${c.id}`, label: c.email })) });
    }
  }
  return { segmentFields, groups };
}

export type ResolvedRecipient = { kind: 'raw' } | { kind: 'recipient'; recipient: Recipient | null; label: string } | { kind: 'not_found' } | { kind: 'forbidden' };

/** Turns the chosen "Preview as" id into the values to fill the email with. */
export async function resolveRecipient(q: Queryable, campaignId: string, id: string, canSeeContacts: boolean): Promise<ResolvedRecipient> {
  const sample = SAMPLE_RECIPIENTS.find((s) => s.id === id);
  if (sample) return sample.recipient === null ? { kind: 'raw' } : { kind: 'recipient', recipient: sample.recipient, label: sample.label };
  const m = /^(test|contact):([0-9a-f-]{36})$/i.exec(id);
  if (!m) return { kind: 'not_found' };
  if (m[1] === 'test') {
    const r = await q.query<TestRow>('SELECT id, code, email, data FROM campaign_test_contact WHERE id = $1 AND campaign_id = $2', [m[2], campaignId]);
    return r.rows[0] ? { kind: 'recipient', recipient: r.rows[0].data, label: `${r.rows[0].code} (test contact)` } : { kind: 'not_found' };
  }
  if (!canSeeContacts) return { kind: 'forbidden' };
  const contacts = await listContacts(q);
  const c = contacts.find((x) => x.id === m[2]);
  if (!c) return { kind: 'not_found' };
  const keys = await getAudienceFields(q, campaignId);
  const fields = (await allFields(q)).filter((f) => keys.includes(f.key));
  const code = fields.length ? `${segmentCode(keys.map((k) => fieldValue(c, k)))}  ·  ` : '';
  return { kind: 'recipient', recipient: asRecipient(c), label: `${code}${c.email}` };
}

