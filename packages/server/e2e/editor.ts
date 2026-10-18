// Browser test for the email editor (M2). Runs the real built web app against a throwaway database schema.
// Usage: npm run e2e:editor -w @cl/server
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { createTestApp } from '../src/testkit.js';

try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));
} catch {
  /* CI provides DATABASE_URL */
}

const shots = process.env.E2E_SHOTS_DIR;
const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}`;
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const t = await createTestApp({ webDir });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`PASS  ${name}`); };
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL  ${msg}`);
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, name), fullPage: false }); };

async function drag(page: Page, from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}

async function openAs(browser: Awaited<ReturnType<typeof chromium.launch>>, userRole: 'builder' | 'admin' | 'qa_reviewer', viewport = { width: 1280, height: 800 }) {
  const user = await t.seedUser(userRole, { totp: true });
  const client = await t.sessionFor(user);
  const ctx: BrowserContext = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: 'cl_session', value: client.sessionToken!, url: BASE }]);
  return { ctx, page: await ctx.newPage() };
}

const browser = await chromium.launch();
try {
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const { page } = await openAs(browser, 'builder');
  const blocks = page.locator('.canvas-block');
  const saved = () => page.getByText('All changes saved').waitFor();

  // ---- create a campaign
  await page.goto(`${BASE}/`);
  await page.getByLabel('Campaign name').fill('E2E summer sale');
  assert((await page.getByLabel('Template colors').inputValue()) === 'travel', 'Travel colors are the default choice');
  assert((await page.getByLabel('Template colors').locator('option').allInnerTexts()).join() === 'Travel,Events,Cosmetics', 'three template color sets to choose from');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('region', { name: 'Email canvas' }).waitFor();
  assert((await blocks.count()) === 0, 'new campaign starts empty');
  ok('builder creates a campaign and opens the editor');

  // ---- add blocks: with the Add buttons, and by dragging from the library
  await page.getByRole('button', { name: 'Add Header / logo to the end of the email' }).click();
  await page.getByRole('button', { name: 'Add Hero banner to the end of the email' }).click();
  await page.getByRole('button', { name: 'Add Text to the end of the email' }).click();
  assert((await blocks.count()) === 3, 'three blocks added with the Add buttons');
  await drag(page, page.getByRole('button', { name: 'Drag Button into the email' }), page.locator('.drop-end'));
  await blocks.nth(3).waitFor();
  assert((await blocks.nth(3).getAttribute('data-block-type')) === 'button', 'dragged block lands at the end');
  await drag(page, page.getByRole('button', { name: 'Drag Divider into the email' }), blocks.nth(1));
  await page.waitForTimeout(500);
  if ((await blocks.count()) !== 5) {
    console.log('DEBUG count after second drag:', await blocks.count());
    await shot(page, 'm2-debug.png');
  }
  await page.waitForFunction(() => document.querySelectorAll('.canvas-block').length === 5);
  assert((await blocks.nth(1).getAttribute('data-block-type')) === 'divider', 'dropping on a block inserts before it');
  ok('blocks can be added with buttons and by drag and drop');

  // ---- reorder (drag and buttons), duplicate, delete, undo, redo
  const order = async () => (await blocks.evaluateAll((els) => els.map((e) => e.getAttribute('data-block-type')))).join(',');
  assert((await order()) === 'header,divider,hero,text,button', `initial order (${await order()})`);
  await blocks.nth(4).click(); // selecting a block reveals its toolbar and drag handle
  await drag(page, blocks.nth(4).getByRole('button', { name: /^Drag .* to reorder$/ }), blocks.nth(0));
  await page.waitForFunction(() => document.querySelector('.canvas-block')?.getAttribute('data-block-type') === 'button');
  assert((await order()) === 'button,header,divider,hero,text', `after drag reorder (${await order()})`);
  await blocks.nth(0).click();
  await blocks.nth(0).getByRole('button', { name: 'Move down' }).click();
  assert((await order()) === 'header,button,divider,hero,text', `after Move down (${await order()})`);
  ok('blocks can be reordered by dragging and with the arrow buttons');

  await blocks.nth(1).click();
  await blocks.nth(1).getByRole('button', { name: 'Duplicate block' }).click();
  assert((await blocks.count()) === 6, 'duplicate adds a block');
  await blocks.nth(2).getByRole('button', { name: 'Delete block' }).click();
  assert((await blocks.count()) === 5, 'delete removes a block');
  await page.getByRole('button', { name: 'Undo' }).click(); // undo delete
  assert((await blocks.count()) === 6, 'undo restores the deleted block');
  await page.getByRole('button', { name: 'Undo' }).click(); // undo duplicate
  assert((await blocks.count()) === 5, 'undo removes the duplicate');
  await page.getByRole('button', { name: 'Redo' }).click();
  assert((await blocks.count()) === 6, 'redo re-applies it');
  await page.getByRole('button', { name: 'Undo' }).click();
  assert((await order()) === 'header,button,divider,hero,text', 'order restored after undo');
  ok('duplicate, delete, undo and redo work');

  // ---- edit the hero's text and colors with the controls
  await blocks.nth(3).click();
  await page.getByLabel('Headline', { exact: true }).fill('Summer fares from AED 999');
  await page.getByLabel('Space above and below text', { exact: true }).fill('64');
  assert((await blocks.nth(3).innerText()).includes('Summer fares from AED 999'), 'canvas shows the edited headline');
  // colors are locked to the template: no color control anywhere, and the hero uses the Travel palette
  assert((await page.locator('input[type="color"]').count()) === 0, 'no color picker in the properties panel');
  assert((await page.getByText(/color/i).filter({ has: page.locator('input') }).count()) === 0, 'no color field labels');
  const heroBg = await blocks.nth(3).locator('.block-body > div').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  assert(heroBg === 'rgb(250, 135, 57)', `hero uses the Travel template color (got ${heroBg})`);
  const heroBtn = await blocks.nth(3).locator('.block-body span').filter({ hasText: 'Learn more' }).evaluate((e) => getComputedStyle(e).backgroundColor);
  assert(heroBtn === 'rgb(47, 50, 59)', `hero button uses the template button color (got ${heroBtn})`);
  const ctaBtn = await blocks.nth(1).locator('.block-body span').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  assert(ctaBtn === 'rgb(250, 135, 57)', `button block uses the template button color (got ${ctaBtn})`);
  await page.locator('.canvas-page').click({ position: { x: 4, y: 4 } }); // click outside the email: shows Email settings
  await page.getByLabel('Subject line').fill('Summer fares are here');
  await shot(page, 'm2-1-editor.png');
  await saved();
  ok('text and colors are edited with simple controls and autosaved');

  // ---- an invalid value is flagged and not saved
  await blocks.nth(3).click();
  await page.getByLabel('Button link', { exact: true }).fill('javascript:alert(1)');
  await page.getByText('must start with https://').waitFor();
  await page.getByText(/Not saved:/).waitFor();
  await page.getByLabel('Button link', { exact: true }).fill('https://example.com/summer');
  assert((await page.getByLabel('Button link alias', { exact: true }).inputValue()) === 'Hero button', 'the link alias starts with a helpful default');
  await page.getByLabel('Button link alias', { exact: true }).fill('Summer hero button');
  await saved();
  ok('an unsafe link is flagged and blocked from saving until fixed');

  // ---- close and reopen: edits are restored
  await page.reload();
  await blocks.first().waitFor();
  assert((await order()) === 'header,button,divider,hero,text', 'order survives a reload');
  assert((await blocks.nth(3).innerText()).includes('Summer fares from AED 999'), 'edited text survives a reload');
  await blocks.nth(3).click();
  assert((await page.getByLabel('Space above and below text', { exact: true }).inputValue()) === '64', 'edited spacing survives a reload');
  assert((await page.getByLabel('Button link alias', { exact: true }).inputValue()) === 'Summer hero button', 'link alias survives a reload');
  ok('reopening the email restores every edit');

  // ---- library originals and other emails are unchanged
  await page.goto(`${BASE}/`);
  await page.getByLabel('Campaign name').fill('Second email');
  await page.getByLabel('Template colors').selectOption('events');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('region', { name: 'Email canvas' }).waitFor();
  await page.getByRole('button', { name: 'Add Hero banner to the end of the email' }).click();
  assert((await blocks.nth(0).innerText()).includes('A big, clear headline'), 'a new hero starts from the original defaults');
  const eventsHero = await blocks.nth(0).locator('.block-body > div').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  assert(eventsHero === 'rgb(53, 69, 82)', `an Events email uses the Events colors (got ${eventsHero})`);
  await page.locator('.canvas-page').click({ position: { x: 4, y: 4 } });
  await page.getByText('Template colors: Events').waitFor();
  assert((await page.getByLabel('Template colors').count()) === 0, 'the template colors cannot be changed inside an email');
  ok('editing one email never changes the library original or another email');

  // ---- preview with selectable widths
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.getByText('not an Outlook or Gmail simulation').waitFor();
  const frame = page.locator('iframe[title="Email preview"]');
  await page.waitForFunction(() => (document.querySelector('iframe[title="Email preview"]') as HTMLIFrameElement | null)?.srcdoc.includes('A big, clear headline'));
  assert((await frame.getAttribute('sandbox')) === '', 'preview iframe is fully sandboxed (no scripts)');
  assert((await frame.evaluate((f) => (f as HTMLElement).getBoundingClientRect().width)) === 375, 'default preview width is a phone');
  await page.getByLabel('Width').selectOption('1024');
  assert((await frame.evaluate((f) => (f as HTMLElement).getBoundingClientRect().width)) === 1024, 'preview width changes');
  await shot(page, 'm2-2-preview.png');
  ok('preview shows the generated email at selectable widths, labeled as a browser preview');

  // ---- versions: save, change, restore
  await page.getByRole('tab', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Add Text to the end of the email' }).click();
  await page.getByRole('tab', { name: 'Versions' }).click();
  await page.getByLabel('Name (optional)').fill('With hero and text');
  await page.getByRole('button', { name: 'Save a version' }).click();
  await page.getByText('With hero and text').waitFor();
  await page.getByRole('tab', { name: 'Edit' }).click();
  await blocks.nth(0).click();
  await blocks.nth(0).getByRole('button', { name: 'Delete block' }).click();
  await blocks.nth(0).getByRole('button', { name: 'Delete block' }).click();
  assert((await blocks.count()) === 0, 'blocks deleted before restoring');
  await page.getByRole('tab', { name: 'Versions' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('row', { name: /With hero and text/ }).getByRole('button', { name: 'Restore' }).click();
  await blocks.first().waitFor();
  assert((await blocks.count()) === 2, 'restore brings the saved blocks back');
  await page.getByRole('tab', { name: 'Versions' }).click();
  await page.getByText(/Restored \(from version/).waitFor();
  await shot(page, 'm2-3-versions.png');
  ok('versions can be saved and restored; the restore is recorded as a new version');

  // ---- duplicate a campaign from the list
  await page.goto(`${BASE}/`);
  await page.getByRole('row', { name: /E2E summer sale/ }).getByRole('button', { name: 'Duplicate' }).click();
  await blocks.first().waitFor();
  assert((await page.getByLabel('Campaign name').inputValue()) === 'Copy of E2E summer sale', 'copy is named');
  assert((await order()) === 'header,button,divider,hero,text', 'copy has the same blocks');
  await blocks.nth(3).click();
  await page.getByLabel('Headline', { exact: true }).fill('Changed only in the copy');
  await saved();
  await page.goto(`${BASE}/`);
  await page.getByRole('link', { name: 'E2E summer sale', exact: true }).click();
  await blocks.first().waitFor();
  assert((await blocks.nth(3).innerText()).includes('Summer fares from AED 999'), 'original is unchanged by edits to the copy');
  ok('duplicating a campaign creates an independent copy');

  // ---- other roles can look but not change
  for (const role of ['admin', 'qa_reviewer'] as const) {
    const { page: other } = await openAs(browser, role);
    await other.goto(`${BASE}/`);
    assert((await other.getByLabel('Campaign name').count()) === 0, `${role} sees no "new campaign" form`);
    await other.getByRole('link', { name: 'E2E summer sale', exact: true }).click();
    await other.getByText('View only').waitFor();
    assert(await other.getByRole('button', { name: 'Add Hero banner to the end of the email' }).isDisabled(), `${role}: Add buttons are disabled`);
    assert((await other.getByRole('button', { name: 'Delete block' }).count()) === 0, `${role}: no delete buttons`);
    assert((await other.getByRole('button', { name: 'Undo' }).count()) === 0, `${role}: no undo button`);
  }
  ok('Admin and QA reviewer can open an email read-only');

  // ---- phone-sized screen has no sideways scrolling on the campaign list
  const { page: phone } = await openAs(browser, 'builder', { width: 390, height: 844 });
  await phone.goto(`${BASE}/`);
  await phone.getByRole('heading', { name: 'Campaigns', exact: true }).waitFor();
  assert(!(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll on a phone');
  ok('campaign list fits a phone screen');

  console.log(`\n${passed} editor checks passed`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await t.close();
}
