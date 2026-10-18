// Browser test for Brand settings, the asset library and the locked shared header and footer.
// Uses the real trimmed logos in references/logos/trimmed when present, otherwise a tiny generated picture.
import fs from 'node:fs';
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
const shots = process.env.E2E_SHOTS_DIR;
const PORT = 3115;
const BASE = `http://127.0.0.1:${PORT}`;
const webDir = path.resolve(here, '../../web/dist');
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const logoFile = (name: string) => {
  const real = path.resolve(here, `../../../references/logos/trimmed/${name}-logo.png`);
  if (fs.existsSync(real)) return real;
  const tmp = path.join(process.env.TEMP ?? '/tmp', `e2e-${name}-logo-${process.pid}.png`);
  fs.writeFileSync(tmp, Buffer.concat([TINY_PNG, Buffer.from(name)])); // different bytes per template (not a duplicate)
  return tmp;
};

const t = await createTestApp({ webDir });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`PASS  ${name}`); };
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL  ${msg}`);
}

const browser = await chromium.launch();
try {
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const open = async (role: 'admin' | 'builder' | 'qa_reviewer') => {
    const client = await t.sessionFor(await t.seedUser(role, { totp: true }));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: 'cl_session', value: client.sessionToken!, url: BASE }]);
    return { client, page: await ctx.newPage() };
  };
  const admin = await open('admin');
  const a = admin.page;

  // ---- Brand settings: upload a logo for each template and save
  const templates = [['Travel', 'travel', 'Fly'], ['Events', 'events', 'Agenda'], ['Cosmetics', 'cosmetics', 'PrettyWoman']] as const;
  await a.goto(`${BASE}/admin/brand`);
  await a.getByRole('heading', { name: 'Brand settings' }).waitFor();
  for (const [label, key, name] of templates) {
    await a.getByRole('tab', { name: label }).click();
    await a.getByLabel('Brand name (shown when there is no logo)').waitFor();
    assert((await a.getByLabel('Brand name (shown when there is no logo)').inputValue()) === name, `${label} starts with the brand name ${name}`);
    await a.getByRole('button', { name: 'Choose or upload a picture' }).first().click();
    await a.getByRole('dialog', { name: 'Choose a picture' }).waitFor();
    await a.getByRole('dialog').locator('input[type="file"]').setInputFiles(logoFile(key));
    await a.getByRole('dialog').waitFor({ state: 'detached' }); // picked automatically after upload
    assert((await a.locator('.picture-thumb').count()) >= 1, `${label}: the logo thumbnail shows in the header settings`);
    await a.getByRole('button', { name: 'Save as a new version' }).click();
    await a.getByText('Saved as a new version').waitFor();
    await a.getByText('Version 2:').waitFor();
  }
  if (shots) await a.screenshot({ path: path.join(shots, 'm3-brand-settings.png'), fullPage: true });
  ok('Admin uploads a logo for each template and saves each header/footer as a new version');

  // ---- Builder sees the locked header and footer in every template
  const b = await open('builder');
  const bp = b.page;
  for (const [label, key, name] of templates) {
    const c = (await b.client.post('/api/campaigns', { name: `${label} test email`, palette: key })).body;
    await bp.goto(`${BASE}/campaigns/${c.id}`);
    await bp.locator('.brand-block[data-brand="header"] img').waitFor();
    await bp.waitForFunction(() => (document.querySelector('.brand-block[data-brand="header"] img') as HTMLImageElement)?.naturalWidth > 0);
    assert((await bp.locator('.brand-block[data-brand="footer"]').innerText()).includes('Unsubscribe'), `${label}: the shared footer has the unsubscribe link`);
    assert((await bp.locator('.brand-block[data-brand="header"]').getByRole('button').count()) === 0, `${label}: the header has no edit or drag buttons`);
    assert((await bp.locator('.brand-block[data-brand="header"] .block-label').innerText()).includes('locked'), `${label}: the header is marked locked`);
    assert((await bp.locator('.brand-block a', { hasText: 'Edit in Brand settings' }).count()) === 0, `${label}: Builders get no link to edit the brand`);
    await bp.getByRole('button', { name: `Add Hero banner to the end of the email` }).click();
    await bp.getByText('All changes saved').waitFor();
    if (shots) await bp.screenshot({ path: path.join(shots, `m3-editor-${key}.png`) });
    // the generated email has the same logo and footer
    await bp.getByRole('tab', { name: 'Preview' }).click();
    await bp.waitForFunction(() => (document.querySelector('iframe[title="Desktop preview"]') as HTMLIFrameElement | null)?.srcdoc.includes('/media/'));
    const html = await bp.locator('iframe[title="Desktop preview"]').evaluate((f) => (f as HTMLIFrameElement).srcdoc);
    assert(/\/media\/[0-9a-f-]{36}/.test(html) && html.includes('Unsubscribe'), `${label}: the real email shows the logo and unsubscribe link`);
    void name;
  }
  assert((await bp.getByRole('link', { name: 'Brand' }).count()) === 0, 'Builders have no Brand menu');
  ok('every template email shows its own locked header and footer, in the editor and in the generated email');

  // ---- Admin sees the edit link; QA reviewers see the header but have no asset library
  const c0 = (await b.client.get('/api/campaigns')).body[0];
  await a.goto(`${BASE}/campaigns/${c0.id}`);
  await a.locator('.brand-block a', { hasText: 'Edit in Brand settings' }).first().waitFor();
  ok('Admin gets an "Edit in Brand settings" link on the locked header and footer');
  const qa = await open('qa_reviewer');
  await qa.page.goto(`${BASE}/campaigns/${c0.id}`);
  await qa.page.locator('.brand-block[data-brand="header"]').waitFor();
  assert((await qa.page.getByRole('link', { name: 'Pictures' }).count()) === 0, 'QA reviewers have no Pictures menu');
  await qa.page.goto(`${BASE}/assets`);
  assert((await qa.page.getByRole('heading', { name: 'Pictures' }).count()) === 0, 'QA reviewers cannot open the asset library');
  ok('QA reviewers can read emails but have no access to pictures or brand settings');

  // ---- Builder picks a library picture for an Image block, and it persists
  const c1 = (await b.client.post('/api/campaigns', { name: 'Picture picker', palette: 'travel' })).body;
  await bp.goto(`${BASE}/campaigns/${c1.id}`);
  await bp.getByRole('button', { name: 'Add Image to the end of the email' }).click();
  await bp.getByRole('button', { name: 'Choose or upload a picture' }).click();
  await bp.getByRole('dialog').getByRole('button', { name: 'Use this picture' }).first().click();
  await bp.locator('.canvas-block:not(.brand-block) img').first().waitFor();
  await bp.getByText('All changes saved').waitFor();
  await bp.reload();
  await bp.locator('.canvas-block:not(.brand-block) img').first().waitFor();
  assert(((await bp.locator('.canvas-block:not(.brand-block) img').first().getAttribute('src')) ?? '').startsWith('/media/'), 'the library picture survives a reload');
  ok('a Builder can choose a library picture for an Image block, and it is saved');

  // ---- Pictures page
  await a.goto(`${BASE}/assets`);
  await a.getByRole('heading', { name: 'Pictures' }).waitFor();
  await a.locator('.asset-grid li').first().waitFor();
  assert((await a.locator('.asset-grid li').count()) >= 3, 'the three logos are in the library');
  await a.getByText('this picture could not be read').waitFor({ state: 'detached', timeout: 500 }).catch(() => undefined);
  ok('the Pictures page lists the uploaded logos');

  // ---- a bad file is refused with a clear message
  await a.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a picture') });
  await a.getByText(/Only PNG, JPG, GIF and WebP/).waitFor();
  ok('a non-picture file is refused with a clear message');

  console.log(`\n${passed} brand and asset checks passed`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await t.close();
}
