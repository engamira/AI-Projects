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
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
    return pg;
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

  // ---- segments by the fields you choose (built-in and your own): one drop-down per field
  const seg = page.getByTestId('segments');
  await seg.locator('#explorer-0').selectOption({ label: 'Country' });
  await seg.locator('#explorer-1').selectOption({ label: 'Language' });
  await seg.getByText(/segments? from 10 contacts/).waitFor();
  assert((await seg.locator('thead th').allInnerTexts()).slice(0, 2).join('|') === 'Country|Language', 'the chosen fields are the columns, in the order chosen');
  assert((await seg.locator('tbody tr').count()) === 2, 'one segment for UAE and en, and one for the contact added by hand with those fields blank');
  assert((await seg.getByText('(blank)').count()) >= 1, 'blank values are shown as (blank)');
  await seg.locator('#explorer-0').selectOption(''); // remove Country: Language moves up
  await seg.locator('#explorer-1').selectOption({ label: 'City' });
  await seg.locator('thead th', { hasText: 'City' }).waitFor(); // wait for the new table, not the old one
  assert((await seg.locator('thead th').allInnerTexts()).slice(0, 2).join('|') === 'Language|City', 'a different combination works');
  ok('segments can be built from any chosen fields with one drop-down each, and changed for another campaign');

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

  // ---- a campaign opens on Segments; the build choice comes first and decides what follows
  await page.goto(`${BASE}/`);
  await page.getByLabel('Email name').fill('Segment test campaign');
  await page.getByLabel('Use the multilingual editor').uncheck(); // these checks cover the previous editor
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('heading', { name: 'How will you build the versions?' }).waitFor(); // a new campaign opens on Segments: who it is for comes first
  const tabNames = await page.getByRole('tab').allInnerTexts();
  assert(tabNames.slice(0, 2).join('|') === 'Segments|Email', `the tabs start with Segments, then Email (got ${tabNames.join('|')})`);
  assert((await page.getByText(/Step 1|Step 2/).count()) === 0, 'no step wording');
  assert((await page.locator('#campaign-seg-0').count()) === 0, 'nothing else shows until the build choice is made');
  ok('a new campaign opens on Segments (before Email) and shows only the build choice until one is chosen');

  // ---- choice 2: a separate copy per segment, with up to 10 fields
  await page.getByRole('radio', { name: /A separate copy for each segment/ }).check();
  await page.locator('#campaign-seg-0').selectOption({ label: 'Country' });
  await page.locator('#campaign-seg-1').selectOption({ label: 'Language' });
  await page.locator('td strong', { hasText: 'UAE-en' }).first().waitFor(); // named from the values in the order chosen

  // a field of my own can be added right here and used straight away
  await page.getByRole('button', { name: '＋ Add a field of my own' }).click();
  await page.getByLabel('New field name').fill('Interest');
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.locator('#campaign-seg-2').locator('option', { hasText: 'Interest (my field)' }).waitFor({ state: 'attached' });

  const tests = page.getByTestId('test-audience');
  await tests.getByLabel('Values for Country').fill('UAE');
  await tests.getByLabel('Values for Language').fill('en, ar');
  await page.getByRole('button', { name: 'Build test audience' }).click();
  await tests.locator('td strong', { hasText: 'UAE-ar' }).waitFor();
  await tests.getByLabel('Values for Country').fill('FR');
  await tests.getByLabel('Values for Language').fill('fr');
  await page.getByRole('button', { name: 'Build test audience' }).click();
  await tests.locator('td strong', { hasText: 'FR-fr' }).waitFor();
  const made = (await tests.locator('tbody td strong').allInnerTexts()).sort();
  assert(made.join(',') === 'FR-fr,UAE-ar,UAE-en', `adding FR-fr kept UAE-en and UAE-ar and added no other combination (got ${made.join(',')})`);
  assert((await tests.getByText(/\.invalid/).count()) >= 1, 'test contacts use made-up addresses');
  page.once('dialog', (dlg) => void dlg.accept());
  await page.getByRole('button', { name: 'Remove test contact FR-fr' }).click();
  await tests.locator('td strong', { hasText: 'FR-fr' }).waitFor({ state: 'detached' });

  await page.getByRole('tab', { name: 'Preview' }).click();
  const who = page.getByLabel('Preview as');
  await who.locator('optgroup[label^="Test audience"] option', { hasText: 'UAE-en' }).first().waitFor({ state: 'attached' });
  const value = await who.locator('optgroup[label^="Test audience"] option', { hasText: 'UAE-en' }).first().getAttribute('value');
  await who.selectOption(value!);
  await page.getByTestId('previewing-as').getByText('UAE-en (test contact)').waitFor();
  ok('choice 2: a campaign chooses its segment fields, adds its own field, builds a test audience step by step, and previews as UAE-en');

  // ---- one email per segment: a Default version plus an independent copy for UAE-ar
  await page.getByRole('tab', { name: 'Email' }).click();
  await page.getByRole('button', { name: 'Add Text to the end of the email' }).click();
  await page.getByLabel('Heading', { exact: true }).fill('Default heading');
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByRole('button', { name: 'Create a version for UAE-ar' }).click(); // opens the Email tab on the new version
  const bar = page.getByTestId('version-bar');
  await bar.getByText('You are editing the UAE-ar version').waitFor();
  await page.locator('[data-block-type="text"]').last().click();
  const copied = await page.getByLabel('Heading', { exact: true }).inputValue();
  assert(copied === 'Default heading', `a new version starts as a copy of the Default (got "${copied}")`);
  await page.getByLabel('Heading', { exact: true }).fill('Arabic heading');
  await bar.getByLabel('Editing version').selectOption({ label: 'Default version' });
  await page.locator('[data-block-type="text"]').last().click();
  assert((await page.getByLabel('Heading', { exact: true }).inputValue()) === 'Default heading', 'editing a version never changes the Default');
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('tab', { name: 'Preview' }).click();
  const who2 = page.getByLabel('Preview as');
  const arId = await who2.locator('optgroup[label^="Test audience"] option', { hasText: 'UAE-ar' }).first().getAttribute('value');
  await who2.selectOption(arId!);
  await page.getByTestId('shown-version').getByText('UAE-ar version').waitFor();
  const enId = await who2.locator('optgroup[label^="Test audience"] option', { hasText: 'UAE-en' }).first().getAttribute('value');
  await who2.selectOption(enId!);
  await page.getByTestId('shown-version').getByText('Default version').waitFor();
  ok('a segment gets its own independent version; contacts of other segments get the Default');

  // ---- "Which email each segment receives": send UAE-en the UAE-ar version too
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByLabel('Email for UAE-en').selectOption({ label: 'UAE-ar version' });
  await page.getByText('set by you').first().waitFor();
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.getByLabel('Preview as').selectOption(enId!);
  await page.getByTestId('shown-version').getByText('UAE-ar version').waitFor();
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByLabel('Email for UAE-en').selectOption({ index: 0 }); // back to the automatic choice
  await page.getByText('All changes saved').waitFor();
  assert((await page.getByText('set by you').count()) === 0, 'the automatic choice has no "set by you" note');
  ok('a segment can be sent the email of another segment, and put back to the automatic choice');

  // removing the test contact of a segment that has its own version removes the segment and that version
  page.once('dialog', (dlg) => void dlg.accept());
  await page.getByTestId('test-audience').getByRole('button', { name: 'Remove test contact UAE-ar' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('td')].some((td) => (td.textContent ?? '').startsWith('UAE-ar'))); // gone from the test audience and the mapping
  await page.getByRole('tab', { name: 'Email' }).click();
  assert((await page.getByTestId('version-bar').getByLabel('Editing version').locator('option', { hasText: 'UAE-ar' }).count()) === 0, 'the deleted segment has no version any more');
  await page.getByRole('tab', { name: 'Segments' }).click();
  ok('removing a test contact deletes its segment and the version written for it');

  // ---- choice 1: one email per language, with show/hide conditions that add segments
  await page.goto(`${BASE}/`);
  await page.getByLabel('Email name').fill('Language campaign');
  await page.getByLabel('Use the multilingual editor').uncheck(); // these checks cover the previous editor
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('radio', { name: /One email per language/ }).click();
  await page.locator('#campaign-seg-0').waitFor();
  await page.locator('#campaign-seg-0 option:checked', { hasText: 'Language' }).waitFor({ state: 'attached' }); // Language is selected as the one segment field
  assert((await page.locator('#campaign-seg-1').count()) === 0, 'only one segment field can be chosen');
  const tests2 = page.getByTestId('test-audience');
  await tests2.getByLabel('Languages', { exact: true }).fill('en, ar');
  await page.getByRole('button', { name: 'Build test audience' }).click();
  await tests2.getByRole('cell', { name: 'ar', exact: true }).waitFor();
  await page.getByLabel('Create the email for ar').selectOption({ label: 'The Default email' }); // the languages come from the test audience; a copy of the English Default
  await page.getByTestId('version-bar').getByText('You are editing the ar email').waitFor();
  await page.getByRole('button', { name: 'Add Text to the end of the email' }).click();
  await page.getByLabel('Heading', { exact: true }).fill('UAE only');
  await page.getByLabel('Who sees this block').selectOption('some');
  await page.getByTestId('show-when').getByLabel('Value').fill('UAE'); // Country is UAE (any contact field can be used)
  await page.getByTestId('cond-badge').getByText('Only when Country is UAE').waitFor();
  await page.getByRole('button', { name: 'Add Text to the end of the email' }).click();
  await page.getByLabel('Heading', { exact: true }).fill('SA only');
  await page.getByLabel('Who sees this block').selectOption('some');
  await page.getByTestId('show-when').getByLabel('Value').fill('SA, EG'); // several values in one box: two segments, not one
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByRole('heading', { name: 'Segments & Email Mapping' }).waitFor();
  for (const code of ['UAE-ar', 'SA-ar', 'EG-ar', 'FR-ar']) await page.getByRole('cell', { name: new RegExp(`^${code}`) }).first().waitFor();
  assert((await page.getByRole('cell', { name: /^Default-ar/ }).count()) === 0, 'no Default-ar segment: the control segment is named after a value no rule mentions (FR-ar)');
  await page.getByText('ar email').first().waitFor();
  await page.getByTestId('email-kinds').getByText(/first email you create, in English/).waitFor();
  assert((await page.getByRole('cell', { name: /SA, EG/ }).count()) === 0, 'comma separated values make separate segments');
  await tests2.getByRole('cell', { name: 'FR-ar', exact: true }).waitFor({ timeout: 30000 }); // test contacts for the new segments are made for you
  assert((await tests2.getByRole('cell', { name: 'Default-ar', exact: true }).count()) === 0, 'no Default-ar test contact: "ar" covers it');
  ok('block conditions add segments (UAE-ar, SA-ar, EG-ar from "SA, EG", Default-ar) to the Segments tab and their test contacts are built');

  // a language added in "Which email each segment receives" also gets its test contact
  await page.locator('#typed-language').fill('fr, de'); // several languages, separated by commas
  await page.getByRole('button', { name: 'Create this email' }).click();
  await tests2.getByRole('cell', { name: 'fr', exact: true }).waitFor();
  await tests2.getByRole('cell', { name: 'de', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit the de email' }).waitFor(); // and their language emails
  ok('a language added in the mapping section appears in the test audience');

  // removing a test contact removes its segment everywhere, and it is not rebuilt
  page.once('dialog', (dlg) => void dlg.accept());
  await tests2.getByRole('button', { name: 'Remove test contact EG-ar' }).click();
  await tests2.getByRole('cell', { name: 'EG-ar', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('cell', { name: /^EG-ar/ }).waitFor({ state: 'detached' });
  await page.waitForTimeout(3500); // longer than the pause before missing test contacts are built
  assert((await page.getByRole('cell', { name: /^EG-ar/ }).count()) === 0, 'the removed segment is not rebuilt');
  ok('removing a test contact removes its segment from the lists and the mapping');

  // the Email tab lists the segments made by rules; choosing one dims the blocks it does not see
  await page.getByRole('tab', { name: 'Email' }).click();
  const editingVersion = page.getByTestId('version-bar').getByLabel('Editing version');
  await editingVersion.locator('option', { hasText: 'UAE-ar' }).waitFor({ state: 'attached' });
  assert((await editingVersion.locator('option', { hasText: 'EG-ar' }).count()) === 0, 'a removed segment is not in the editing drop-down');
  assert((await editingVersion.locator('option', { hasText: 'Default-ar' }).count()) === 0, 'Default-ar is not in the editing drop-down');
  await editingVersion.selectOption({ label: 'ar email' });
  await editingVersion.selectOption({ label: 'UAE-ar' });
  await page.getByTestId('hidden-for').first().waitFor();
  assert((await page.getByTestId('hidden-for').first().innerText()).includes('UAE-ar'), 'blocks the segment does not see are marked');
  ok('segments made by rules are in the editing drop-down; their hidden blocks are dimmed');

  await page.getByRole('tab', { name: 'Preview' }).click();
  const shownFor = async (code: string, match: string | RegExp = code): Promise<{ shown: number; total: number }> => {
    const id = await page.getByLabel('Preview as').locator('optgroup[label^="Test audience"] option', { hasText: match }).first().getAttribute('value');
    await page.getByLabel('Preview as').selectOption(id!);
    await page.getByTestId('previewing-as').getByText(`${code} (test contact)`, { exact: true }).waitFor();
    await page.getByTestId('shown-version').getByText(/ar email/).waitFor();
    const m = /ar email · (\d+) of (\d+) blocks/.exec(await page.getByTestId('shown-version').innerText());
    assert(!!m, `the version label shows block counts for ${code}`);
    return { shown: Number(m![1]), total: Number(m![2]) };
  };
  const uae = await shownFor('UAE-ar');
  const def = await shownFor('FR-ar'); // the control segment: a country no rule mentions
  assert(uae.total === def.total && uae.shown === uae.total - 1 && def.shown === def.total - 2, `UAE sees one conditional block, any other country none (got ${uae.shown}/${uae.total} and ${def.shown}/${def.total})`);
  ok('Preview as lists the new segments and hides blocks whose condition they do not meet');

  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByLabel('Email for SA-ar').selectOption({ label: 'Default email' });
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('tab', { name: 'Preview' }).click();
  const saId = await page.getByLabel('Preview as').locator('optgroup[label^="Test audience"] option', { hasText: 'SA-ar' }).first().getAttribute('value');
  await page.getByLabel('Preview as').selectOption(saId!);
  await page.getByTestId('shown-version').getByText(/Default email/).waitFor();
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByTestId('segments-next').click();
  await page.getByTestId('version-bar').waitFor(); // Next goes to the Email tab
  ok('a conditional segment can be sent the Default email instead; Next opens the Email tab');

  // Next on every tab; "Preview as" stays in view; the Versions tab lists segments with a quick view
  await page.getByTestId('next-tab').click();
  await page.getByLabel('Preview as').waitFor();
  await page.locator('.tab-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const box = await page.getByLabel('Preview as').boundingBox();
  assert(!!box && box.y >= 0 && box.y < 250, `Preview as stays in view while scrolling (y=${box?.y})`);
  await page.getByTestId('next-tab').click(); // the Preview tab's Next is at the end of the page
  await page.getByTestId('segment-overview').waitFor();
  await page.getByTestId('segment-overview').getByRole('button', { name: /^UAE-ar/ }).click();
  await page.getByTestId('segment-view').getByText('UAE-ar (test contact)').waitFor();
  await page.getByTestId('segment-overview').getByRole('button', { name: /^SA-ar/ }).click();
  await page.getByTestId('segment-view').getByText('SA-ar (test contact)').waitFor();
  ok('Next moves through Segments, Email, Preview and Versions; Preview as stays in view; Versions lists segments with a quick preview');

  // ---- QA reviewers have no Audience
  const qa = await open('qa_reviewer');
  await qa.goto(`${BASE}/`);
  await qa.getByRole('heading', { name: 'Emails', exact: true }).waitFor();
  assert((await qa.getByRole('link', { name: 'Audience' }).count()) === 0, 'no Audience link for a QA reviewer');
  await qa.goto(`${BASE}/audience`);
  await qa.getByRole('heading', { name: 'Emails', exact: true }).waitFor();
  ok('a QA reviewer has no Audience page');

  console.log(`\n${passed} audience checks passed`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await t.close();
}
