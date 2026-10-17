// Captures the same app screens in each color scheme so they can be compared side by side.
// Usage: npm run build, then: tsx e2e/themes.ts   (output: references/theme-options/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BLOCK_TYPES, blockDefinition, createInstance, emptyContent, type EmailContent } from '@cl/shared';
import { createTestApp } from '../src/testkit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(here, '../../../.env'));
} catch {
  /* CI provides DATABASE_URL */
}
const outDir = path.resolve(here, '../../../references/theme-options');
fs.mkdirSync(outDir, { recursive: true });
const PORT = 3113;
const BASE = `http://127.0.0.1:${PORT}`;

const THEMES = [
  { id: 'ocean', title: 'A. Ocean: navy bar, bright blue accent, clean and corporate' },
  { id: 'midnight-gold', title: 'B. Midnight Gold: charcoal bar, gold accent, serif headings, premium feel' },
  { id: 'soft-teal', title: 'C. Soft Teal: light bar, teal accent, rounded and calm' },
  { id: 'coral-night', title: 'D. Coral Night: plum bar, coral accent, pill buttons, friendly' },
];

const t = await createTestApp({ webDir: path.resolve(here, '../../web/dist') });
const browser = await chromium.launch();
try {
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const user = await t.seedUser('builder', { totp: true });
  const client = await t.sessionFor(user);

  // A realistic email to show in the editor
  const make = (type: (typeof BLOCK_TYPES)[number], props: Record<string, string | number | boolean> = {}) => {
    const b = createInstance(blockDefinition(type)!);
    Object.assign(b.props, props);
    return b;
  };
  const content: EmailContent = {
    ...emptyContent(),
    blocks: [
      make('header', { brandName: 'Skyline Travel' }),
      make('hero', { headline: 'Summer fares from AED 999', subheadline: 'Fly to 40 destinations this season.', buttonText: 'Book now', bgColor: '#12355b' }),
      make('text', { heading: 'Plan your escape', body: 'Pick a destination, choose your dates and lock in the lowest fare before the summer rush.' }),
      make('two_column', { leftHeading: 'Istanbul', leftBody: 'Direct flights daily.', rightHeading: 'Lisbon', rightBody: 'Three flights a week.' }),
      make('button', { label: 'See all destinations' }),
      make('footer', { companyName: 'Skyline Travel' }),
    ],
  };
  content.settings.subject = 'Summer fares from AED 999';
  const created = (await client.post('/api/campaigns', { name: 'Summer fares newsletter' })).body;
  await client.put(`/api/campaigns/${created.id}/draft`, { content, baseVersion: 1 });
  for (const name of ['Autumn events invitation', 'Cosmetics launch teaser']) await client.post('/api/campaigns', { name });

  const files: Record<string, { editor: string; list: string; login: string }> = {};
  for (const th of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    await ctx.addCookies([{ name: 'cl_session', value: client.sessionToken!, url: BASE }]);
    const page = await ctx.newPage();
    const f = { editor: path.join(outDir, `${th.id}-editor.png`), list: path.join(outDir, `${th.id}-campaigns.png`), login: path.join(outDir, `${th.id}-login.png`) };

    await page.goto(`${BASE}/?theme=${th.id}`);
    await page.getByRole('heading', { name: 'All campaigns' }).waitFor();
    await page.getByRole('row', { name: /Summer fares newsletter/ }).waitFor(); // list loaded
    await page.screenshot({ path: f.list });

    await page.goto(`${BASE}/campaigns/${created.id}?theme=${th.id}`);
    await page.locator('.canvas-block').first().waitFor();
    await page.locator('.canvas-block[data-block-type="hero"]').click();
    await page.getByLabel('Headline', { exact: true }).waitFor();
    await page.locator('.lib-item').nth(9).waitFor(); // block list loaded
    await page.screenshot({ path: f.editor });
    await ctx.close();

    const anon = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    const lp = await anon.newPage();
    await lp.goto(`${BASE}/login?theme=${th.id}`);
    await lp.getByRole('heading', { name: 'Sign in' }).waitFor();
    await lp.screenshot({ path: f.login });
    await anon.close();
    files[th.id] = f;
  }

  // Side-by-side comparison sheets (images embedded so the page needs no files)
  const b64 = (p: string) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  const sheet = async (name: string, kinds: ('editor' | 'list' | 'login')[], cols: number, width: number) => {
    const cells = THEMES.map((th) => `<figure><figcaption>${th.title}</figcaption>${kinds.map((k) => `<img src="${b64(files[th.id]![k])}">`).join('')}</figure>`).join('');
    const html = `<html><body style="margin:0;padding:24px;background:#dfe3ea;font:600 20px system-ui"><style>
      .grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:24px}figure{margin:0}figcaption{margin:0 0 8px}
      img{width:100%;display:block;border:1px solid #9aa3b2;border-radius:6px;margin-bottom:12px}</style><div class="grid">${cells}</div></body></html>`;
    const p = await browser.newPage({ viewport: { width, height: 800 } });
    await p.setContent(html);
    await p.screenshot({ path: path.join(outDir, name), fullPage: true });
    await p.close();
  };
  await sheet('comparison-editor.png', ['editor'], 2, 2000);
  await sheet('comparison-campaigns-and-login.png', ['list', 'login'], 2, 2000);
  console.log('saved to', outDir);
} finally {
  await browser.close();
  await t.close();
}
