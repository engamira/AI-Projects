// Browser test for the language workflow: languages list, English-Email, clone to German and Arabic, separate revisions, upgrade.
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
const PORT = 3117;
const BASE = `http://127.0.0.1:${PORT}`;
const webDir = path.resolve(here, '../../web/dist');
const shots = process.env.E2E_SHOTS_DIR;

const t = await createTestApp({ webDir });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`PASS  ${name}`); };
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL  ${msg}`);
}

const browser = await chromium.launch();
try {
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const client = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addCookies([{ name: 'cl_session', value: client.sessionToken!, url: BASE }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  page.on('dialog', (d) => void d.accept());

  // ---- a new email uses the multilingual editor and starts on Segments with English only
  await page.goto(`${BASE}/`);
  await page.getByLabel('Email name').fill('Autumn offers');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('heading', { name: 'Languages list' }).waitFor();
  assert((await page.getByTestId('language-chips').innerText()).trim() === 'English', 'only English at first');
  assert((await page.getByRole('tab').allInnerTexts()).join('|') === 'Segments|Emails|Audiences|Preview|Versions|QA|Builder to Check', 'the seven tabs in order');
  ok('a new email opens on Segments with English only and the seven tabs');

  // ---- languages: bad input is refused, a list is applied, English stays first
  await page.getByLabel('Languages', { exact: true }).fill('Arabic, Klingon');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText('Not a language we support: Klingon.').waitFor();
  await page.getByLabel('Languages', { exact: true }).fill('german, Arabic, English, arabic');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText(/Listed more than once: Arabic/).waitFor();
  assert((await page.getByTestId('language-chips').innerText()).replace(/\s+/g, ' ').trim() === 'English German Arabic', 'English first, then the order typed, duplicates dropped');
  assert((await page.getByTestId('email-list').locator('td strong').allInnerTexts()).join(',') === 'English-Email,German-Email,Arabic-Email', 'one row per language, named Language-Email');
  ok('typed languages are checked, de-duplicated and listed with English first');

  // ---- English-Email: Create, then Arabic and German are cloned from it
  await page.getByRole('button', { name: 'Create English-Email' }).click();
  await page.getByTestId('email-title').getByText('English-Email').waitFor();
  await page.getByText('Latest saved: revision 1').waitFor();
  await page.getByRole('button', { name: 'Add Text to the end of the email' }).click();
  await page.getByLabel('Heading', { exact: true }).fill('Autumn offers');
  await page.getByRole('button', { name: '＋ Add a show/hide rule' }).click();
  await page.getByTestId('show-when').getByLabel('Value').fill('UAE'); // Show when Country is UAE ...
  await page.getByTestId('show-when').getByRole('button', { name: '＋ Add a rule' }).click(); // ... AND
  await page.getByTestId('show-when').getByLabel('Field').nth(1).selectOption({ label: 'VIP' }); // VIP is yes
  await page.getByTestId('show-when').getByLabel('Join rule 1 and 2 with').waitFor();
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByText('Saved as revision 2.').waitFor();
  ok('English-Email is created, edited with a rule, and saved as revision 2');

  await page.getByRole('tab', { name: 'Segments' }).click();
  const derived = page.getByTestId('derived-segments');
  await derived.getByText('UAE VIP English Segment').waitFor(); // the rule made segments
  await derived.getByText('Not UAE English Segment').waitFor();
  ok('rules in English-Email create the segments UAE VIP English and Not UAE English');
  await page.getByLabel('Create German-Email from').selectOption({ label: 'English-Email' });
  await page.getByTestId('email-title').getByText('German-Email').waitFor();
  await page.getByTestId('cond-badge').getByText(/Only when .* UAE/).waitFor({ state: 'attached' }); // the rule came along
  const germanHeadings = await page.locator('[data-block-type="text"]').count();
  assert(germanHeadings >= 1, 'German-Email has the English blocks');
  await page.getByLabel('Heading', { exact: true }).waitFor({ state: 'attached' }).catch(() => undefined);
  ok('German-Email is created from English-Email with its blocks and rules');

  // ---- independence: edit the German heading, English is unchanged
  await page.locator('[data-block-type="text"]').last().click();
  await page.getByLabel('Heading', { exact: true }).fill('Herbstangebote');
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByText('Saved as revision 2.').waitFor(); // German has its own numbering
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'English' }).click();
  await page.getByTestId('email-title').getByText('English-Email').waitFor();
  await page.locator('[data-block-type="text"]').last().click();
  assert((await page.getByLabel('Heading', { exact: true }).inputValue()) === 'Autumn offers', 'English is unchanged by edits to German');
  ok('the German copy is independent and has its own revision numbers');

  // ---- test audiences follow the rules, in every language
  await page.getByRole('tab', { name: 'Audiences' }).click();
  await page.getByRole('heading', { name: /^English/ }).waitFor();
  const cards = page.getByTestId('audience-card');
  for (const n of ['en-Audience', 'UAE VIP English-Audience', 'Not UAE English-Audience', 'de-Audience', 'UAE VIP German-Audience', 'Not UAE German-Audience']) await cards.filter({ hasText: n }).first().waitFor();
  assert((await cards.filter({ hasText: 'UAE VIP English-Audience' }).first().innerText()).includes('1 hidden') === false, 'the UAE VIP audience is shown the rule block');
  assert((await cards.filter({ hasText: 'Not UAE English-Audience' }).first().innerText()).includes('1 hidden'), 'the Not UAE audience has the rule block hidden');
  ok('test audiences: a baseline per language and shown / hidden audiences for the rules, copied with the German email');

  // ---- preview: pick the email and the test audience; the same rules decide what is shown, and why
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.getByLabel('Email version').selectOption({ label: 'English-Email' });
  const phone = page.frameLocator('iframe[title="Phone preview"]');
  await page.getByLabel('Test audience').selectOption({ label: 'UAE VIP English-Audience' });
  await page.getByTestId('previewing-as').getByText('UAE VIP English-Audience (test audience)').waitFor();
  await phone.getByText('Autumn offers', { exact: true }).first().waitFor();
  const whyRows = page.getByTestId('why-row');
  assert((await whyRows.filter({ hasText: 'Shown: Show when' }).count()) >= 1, 'the why-panel explains the shown block');
  await page.getByLabel('Test audience').selectOption({ label: 'Not UAE English-Audience' });
  await page.getByTestId('previewing-as').getByText('Not UAE English-Audience (test audience)').waitFor();
  await page.waitForFunction(() => !/Autumn offers/.test(document.querySelector<HTMLIFrameElement>('iframe[title="Phone preview"]')?.srcdoc ?? 'Autumn offers'));
  assert((await whyRows.filter({ hasText: 'Hidden' }).count()) >= 1, 'the why-panel explains the hidden block');
  await page.locator('.preview-bar select').nth(2).selectOption({ label: 'Revision 1' }); // the Revision selector
  await page.getByTestId('shown-version').getByText(/saved revision/).waitFor();
  ok('Preview: choose the email and a test audience; the rule block is shown or hidden and the reason is listed; any saved revision can be previewed');

  // ---- versions: chips per language, own revisions, send any saved revision to QA
  await page.getByTestId('next-tab').click();
  await page.getByTestId('revision-list').waitFor();
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'German' }).click();
  await page.getByRole('heading', { name: 'German-Email' }).waitFor();
  await page.getByTestId('revision-row').nth(1).waitFor();
  assert((await page.getByTestId('revision-row').count()) === 2, 'German has its own two revisions');
  await page.getByTestId('qa-will-send').filter({ hasText: 'Revision 2 of German-Email will be submitted (the latest saved revision)' }).waitFor();
  await page.locator('#qa-rev').selectOption({ label: 'Revision 1' });
  await page.getByTestId('qa-will-send').filter({ hasText: 'Revision 1 of German-Email will be submitted.' }).waitFor();
  await page.getByRole('button', { name: 'Send to QA' }).click();
  await page.getByTestId('versions-message').filter({ hasText: 'Revision 1 of German-Email was sent to QA.' }).waitFor();
  await page.getByTestId('revision-row').filter({ hasText: 'Revision 1' }).getByText('Started').waitFor();
  await page.locator('#qa-rev').selectOption({ index: 0 }); // nothing chosen: the latest saved revision
  await page.getByRole('button', { name: 'Send to QA' }).click();
  await page.getByTestId('versions-message').filter({ hasText: 'Revision 2 of German-Email was sent to QA.' }).waitFor();
  await page.getByRole('button', { name: 'Send to QA' }).click();
  await page.getByText('Revision 2 is already with QA').waitFor();
  ok('Send to QA: an older revision, then the latest by default; the same revision cannot be sent twice');

  await page.getByRole('button', { name: 'Compare' }).click();
  await page.getByTestId('diff').getByText('Revision 1 → Revision 2').waitFor();
  await page.getByTestId('diff').getByText(/Herbstangebote/).waitFor();
  ok('two revisions of one language can be compared');

  // ---- Arabic is cloned from German (any saved email can be the source) and renders right to left
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByLabel('Create Arabic-Email from').selectOption({ label: 'German-Email' });
  await page.getByTestId('email-title').getByText('Arabic-Email').waitFor();
  await page.getByLabel('Live preview').check();
  const frame = page.frameLocator('[data-testid="live-preview"] iframe').first();
  await frame.locator('html[dir="rtl"]').waitFor();
  ok('Arabic-Email can be created from German-Email and previews right to left');

  // ---- guards: duplicates and removing a language that has an email
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByLabel('Languages', { exact: true }).fill('English, German');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText(/Arabic already has an email/).waitFor();
  await page.getByRole('button', { name: 'Delete Arabic-Email' }).click();
  await page.getByRole('cell', { name: 'Not created' }).first().waitFor();
  await page.getByLabel('Languages', { exact: true }).fill('English, German');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText('Languages updated.').waitFor();
  ok('a language with an email cannot be dropped until its email is deleted');

  // ---- all languages, including the ones added late
  await page.getByLabel('Languages', { exact: true }).fill('all languages');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText('26 selected.').waitFor();
  const names = await page.getByTestId('email-list').locator('td strong').allInnerTexts();
  assert(names.length === 26 && names[0] === 'English-Email' && names.includes('Italian-Email') && names.includes('Taiwanese-Email') && names.includes('Traditional Chinese-Email'), 'all 26 languages are loaded');
  if (shots) await page.screenshot({ path: path.join(shots, 'languages-segments.png'), fullPage: true });
  ok('"all languages" loads the 26 languages of the registry');

  // ---- an email made with the previous editor can be upgraded
  await page.goto(`${BASE}/`);
  await page.getByLabel('Email name').fill('Older email');
  await page.getByLabel('Use the multilingual editor').uncheck();
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('button', { name: 'Upgrade to the multilingual editor' }).click();
  await page.getByRole('heading', { name: 'Languages list' }).waitFor();
  await page.getByRole('cell', { name: 'English-Email', exact: true }).waitFor();
  assert((await page.getByTestId('email-list').getByText(/Saved · revision/).count()) === 1, 'the Default became English-Email with its history');
  ok('an email from the previous editor is upgraded: the Default becomes English-Email');

  console.log(`\n${passed} language checks passed`);
} finally {
  await browser.close();
  await t.close();
}
