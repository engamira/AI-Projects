// Phase C: the whole workflow with English, Arabic and German and the UAE / VIP rules, in the browser.
// Saves screenshots (set E2E_SHOTS_DIR, default <repo>/validation/phase-c) and checks the behaviours of the consistency pass:
// keyboard tabs, reduced motion, dark mode, and a phone-width page that does not scroll sideways.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { createTestApp } from '../src/testkit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(here, '../../../.env'));
} catch {
  /* CI provides DATABASE_URL */
}
const PORT = 3119;
const BASE = `http://127.0.0.1:${PORT}`;
const webDir = path.resolve(here, '../../web/dist');
const shots = process.env.E2E_SHOTS_DIR ?? path.resolve(here, '../../../validation/phase-c');
mkdirSync(shots, { recursive: true });

const t = await createTestApp({ webDir });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`PASS  ${name}`); };
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL  ${msg}`);
}
const shot = async (p: Page, name: string) => { await p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false }); };

const browser = await chromium.launch();
try {
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const builderApi = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  const qaApi = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
  const open = async (client: typeof builderApi, opts: { width?: number; height?: number; dark?: boolean; reduced?: boolean } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1360, height: opts.height ?? 900 }, colorScheme: opts.dark ? 'dark' : 'light', reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
    await ctx.addCookies([{ name: 'cl_session', value: client.sessionToken!, url: BASE }]);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
    p.on('dialog', (d) => void d.accept());
    return p;
  };
  const page = await open(builderApi);

  // ---- 1. languages and the English master email
  await page.goto(`${BASE}/`);
  await page.getByLabel('Email name').fill('Autumn offers');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('heading', { name: 'Languages list' }).waitFor();
  await page.getByLabel('Languages', { exact: true }).fill('English, Arabic, German');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText('Languages updated.').waitFor();
  await shot(page, '01-segments-languages');
  await page.getByRole('button', { name: 'Create English-Email' }).click();
  await page.getByTestId('email-title').getByText('English-Email').waitFor();

  // a block for VIP customers in the UAE: show when Country is UAE AND VIP is yes
  await page.getByRole('button', { name: 'Add Text to the end of the email' }).click();
  await page.getByLabel('Heading', { exact: true }).fill('VIP offer for the UAE');
  await page.getByRole('button', { name: '＋ Add a show/hide rule' }).click();
  await page.getByTestId('show-when').getByLabel('Value').fill('UAE');
  await page.getByTestId('show-when').getByRole('button', { name: '＋ Add a rule' }).click();
  await page.getByTestId('show-when').getByLabel('Field').nth(1).selectOption({ label: 'VIP' });
  // a block hidden from the UAE: hide when Country is UAE
  await page.getByRole('button', { name: 'Add Text to the end of the email' }).click();
  await page.getByLabel('Heading', { exact: true }).fill('Our standard offer');
  await page.getByRole('button', { name: '＋ Add a show/hide rule' }).click();
  await page.getByLabel('Rule 1: show or hide').selectOption('hide');
  await page.getByTestId('show-when').getByLabel('Value').fill('UAE');
  await page.getByText('All changes saved').waitFor();
  await page.goto(`${BASE}${new URL(page.url()).pathname}?tab=emails&lang=en`); // nothing selected: the email settings show
  await page.getByLabel('Subject line').fill('Autumn offers for you');
  await page.getByLabel('Preview text (preheader)').fill('Fares from Dubai');
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByText(/Saved as revision \d+\./).waitFor();
  await shot(page, '02-emails-english-rules');
  ok('English-Email: two blocks with a UAE+VIP show rule and a UAE hide rule, saved as a revision');

  // ---- 2. Arabic and German are cloned from English, then translated
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByLabel('Create Arabic-Email from').selectOption({ label: 'English-Email' });
  await page.getByTestId('email-title').getByText('Arabic-Email').waitFor();
  await page.locator('[data-block-type="text"]').nth(-2).click();
  await page.getByLabel('Heading', { exact: true }).fill('عرض خاص لعملاء VIP في الإمارات');
  await page.locator('[data-block-type="text"]').last().click();
  await page.getByLabel('Heading', { exact: true }).fill('عرضنا المعتاد');
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByText(/Saved as revision 2\./).waitFor();
  await page.getByRole('tab', { name: 'Segments' }).click();
  await page.getByLabel('Create German-Email from').selectOption({ label: 'English-Email' });
  await page.getByTestId('email-title').getByText('German-Email').waitFor();
  await page.locator('[data-block-type="text"]').nth(-2).click();
  await page.getByLabel('Heading', { exact: true }).fill('VIP-Angebot für die VAE');
  await page.locator('[data-block-type="text"]').last().click();
  await page.getByLabel('Heading', { exact: true }).fill('Unser Standardangebot');
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByText(/Saved as revision 2\./).waitFor();
  ok('Arabic-Email and German-Email are cloned from English-Email (blocks and rules), translated, and saved with their own revisions');

  // ---- 3. the same saved emails appear in every tab
  await page.getByRole('tab', { name: 'Segments' }).click();
  const names = await page.getByTestId('email-list').locator('td strong').allInnerTexts();
  assert(names.join() === 'English-Email,Arabic-Email,German-Email', 'Segments lists the three emails');
  const derived = page.getByTestId('derived-segments');
  for (const n of ['UAE VIP English Segment', 'Not UAE English Segment', 'UAE VIP Arabic Segment', 'UAE VIP German Segment']) await derived.getByText(n).waitFor();
  await shot(page, '03-segments-derived');
  await page.getByRole('tab', { name: 'Audiences' }).click();
  await page.getByRole('heading', { name: /^German/ }).waitFor();
  for (const n of ['en-Audience', 'ar-Audience', 'de-Audience', 'UAE VIP Arabic-Audience', 'Not UAE German-Audience', 'UAE English-Audience']) await page.getByTestId('audience-card').filter({ hasText: n }).first().waitFor();
  await shot(page, '04-audiences');
  ok('every language has a baseline audience, and the UAE / VIP rules gave positive, negative and hide audiences in each language');

  // ---- 4. preview: the rules decide, and say why; Arabic reads right to left
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.getByLabel('Email version').selectOption({ label: 'Arabic-Email' });
  await page.getByLabel('Test audience').selectOption({ label: 'UAE VIP Arabic-Audience' });
  const phone = page.frameLocator('iframe[title="Phone preview"]');
  await phone.getByText('عرض خاص لعملاء VIP في الإمارات').first().waitFor();
  assert((await phone.locator('html[dir="rtl"]').count()) === 1, 'the Arabic preview is right to left');
  assert((await phone.getByText('عرضنا المعتاد').count()) === 0, 'the hide rule removed the standard offer for the UAE');
  await shot(page, '05-preview-arabic-uae-vip');
  await page.getByLabel('Test audience').selectOption({ label: 'Not UAE Arabic-Audience' });
  await page.getByTestId('previewing-as').getByText('Not UAE Arabic-Audience (test audience)').waitFor();
  await phone.getByText('عرضنا المعتاد').first().waitFor();
  await shot(page, '06-preview-arabic-not-uae');
  await page.getByLabel('Email version').selectOption({ label: 'German-Email' });
  await page.getByLabel('Test audience').selectOption({ label: 'UAE VIP German-Audience' });
  await page.getByTestId('previewing-as').getByText('UAE VIP German-Audience (test audience)').waitFor();
  await phone.getByText('VIP-Angebot für die VAE').first().waitFor();
  ok('Preview uses the same rules as the segments and audiences, in Arabic (right to left) and German');

  // ---- 5. versions and QA
  await page.getByRole('tab', { name: 'Versions' }).click();
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'German' }).click();
  await page.getByTestId('revision-row').nth(1).waitFor();
  await page.getByRole('button', { name: 'Send to QA' }).click();
  await page.getByTestId('versions-message').filter({ hasText: 'Revision 2 of German-Email was sent to QA.' }).waitFor();
  await shot(page, '07-versions-send-to-qa');
  const campaignId = new URL(page.url()).pathname.split('/').pop()!;
  const qa = await open(qaApi);
  await qa.goto(`${BASE}/campaigns/${campaignId}?tab=qa&lang=de`);
  await qa.getByRole('button', { name: 'Run QA checks' }).click();
  await qa.getByTestId('qa-message').filter({ hasText: 'QA checks finished.' }).waitFor();
  await shot(qa, '08-qa-findings');
  await qa.goto(`${BASE}/settings`);
  await qa.getByRole('heading', { name: 'Hidden QA findings' }).waitFor();
  await shot(qa, '09-app-settings');
  ok('German revision 2 is sent to QA; QA runs the checks; App Settings opens');

  // ---- 6. B5: keyboard, motion, dark mode, phone width
  await page.goto(`${BASE}/campaigns/${campaignId}?tab=segments`);
  await page.getByRole('tab', { name: 'Segments' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('tab', { name: 'Emails', selected: true }).waitFor();
  await page.keyboard.press('End');
  await page.getByRole('tab', { name: 'Builder to Check', selected: true }).waitFor();
  await page.keyboard.press('Home');
  await page.getByRole('tab', { name: 'Segments', selected: true }).waitFor();
  ok('the tab strip works with the arrow keys, Home and End');

  const calm = await open(builderApi, { reduced: true });
  await calm.goto(`${BASE}/campaigns/${campaignId}?tab=audiences`);
  await calm.getByTestId('audience-card').first().waitFor();
  const seconds = await calm.getByRole('tab', { name: 'Emails' }).evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  assert(seconds < 0.001, `no animation when reduced motion is asked for (${seconds}s)`);
  const normal = await page.getByRole('tab', { name: 'Emails' }).evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  assert(normal > 0.1 && normal < 0.25, `controls change smoothly in about 170 ms (${normal}s)`);
  ok('hover changes take about 170 ms, and none at all when reduced motion is on');

  const dark = await open(builderApi, { dark: true });
  await dark.goto(`${BASE}/campaigns/${campaignId}?tab=audiences`);
  await dark.getByTestId('audience-card').first().waitFor();
  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(bg !== 'rgb(250, 246, 246)', `dark mode follows the device (${bg})`);
  await shot(dark, '10-audiences-dark');
  await dark.goto(`${BASE}/campaigns/${campaignId}?tab=qa&lang=de`);
  await dark.getByTestId('qa-row').first().waitFor();
  await shot(dark, '11-qa-dark');
  ok('dark mode');

  const phoneUser = await open(builderApi, { width: 390, height: 844 });
  for (const tab of ['segments', 'emails', 'audiences', 'preview', 'versions', 'qa', 'check']) {
    await phoneUser.goto(`${BASE}/campaigns/${campaignId}?tab=${tab}&lang=de`);
    await phoneUser.locator('.tabs').waitFor();
    await phoneUser.waitForTimeout(700);
    const over = await phoneUser.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, body: Math.max(...[...document.querySelectorAll<HTMLElement>('.tab-body')].map((e) => e.scrollWidth - e.clientWidth), 0) }));
    assert(over.page <= 1 && over.body <= 1, `the ${tab} tab does not scroll sideways on a phone (page ${over.page}px, content ${over.body}px)`);
    if (tab === 'segments' || tab === 'audiences' || tab === 'qa') await shot(phoneUser, `12-phone-${tab}`);
  }
  ok('on a phone (390 px) none of the seven tabs scrolls sideways');

  // ---- 7. empty states
  const empty = (await builderApi.post('/api/campaigns', { name: 'Nothing yet', palette: 'travel', model: 'v2' })).body;
  for (const [tab, text] of [['preview', /No email has been created yet/], ['versions', /No email has been created yet/], ['qa', /Nothing has been sent to QA yet|Loading/], ['check', /Nothing is waiting for you/]] as const) {
    await page.goto(`${BASE}/campaigns/${empty.id}?tab=${tab}`);
    await page.getByText(text).first().waitFor();
  }
  ok('empty emails show clear messages instead of blank screens');

  console.log(`\n${passed} walk-through checks passed. Screenshots: ${shots}`);
} finally {
  await browser.close();
  await t.close();
}
