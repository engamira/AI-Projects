import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTACT_LIMIT as MAX_CONTACTS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, type ContactDto, type ImportPreview } from '@cl/shared';
import { autoMapping, parseCsv } from './contacts.js';
import { createTestApp, type Client, type TestApp } from './testkit.js';

let t: TestApp;
let builder: Client;
let admin: Client;
let qa: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
  qa = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
});
afterAll(() => t.close());
beforeEach(async () => { await t.db.query('DELETE FROM contact'); });

const header = 'Email,First Name,Last Name,Company,Country,City,Language,Customer Since,Orders,VIP,Marketing Permission';
const line = (n: number, extra: Partial<Record<string, string>> = {}) =>
  [extra.email ?? `person${n}@example.com`, extra.first ?? `First${n}`, `Last${n}`, 'Acme', extra.country ?? 'UAE', 'Dubai', 'en', extra.since ?? '2024-05-01', extra.orders ?? String(n), extra.vip ?? 'no', extra.perm ?? 'yes'].join(',');
const file = (rows: string[]) => [header, ...rows].join('\n');
const contacts = async () => (await builder.get('/api/contacts')).body.contacts as ContactDto[];
const preview = (csv: string, extra: object = {}) => builder.post('/api/contacts/import/preview', { csv, ...extra });
const doImport = (csv: string, extra: object = {}, who: Client = builder) => who.post('/api/contacts/import', { csv, ...extra });

describe('reading a file', () => {
  it('matches columns by name, whatever the capitals, spaces or underscores', () => {
    const m = autoMapping(['E-mail', 'first_name', 'LAST NAME', 'Company', 'Customer Since', 'Marketing permission', 'Notes']);
    expect(m).toMatchObject({ email: 'E-mail', first_name: 'first_name', last_name: 'LAST NAME', company: 'Company', customer_since: 'Customer Since', marketing_permission: 'Marketing permission' });
    expect(Object.values(m)).not.toContain('Notes');
  });

  it('copes with a BOM, semicolons, quoted commas and blank lines; refuses empty or heading-only files', () => {
    const ok = parseCsv('﻿email;first name\n"a@b.co";"Ann, Jr"\n\n');
    expect('rows' in ok && ok.rows).toEqual([{ email: 'a@b.co', 'first name': 'Ann, Jr' }]);
    expect('error' in parseCsv('')).toBe(true);
    expect('error' in parseCsv('email,name')).toBe(true);
    expect('error' in parseCsv('email,Email\na@b.co,a@b.co')).toBe(true); // two columns with the same name
  });
});

describe('import preview and commit', () => {
  it('the preview saves nothing and says what would happen; the import then does exactly that', async () => {
    const csv = file([line(1), line(2), line(3)]);
    const p = (await preview(csv)).body as ImportPreview;
    expect(p).toMatchObject({ totalRows: 3, willAdd: 3, invalid: 0, overLimit: 0, capacity: { max: 10, stored: 0, free: 10 } });
    expect(await contacts()).toHaveLength(0);
    const r = await doImport(csv);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ added: 3, updated: 0 });
    const list = await contacts();
    expect(list.map((c) => c.email)).toEqual(['person1@example.com', 'person2@example.com', 'person3@example.com']);
    expect(list[0]).toMatchObject({ firstName: 'First1', lastName: 'Last1', company: 'Acme', country: 'UAE', customerSince: '2024-05-01', orders: 1, vip: false, marketingActive: true, excludedReason: null });
  });

  it('every bad row is reported with its line number and a plain message, and good rows still import', async () => {
    const csv = file([line(1), line(2, { email: 'not-an-email' }), line(3, { since: '2024-13-45' }), line(4, { orders: 'many' }), line(5, { vip: 'maybe' }), line(6, { email: '' }), line(7)]);
    const p = (await preview(csv)).body as ImportPreview;
    expect(p.willAdd).toBe(2);
    expect(p.invalid).toBe(5);
    const byRow = Object.fromEntries(p.issues.map((i) => [i.row, i.message]));
    expect(byRow[3]).toContain('not a valid email');
    expect(byRow[4]).toContain('not a real date');
    expect(byRow[5]).toContain('whole number');
    expect(byRow[6]).toContain('yes or no');
    expect(byRow[7]).toContain('empty');
    expect((await doImport(csv)).body.added).toBe(2);
    expect(await contacts()).toHaveLength(2);
  });

  it('a repeated email in the file keeps the first row and skips the later ones (capitals and spaces ignored)', async () => {
    const csv = file([line(1, { first: 'Original' }), line(2, { email: ' PERSON1@Example.com ', first: 'Later' }), line(3)]);
    const p = (await preview(csv)).body as ImportPreview;
    expect(p).toMatchObject({ willAdd: 2, duplicatesInFile: 1 });
    await doImport(csv);
    const list = await contacts();
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.email === 'person1@example.com')?.firstName).toBe('Original');
  });

  it('contacts that are already stored are skipped by default; with "update existing" they are updated without using capacity, and blank cells never erase', async () => {
    await doImport(file([line(1, { first: 'Keep', country: 'UAE' })]));
    const again = file([line(1, { first: 'Changed', country: '' }), line(2)]);
    const p1 = (await preview(again)).body as ImportPreview;
    expect(p1).toMatchObject({ existing: 1, willUpdate: 0, willAdd: 1 });
    await doImport(again);
    expect((await contacts()).find((c) => c.email === 'person1@example.com')?.firstName).toBe('Keep');

    const p2 = (await preview(again, { updateExisting: true })).body as ImportPreview;
    expect(p2).toMatchObject({ existing: 2, willUpdate: 2, willAdd: 0 }); // person2 was added by the previous import
    const r = await doImport(again, { updateExisting: true });
    expect(r.body).toMatchObject({ added: 0, updated: 2 });
    const c = (await contacts()).find((x) => x.email === 'person1@example.com')!;
    expect(c.firstName).toBe('Changed');
    expect(c.country).toBe('UAE'); // the blank cell did not erase it
  });

  it('the limit of 10 holds across repeated imports, and rows that do not fit are named in the preview', async () => {
    const first = file(Array.from({ length: 7 }, (_, i) => line(i + 1)));
    expect((await doImport(first)).body.added).toBe(7);
    const second = file(Array.from({ length: 6 }, (_, i) => line(i + 20)));
    const p = (await preview(second)).body as ImportPreview;
    expect(p).toMatchObject({ willAdd: 3, overLimit: 3, capacity: { stored: 7, free: 3 } });
    expect(p.issues.filter((i) => i.message.includes('limit')).map((i) => i.row)).toEqual([5, 6, 7]);
    expect(p.sample.map((s) => s.status)).toEqual(['add', 'add', 'add', 'over_limit', 'over_limit', 'over_limit']);
    expect((await doImport(second)).body).toMatchObject({ added: 3, overLimit: 3 });
    expect(await contacts()).toHaveLength(MAX_CONTACTS);
    const third = await doImport(file([line(40)]));
    expect(third.body).toMatchObject({ added: 0, overLimit: 1 });
    expect(await contacts()).toHaveLength(MAX_CONTACTS);
  });

  it('two imports at the same moment cannot exceed the limit', async () => {
    const a = file(Array.from({ length: 8 }, (_, i) => line(i + 1)));
    const b = file(Array.from({ length: 8 }, (_, i) => line(i + 100)));
    const [ra, rb] = await Promise.all([doImport(a), doImport(b, {}, admin)]);
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.added + rb.body.added).toBe(MAX_CONTACTS);
    expect(await contacts()).toHaveLength(MAX_CONTACTS);
  });

  it('the database itself refuses an eleventh contact, even if the app code were bypassed', async () => {
    await doImport(file(Array.from({ length: 10 }, (_, i) => line(i + 1))));
    await expect(t.db.query("INSERT INTO contact (workspace_id, email, email_key) SELECT workspace_id, 'x@example.com', 'x@example.com' FROM contact LIMIT 1")).rejects.toThrow(/limit/);
    expect(await contacts()).toHaveLength(10);
  });

  it('a custom column choice is used, a missing email column is explained, and oversized files are refused', async () => {
    const csv = 'Contact,Given\nann@example.com,Ann\n';
    const p = (await preview(csv)).body;
    expect((await preview(csv)).status).toBe(400);
    expect(p.message).toContain('email address');
    const mapped = (await preview(csv, { mapping: { email: 'Contact', first_name: 'Given' } })).body as ImportPreview;
    expect(mapped).toMatchObject({ willAdd: 1, mapping: { email: 'Contact', first_name: 'Given' } });
    await doImport(csv, { mapping: { email: 'Contact', first_name: 'Given' } });
    expect((await contacts())[0]).toMatchObject({ email: 'ann@example.com', firstName: 'Ann' });
    const tooBig = await preview('email\n' + 'a@example.com\n'.repeat(Math.ceil(IMPORT_MAX_BYTES / 14) + 10));
    expect(tooBig.status).toBe(400);
    const tooMany = await preview('email\n' + Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `u${i}@example.com`).join('\n'));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toContain(`${IMPORT_MAX_ROWS} rows`);
  });

  it('the activity history records the import with counts only, never email addresses', async () => {
    await doImport(file([line(1), line(2, { email: 'broken' })]));
    const log = (await admin.get('/api/activity')).body as { items?: { action: string; details: unknown }[] } | { action: string; details: unknown }[];
    const items = Array.isArray(log) ? log : log.items ?? [];
    const entry = items.find((x) => x.action === 'contacts.imported');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry!.details)).not.toMatch(/@/);
    const batch = await t.db.query<{ issues: unknown }>('SELECT issues FROM import_batch');
    expect(JSON.stringify(batch.rows[0]!.issues)).not.toMatch(/@/);
  });
});

describe('single contacts, exclusions and who may use the audience', () => {
  it('a contact can be added, edited and deleted, and deleting frees room', async () => {
    const c = await builder.post('/api/contacts', { email: ' New.Person@Example.com ', first_name: 'New', orders: '3', vip: 'yes' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ email: 'New.Person@Example.com', firstName: 'New', orders: 3, vip: true });
    expect((await builder.post('/api/contacts', { email: 'new.person@example.com' })).status).toBe(409); // same person
    expect((await builder.post('/api/contacts', { email: 'bad' })).status).toBe(400);
    const e = await builder.patch(`/api/contacts/${c.body.id}`, { company: 'Acme', orders: '' });
    expect(e.body).toMatchObject({ company: 'Acme', orders: null });
    expect((await builder.delete(`/api/contacts/${c.body.id}`)).status).toBe(204);
    expect((await builder.delete(`/api/contacts/${c.body.id}`)).status).toBe(404);
    expect(await contacts()).toHaveLength(0);
  });

  it('adding one by hand at the limit is refused with a clear message', async () => {
    await doImport(file(Array.from({ length: 10 }, (_, i) => line(i + 1))));
    const r = await builder.post('/api/contacts', { email: 'eleventh@example.com' });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('limit');
  });

  it('inactive permission, unsubscribed and suppressed are each shown as the reason a contact is excluded', async () => {
    await doImport(file([line(1), line(2, { perm: 'no' }), line(3), line(4)]));
    const list = await contacts();
    const by = (n: number) => list.find((c) => c.email === `person${n}@example.com`)!;
    expect((await builder.post(`/api/contacts/${by(3).id}/mark/unsubscribed`)).body.excludedReason).toBe('unsubscribed');
    expect((await admin.post(`/api/contacts/${by(4).id}/mark/suppressed`)).body.excludedReason).toBe('suppressed');
    const after = await contacts();
    expect(after.map((c) => c.excludedReason)).toEqual([null, 'no_permission', 'unsubscribed', 'suppressed']);
    expect((await builder.post(`/api/contacts/${by(3).id}/mark/whatever`)).status).toBe(400);
  });

  it('Admin and Builder can use the audience; a QA reviewer cannot read or change it', async () => {
    await doImport(file([line(1)]));
    expect((await admin.get('/api/contacts')).status).toBe(200);
    expect((await qa.get('/api/contacts')).status).toBe(403);
    expect((await qa.post('/api/contacts/import/preview', { csv: file([line(2)]) })).status).toBe(403);
    expect((await doImport(file([line(2)]), {}, qa)).status).toBe(403);
    expect((await qa.post('/api/contacts', { email: 'qa@example.com' })).status).toBe(403);
    expect(await contacts()).toHaveLength(1);
  });
});

describe('the limit is a setting, custom fields and segments', () => {
  const setLimit = (who: Client, n: unknown) => who.put('/api/audience/settings', { contactLimit: n });
  afterAll(async () => { await t.db.query('DELETE FROM audience_setting'); await t.db.query('DELETE FROM contact_field'); });

  it('only an Admin can change the limit; it stays 10 until they do, then more contacts fit, and it cannot go below what is stored', async () => {
    expect((await builder.get('/api/contacts')).body.max).toBe(10);
    expect((await setLimit(builder, 25)).status).toBe(403);
    expect((await setLimit(qa, 25)).status).toBe(403);
    await doImport(file(Array.from({ length: 10 }, (_, i) => line(i + 1))));
    expect((await doImport(file([line(50)]))).body).toMatchObject({ added: 0, overLimit: 1 });
    expect((await setLimit(admin, 25)).body.contactLimit).toBe(25);
    expect((await builder.get('/api/contacts')).body.max).toBe(25);
    const more = await doImport(file(Array.from({ length: 20 }, (_, i) => line(i + 100))));
    expect(more.body).toMatchObject({ added: 15, overLimit: 5 });
    expect(await contacts()).toHaveLength(25);
    const tooLow = await setLimit(admin, 12);
    expect(tooLow.status, JSON.stringify(tooLow.body)).toBe(400);
    expect(tooLow.body.message).toContain('25 contacts stored');
    expect((await setLimit(admin, 0)).status, 'zero').toBe(400);
    expect((await setLimit(admin, 1001)).status, 'ceiling').toBe(400);
    expect((await setLimit(admin, 2.5)).status, 'fraction').toBe(400);
    // the database enforces the new number too
    await expect(t.db.query("INSERT INTO contact (workspace_id, email, email_key) SELECT workspace_id, 'z@example.com', 'z@example.com' FROM contact LIMIT 1")).rejects.toThrow(/limit/);
    await t.db.query('DELETE FROM audience_setting');
  });

  it('a column that is not built in can be brought in as a new field, and its values are kept per contact', async () => {
    const csv = 'Email,Country of Residence,Interest Level\nann@example.com,UAE,3\nbob@example.com,Egypt,\n';
    const p = (await preview(csv, { newFields: [{ column: 'Country of Residence', label: 'Country of residence', type: 'text' }, { column: 'Interest Level', label: 'Interest level', type: 'number' }] })).body as ImportPreview;
    expect(p.willAdd).toBe(2);
    expect(p.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['country_of_residence', 'interest_level']));
    expect((await builder.get('/api/contacts')).body.fields.some((f: { key: string }) => f.key === 'country_of_residence')).toBe(false); // preview created nothing
    await doImport(csv, { newFields: [{ column: 'Country of Residence', label: 'Country of residence', type: 'text' }, { column: 'Interest Level', label: 'Interest level', type: 'number' }] });
    const res = (await builder.get('/api/contacts')).body;
    expect(res.fields.filter((f: { custom?: boolean }) => f.custom).map((f: { key: string }) => f.key)).toEqual(['country_of_residence', 'interest_level']);
    const ann = res.contacts.find((c: ContactDto) => c.email === 'ann@example.com');
    expect(ann.custom).toEqual({ country_of_residence: 'UAE', interest_level: 3 });
    expect(res.contacts.find((c: ContactDto) => c.email === 'bob@example.com').custom).toEqual({ country_of_residence: 'Egypt' });
    // bad value in a custom column is a row problem like any other
    const bad = (await preview('Email,Interest Level\ncy@example.com,lots\n', { mapping: { email: 'Email', interest_level: 'Interest Level' } })).body as ImportPreview;
    expect(bad.invalid).toBe(1);
    expect(bad.issues[0]!.message).toContain('Interest level must be a whole number');
    // later files match the custom field by its name, with no setup
    const again = (await preview('Email,Country of residence\ndee@example.com,Oman\n')).body as ImportPreview;
    expect(again.mapping.country_of_residence).toBe('Country of residence');
  });

  it('custom fields can be added by hand, edited on a contact, and removed (their values go too); names cannot clash', async () => {
    const f = await builder.post('/api/contact-fields', { label: 'Favourite colour', type: 'text' });
    expect(f.status).toBe(201);
    expect(f.body).toEqual({ key: 'favourite_colour', label: 'Favourite colour', type: 'text' });
    expect((await builder.post('/api/contact-fields', { label: 'favourite COLOUR', type: 'text' })).status).toBe(409);
    expect((await builder.post('/api/contact-fields', { label: 'Country', type: 'text' })).status).toBe(409); // built in
    expect((await builder.post('/api/contact-fields', { label: '', type: 'text' })).status).toBe(400);
    expect((await builder.post('/api/contact-fields', { label: 'Odd', type: 'colour' })).status).toBe(400);
    const c = await builder.post('/api/contacts', { email: 'eve@example.com', favourite_colour: 'Blue' });
    expect(c.body.custom).toEqual({ favourite_colour: 'Blue' });
    expect((await builder.patch(`/api/contacts/${c.body.id}`, { favourite_colour: '' })).body.custom).toEqual({});
    await builder.patch(`/api/contacts/${c.body.id}`, { favourite_colour: 'Red' });
    expect((await qa.delete('/api/contact-fields/favourite_colour')).status).toBe(403);
    expect((await builder.delete('/api/contact-fields/favourite_colour')).status).toBe(204);
    expect((await builder.delete('/api/contact-fields/favourite_colour')).status).toBe(404);
    expect((await contacts()).find((x) => x.email === 'eve@example.com')!.custom).toEqual({});
  });

  it('segments split the contacts by the fields you choose, with total and eligible counts; blanks and capitals are handled', async () => {
    await builder.post('/api/contact-fields', { label: 'Country of residence', type: 'text' });
    const csv = [
      'Email,Language,City,Country of residence,Marketing Permission',
      'a1@example.com,en,Dubai,UAE,yes',
      'a2@example.com,EN,Dubai,UAE,yes',
      'a3@example.com,en,Dubai,UAE,no',
      'b1@example.com,ar,Cairo,Egypt,yes',
      'c1@example.com,,Cairo,Egypt,yes',
    ].join('\n');
    await doImport(csv);
    const seg = async (fields: string) => (await builder.get(`/api/audience/segments?fields=${fields}`)).body;
    const one = await seg('language');
    expect(one.totalContacts).toBe(5);
    expect(one.totalEligible).toBe(4);
    expect(one.segments.map((s: { label: string; total: number; eligible: number }) => [s.label, s.total, s.eligible])).toEqual([
      ['Language: en', 3, 2], ['Language: (blank)', 1, 1], ['Language: ar', 1, 1],
    ].sort((a, b) => (b[1] as number) - (a[1] as number) || String(a[0]).localeCompare(String(b[0]))));
    const two = await seg('country_of_residence,language');
    expect(two.fields.map((f: { key: string }) => f.key)).toEqual(['country_of_residence', 'language']);
    expect(two.segments).toHaveLength(3);
    const uae = two.segments.find((s: { label: string }) => s.label.includes('UAE'));
    expect(uae).toMatchObject({ total: 3, eligible: 2, values: ['UAE', 'en'] });
    expect(uae.sampleEmails).toHaveLength(3);
    const other = await seg('language,city'); // another campaign can use another combination
    expect(other.segments.some((s: { label: string }) => s.label === 'Language: en · City: Dubai')).toBe(true);
    // the same contacts, the sum of every segment is everyone
    expect(two.segments.reduce((n: number, s: { total: number }) => n + s.total, 0)).toBe(5);
    expect((await builder.get('/api/audience/segments?fields=nope')).status).toBe(400);
    expect((await builder.get('/api/audience/segments')).status).toBe(400);
    expect((await qa.get('/api/audience/segments?fields=language')).status).toBe(403);
  });
});
