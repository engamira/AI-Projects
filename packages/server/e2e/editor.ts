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
  const blocks = page.locator('.canvas-block:not(.brand-block)'); // the shared header and footer are locked and not counted
  const saved = () => page.getByText('All changes saved').waitFor();

  // ---- create a campaign
  await page.goto(`${BASE}/`);
  await page.getByLabel('Campaign name').fill('E2E summer sale');
  await page.getByLabel(/Start from the ready-made/).uncheck(); // these tests build from an empty email
  assert((await page.getByLabel('Template colors').inputValue()) === 'travel', 'Travel colors are the default choice');
  assert((await page.getByLabel('Template colors').locator('option').allInnerTexts()).join() === 'Travel,Events,Cosmetics', 'three template color sets to choose from');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await page.getByRole('region', { name: 'Email canvas' }).waitFor();
  assert((await blocks.count()) === 0, 'new campaign starts empty');
  ok('builder creates a campaign and opens the editor');

  // ---- add blocks: with the Add buttons, and by dragging from the library
  await page.getByRole('button', { name: 'Add Image to the end of the email' }).click();
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
  await page.waitForFunction(() => document.querySelectorAll('.canvas-block:not(.brand-block)').length === 5);
  assert((await blocks.nth(1).getAttribute('data-block-type')) === 'divider', 'dropping on a block inserts before it');
  ok('blocks can be added with buttons and by drag and drop');

  // ---- reorder (drag and buttons), duplicate, delete, undo, redo
  const order = async () => (await blocks.evaluateAll((els) => els.map((e) => e.getAttribute('data-block-type')))).join(',');
  assert((await order()) === 'image,divider,hero,text,button', `initial order (${await order()})`);
  await blocks.nth(4).click(); // selecting a block reveals its toolbar and drag handle
  await drag(page, blocks.nth(4).getByRole('button', { name: /^Drag .* to reorder$/ }), blocks.nth(0));
  await page.waitForFunction(() => document.querySelector('.canvas-block:not(.brand-block)')?.getAttribute('data-block-type') === 'button');
  assert((await order()) === 'button,image,divider,hero,text', `after drag reorder (${await order()})`);
  await blocks.nth(0).click();
  await blocks.nth(0).getByRole('button', { name: 'Move down' }).click();
  assert((await order()) === 'image,button,divider,hero,text', `after Move down (${await order()})`);
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
  assert((await order()) === 'image,button,divider,hero,text', 'order restored after undo');
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
  assert((await order()) === 'image,button,divider,hero,text', 'order survives a reload');
  assert((await blocks.nth(3).innerText()).includes('Summer fares from AED 999'), 'edited text survives a reload');
  await blocks.nth(3).click();
  assert((await page.getByLabel('Space above and below text', { exact: true }).inputValue()) === '64', 'edited spacing survives a reload');
  assert((await page.getByLabel('Button link alias', { exact: true }).inputValue()) === 'Summer hero button', 'link alias survives a reload');
  ok('reopening the email restores every edit');

  // ---- library originals and other emails are unchanged
  await page.goto(`${BASE}/`);
  await page.getByLabel('Campaign name').fill('Second email');
  await page.getByLabel(/Start from the ready-made/).uncheck();
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
  const phoneFrame = page.locator('iframe[title="Phone preview"]');
  const desktopFrame = page.locator('iframe[title="Desktop preview"]');
  await page.waitForFunction(() => (document.querySelector('iframe[title="Desktop preview"]') as HTMLIFrameElement | null)?.srcdoc.includes('A big, clear headline'));
  const width = (l: typeof phoneFrame) => l.evaluate((f) => (f as HTMLElement).getBoundingClientRect().width);
  const left = (l: typeof phoneFrame) => l.evaluate((f) => (f as HTMLElement).getBoundingClientRect().left);
  assert((await phoneFrame.getAttribute('sandbox')) === '' && (await desktopFrame.getAttribute('sandbox')) === '', 'both preview frames are fully sandboxed (no scripts)');
  assert((await width(phoneFrame)) === 375, 'the phone view is 375 px wide by default');
  assert((await width(desktopFrame)) >= 600, 'the desktop view is at least 600 px wide');
  assert((await left(phoneFrame)) < (await left(desktopFrame)), 'phone and desktop sit side by side, phone on the left');
  assert((await page.locator('.frame-phone .frame-notch').count()) === 1 && (await page.locator('.frame-desktop .frame-chrome').count()) === 1, 'a phone frame and a browser window frame surround the views');
  await page.getByLabel('Desktop width', { exact: true }).selectOption('1024');
  assert((await width(desktopFrame)) === 1024, 'the desktop width can be changed');
  await page.getByLabel('Phone width', { exact: true }).selectOption('414');
  assert((await width(phoneFrame)) === 414 && (await width(desktopFrame)) === 1024, 'each view keeps its own width');
  assert(await page.getByText('not an Outlook or Gmail simulation').isVisible(), 'labeled as a browser preview');
  await page.getByLabel('Desktop width', { exact: true }).selectOption('768');
  await page.getByLabel('Phone width', { exact: true }).selectOption('375');
  await shot(page, 'm2-2-preview.png');
  ok('preview shows phone and desktop side by side in device frames, each with its own width, labeled as a browser preview');

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
  assert((await order()) === 'image,button,divider,hero,text', 'copy has the same blocks');
  await blocks.nth(3).click();
  await page.getByLabel('Headline', { exact: true }).fill('Changed only in the copy');
  await saved();
  await page.goto(`${BASE}/`);
  await page.getByRole('link', { name: 'E2E summer sale', exact: true }).click();
  await blocks.first().waitFor();
  assert((await blocks.nth(3).innerText()).includes('Summer fares from AED 999'), 'original is unchanged by edits to the copy');
  ok('duplicating a campaign creates an independent copy');

  // ---- ready-made layout and template-specific blocks
  await page.goto(`${BASE}/`);
  await page.getByLabel('Campaign name').fill('Events invitation');
  await page.getByLabel('Template colors').selectOption('events');
  assert(await page.getByLabel(/Start from the ready-made Events layout/).isChecked(), 'the ready-made layout is on by default');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await blocks.first().waitFor();
  assert((await order()) === 'hero,event_details,text,agenda,speakers,registration_cta', `Events starter layout (${await order()})`);
  await page.getByRole('heading', { name: 'Events blocks' }).waitFor();
  assert((await page.getByRole('button', { name: 'Add Destinations to the end of the email' }).count()) === 0, 'travel blocks are not offered in an events email');
  assert((await page.getByRole('button', { name: 'Add Registration button to the end of the email' }).count()) === 1, 'events blocks are offered');
  await page.getByRole('button', { name: 'Add Agenda to the end of the email' }).click();
  await page.getByText('All changes saved').waitFor();
  assert((await blocks.count()) === 7, 'a template block can be added');
  ok('a new email can start from the ready-made layout, and only offers its own template blocks');

  // ---- ready-made content for picture-and-text blocks
  await page.locator('.canvas-block[data-block-type="speakers"]').dispatchEvent('click');
  assert((await page.getByLabel('Speaker 1: role', { exact: true }).count()) === 1, 'all fields are shown while the switch is off');
  await page.getByRole('switch', { name: 'Use ready-made content' }).check();
  assert((await page.getByLabel('Speaker 1: role', { exact: true }).count()) === 0, 'word fields are hidden while ready-made content is on');
  assert((await page.getByText('Speaker 1: photo').count()) > 0, 'pictures can still be chosen');
  await page.getByLabel('Ready-made content', { exact: true }).selectOption({ label: "Workshop leaders" });
  await page.getByText('All changes saved').waitFor();
  await page.locator('.canvas-block[data-block-type="speakers"]').getByText("Workshop leader").first().waitFor();
  await page.getByRole('switch', { name: 'Use ready-made content' }).uncheck();
  assert((await page.getByLabel('Speaker 1: role', { exact: true }).inputValue()) === "Workshop leader", 'fields keep the ready-made words and can be edited');
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.locator('.canvas-block[data-block-type="speakers"]').getByText("Role, Company").first().waitFor();
  assert((await page.locator('.canvas-block[data-block-type="hero"] [data-testid="preset-picker"]').count()) === 0, 'no ready-made option on the hero');
  await page.locator('.canvas-block[data-block-type="hero"]').dispatchEvent('click');
  assert((await page.getByTestId('preset-picker').count()) === 0, 'the hero has no ready-made option');
  ok('ready-made content fills a picture-and-text block in one step, can be undone, and is not offered on the hero');

  // ---- live preview beside the canvas
  await page.getByLabel('Live preview', { exact: true }).check();
  const live = page.locator('[data-testid="live-preview"]');
  await live.waitFor();
  const liveFrame = page.frameLocator('iframe[title="Phone preview"]');
  await liveFrame.getByText('Unsubscribe').first().waitFor();
  assert((await page.getByRole('button', { name: 'Add Agenda to the end of the email' }).count()) === 1, 'compact block list still has Add buttons');
  await blocks.first().click();
  const headline = page.getByLabel('Headline', { exact: true });
  await headline.fill('Live preview headline');
  await page.getByText('All changes saved').waitFor();
  await liveFrame.getByText('Live preview headline').waitFor();
  await live.getByRole('button', { name: 'Desktop' }).click();
  await page.frameLocator('iframe[title="Desktop preview"]').getByText('Live preview headline').waitFor();
  await page.getByLabel('Live preview', { exact: true }).uncheck();
  assert((await live.count()) === 0, 'live preview closes');
  ok('live preview shows the real email beside the canvas and refreshes after each saved edit');

  // ---- other roles can look but not change
  for (const role of ['admin', 'qa_reviewer'] as const) {
    const { page: other } = await openAs(browser, role);
    await other.goto(`${BASE}/`);
    assert((await other.getByLabel('Campaign name').count()) === 0, `${role} sees no "new campaign" form`);
    await other.getByRole('link', { name: 'E2E summer sale', exact: true }).click();
    await other.getByText(role === 'admin' ? 'Custom HTML only' : 'View only').waitFor();
    assert(await other.getByRole('button', { name: 'Add Hero banner to the end of the email' }).isDisabled(), `${role}: Add buttons are disabled`);
    assert((await other.getByRole('button', { name: 'Delete block' }).count()) === 0, `${role}: no delete buttons`);
    if (role === 'qa_reviewer') assert((await other.getByRole('button', { name: 'Undo' }).count()) === 0, `${role}: no undo button`);
  }
  ok('Admin (Custom HTML only) and QA reviewer (view only) cannot change normal blocks');

  // ---- the Admin can add Custom HTML; it is cleaned in the preview, and the Builder cannot edit it
  {
    const { page: adm } = await openAs(browser, 'admin');
    await adm.goto(`${BASE}/`);
    await adm.getByRole('link', { name: 'E2E summer sale', exact: true }).click();
    await adm.getByRole('button', { name: 'Add Custom HTML to the end of the email' }).click();
    const html = adm.getByLabel('HTML', { exact: true });
    await html.fill('<p>Admin note</p><script>window.__pwned=1</script><p onclick="window.__pwned=1">click</p>');
    await adm.getByText('All changes saved').waitFor();
    await adm.getByRole('tab', { name: 'Preview' }).click();
    await adm.getByText('rendering note').waitFor();
    const frame = adm.frameLocator('iframe[title="Phone preview"]');
    await frame.getByText('Admin note').waitFor();
    assert((await frame.locator('script').count()) === 0, 'no script in the preview');
    assert((await frame.locator('[onclick]').count()) === 0, 'no event handlers in the preview');
    await adm.getByRole('button', { name: 'Show plain text' }).click();
    await adm.getByText('Admin note').first().waitFor();

    const { page: bld } = await openAs(browser, 'builder');
    await bld.goto(`${BASE}/`);
    await bld.getByRole('link', { name: 'E2E summer sale', exact: true }).click();
    await bld.getByText('Custom HTML:').first().click();
    assert(await bld.getByLabel('HTML', { exact: true }).isDisabled(), 'the Builder cannot edit Custom HTML');
    assert(await bld.getByRole('button', { name: 'Add Custom HTML to the end of the email' }).isDisabled(), 'the Builder cannot add Custom HTML');
  }
  ok('Admin adds Custom HTML, it is cleaned in the preview, and the Builder cannot edit or add it');

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
