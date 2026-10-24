// Browser test for the Audience page: import with preview, the 10-contact limit, exclusions, add/delete.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createTestApp } from '../src/testkit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(here, '../../../.env'));
} catch {
  /* CI provides DATABASE_URL */
}
const PORT = 3116;
const BASE = `http://127.0.0.1:${PORT}`;
const webDir = path.resolve(here, '../../web/dist');

const t = await createTestApp({ webDir });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`PASS  ${name}`); };
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL  ${msg}`);
}

const header = 'Email,First Name,Last Name,Company,Country,City,Language,Customer Since,Orders,VIP,Marketing Permission';
const row = (n: number, perm = 'yes') => `person${n}@example.com,First${n},Last${n},Acme,UAE,Dubai,en,2024-05-01,${n},no,${perm}`;
const csv = (from: number, count: number, extra: string[] = []) => [header, ...Array.from({ length: count }, (_, i) => row(from + i, from + i === 3 ? 'no' : 'yes')), ...extra].join('\n');

const browser = await chromium.launch();
try {
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const open = async (role: 'admin' | 'builder' | 'qa_reviewer') => {
    const client = await t.sessionFor(await t.seedUser(role, { totp: true }));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: 'cl_session', value: client.sessionToken!, url: BASE }]);
    return await ctx.newPage();
  };

  const page = await open('builder');
  await page.goto(`${BASE}/`);
  await page.getByRole('link', { name: 'Audience' }).click();
  await page.getByRole('heading', { name: 'Audience' }).waitFor();
  await page.getByText('0 of 10 contacts stored').waitFor();
  ok('a Builder sees the Audience page with the 0 of 10 counter');

  // ---- preview first, then import
  const four = csv(1, 4, ['bad-address,Nope,Nope,,,,,,,,']);
  await page.locator('input[type="file"]').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(four) });
  const prev = page.getByTestId('import-preview');
  await prev.waitFor();
  assert((await prev.getByRole('group', { name: 'What will happen' }).innerText()).replace(/\s+/g, ' ').includes('4 will be added'), 'preview says 4 will be added');
  assert((await prev.getByText(/Line 6/).count()) === 1, 'the bad row is named by line number');
  assert((await page.getByText('0 of 10 contacts stored').count()) === 1, 'previewing saved nothing');
  assert((await prev.getByLabel('Column for Email address').inputValue()) === 'Email', 'columns were matched automatically');
  await page.getByRole('button', { name: 'Import 4 contacts' }).click();
  await page.getByText('4 of 10 contacts stored').waitFor();
  await page.getByText(/Imported: 4 added/).waitFor();
  ok('the preview saves nothing and names the bad row; importing saves the good ones');

  // ---- exclusions are shown
  await page.getByText('4 of 10 contacts stored').waitFor();
  const no = page.locator('tr', { hasText: 'person3@example.com' });
  assert((await no.getByText('No marketing permission').count()) === 1, 'a contact without permission is marked as excluded');
  assert((await page.getByText('3 eligible').count()) === 1, 'eligible count excludes the contact without permission');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Mark person1@example.com as unsubscribed' }).click();
  await page.getByText('2 eligible').waitFor();
  assert((await page.locator('tr', { hasText: 'person1@example.com' }).getByText('Unsubscribed').count()) >= 1, 'unsubscribed is shown');
  ok('contacts without permission or who unsubscribed are shown as excluded and not counted as eligible');

  // ---- the limit of 10
  await page.locator('input[type="file"]').setInputFiles({ name: 'more.csv', mimeType: 'text/csv', buffer: Buffer.from(csv(10, 9)) });
  await prev.waitFor();
  const stats = (await prev.getByRole('group', { name: 'What will happen' }).innerText()).replace(/\s+/g, ' ');
  assert(stats.includes('6 will be added') && stats.includes('3 over the limit'), `limit shown in the preview (${stats})`);
  await page.getByRole('button', { name: 'Import 6 contacts' }).click();
  await page.getByText('10 of 10 contacts stored').waitFor();
  assert(await page.getByRole('button', { name: 'Add a contact' }).isDisabled(), 'adding by hand is disabled when full');
  ok('the 10-contact limit holds: extra rows are reported and not saved, and Add is disabled when full');

  // ---- delete frees a place; add by hand
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete person10@example.com' }).click();
  await page.getByText('9 of 10 contacts stored').waitFor();
  await page.getByRole('button', { name: 'Add a contact' }).click();
  await page.getByRole('dialog').getByLabel(/Email address/).fill('hand.added@example.com');
  await page.getByRole('dialog').getByLabel(/First name/).fill('Hand');
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await page.getByText('10 of 10 contacts stored').waitFor();
  await page.getByText('hand.added@example.com').waitFor();
  ok('deleting frees a place and a contact can be added by hand');

  // ---- segments by the fields you choose (built-in and your own)
  const seg = page.getByTestId('segments');
  await seg.getByRole('button', { name: 'Country', exact: true }).click();
  await seg.getByRole('button', { name: 'Language', exact: true }).click();
  await seg.getByText(/segments? from 10 contacts/).waitFor();
  assert((await seg.locator('thead th').allInnerTexts()).slice(0, 2).join('|') === 'Country|Language', 'the chosen fields are the columns, in the order chosen');
  assert((await seg.locator('tbody tr').count()) === 2, 'one segment for UAE and en, and one for the contact added by hand with those fields blank');
  assert((await seg.getByText('(blank)').count()) >= 1, 'blank values are shown as (blank)');
  await seg.getByRole('button', { name: /Country/ }).click(); // choose another combination for another campaign
  await seg.getByRole('button', { name: 'City', exact: true }).click();
  await seg.locator('thead th', { hasText: 'City' }).waitFor(); // wait for the new table, not the old one
  assert((await seg.locator('thead th').allInnerTexts()).slice(0, 2).join('|') === 'Language|City', 'a different combination works');
  ok('segments can be built from any chosen fields and changed for another campaign');

  // ---- an Admin raises the limit, a Builder cannot see the setting
  assert((await page.getByLabel('Most contacts that can be stored').count()) === 0, 'a Builder does not see the limit setting');
  const adm = await open('admin');
  await adm.goto(`${BASE}/audience`);
  await adm.getByLabel('Most contacts that can be stored').fill('12');
  await adm.getByRole('button', { name: 'Save limit' }).click();
  await adm.getByText('10 of 12 contacts stored').waitFor();
  await page.reload();
  await page.getByText('10 of 12 contacts stored').waitFor();
  assert(await page.getByRole('button', { name: 'Add a contact' }).isEnabled(), 'adding is possible again after the limit is raised');
  ok('an Admin can raise the limit; the counter and Add button follow');

  // ---- a campaign chooses its segment fields, makes a test audience, and previews as a segment
  await page.goto(`${BASE}/`);
  await page.getByLabel('Campaign name').fill('Segment test campaign');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('region', { name: 'Email canvas' }).waitFor();
  await page.getByRole('tab', { name: 'Audience' }).click();
  const fieldsGroup = page.getByRole('group', { name: 'Fields that segment this campaign' });
  await fieldsGroup.getByRole('button', { name: 'Country', exact: true }).click();
  await fieldsGroup.getByRole('button', { name: /Language/ }).click();
  await page.locator('td strong', { hasText: 'UAE-en' }).first().waitFor(); // named from the values in the order chosen
  await page.getByRole('button', { name: 'Make the test audience', exact: true }).click();
  const tests = page.getByTestId('test-audience');
  await tests.locator('td strong', { hasText: 'UAE-en' }).waitFor();
  assert((await tests.getByText(/\.invalid/).count()) >= 1, 'test contacts use made-up addresses');
  await page.getByRole('tab', { name: 'Preview' }).click();
  const who = page.getByLabel('Preview as');
  await who.locator('optgroup[label^="Test audience"] option', { hasText: 'UAE-en' }).first().waitFor({ state: 'attached' });
  const value = await who.locator('optgroup[label^="Test audience"] option', { hasText: 'UAE-en' }).first().getAttribute('value');
  await who.selectOption(value!);
  await page.getByTestId('previewing-as').getByText('UAE-en (test contact)').waitFor();
  ok('a campaign chooses its segment fields, makes a test audience named like UAE-en, and previews as that segment');

  // ---- QA reviewers have no Audience
  const qa = await open('qa_reviewer');
  await qa.goto(`${BASE}/`);
  await qa.getByRole('heading', { name: 'Campaigns', exact: true }).waitFor();
  assert((await qa.getByRole('link', { name: 'Audience' }).count()) === 0, 'no Audience link for a QA reviewer');
  await qa.goto(`${BASE}/audience`);
  await qa.getByRole('heading', { name: 'Campaigns', exact: true }).waitFor();
  ok('a QA reviewer has no Audience page');

  console.log(`\n${passed} audience checks passed`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await t.close();
}
