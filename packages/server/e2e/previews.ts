// Renders the three starter emails (with the real logos and sample pictures) at desktop and phone width,
// so the designs can be reviewed. Output: references/template-previews/. Usage: tsx e2e/previews.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PALETTES, type EmailContent, type PaletteId } from '@cl/shared';
import { createTestApp } from '../src/testkit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(here, '../../../.env'));
} catch {
  /* no .env */
}
const out = path.resolve(here, '../../../references/template-previews');
fs.mkdirSync(out, { recursive: true });
const PORT = 3117;
const BASE = `http://127.0.0.1:${PORT}`;

const t = await createTestApp({ webDir: path.resolve(here, '../../web/dist') });
t.config.baseUrl = BASE; // pictures in the generated email load from this test server
const browser = await chromium.launch();
try {
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
  const builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));

  // ---- sample pictures (preview only): soft gradients in each template's colors
  const gen = await browser.newPage();
  const picture = async (a: string, b: string, kind: number, w = 800, h = 600): Promise<Buffer> => {
    const url = await gen.evaluate(([c1, c2, k, W, H]) => {
      const c = document.createElement('canvas');
      c.width = W as number; c.height = H as number;
      const x = c.getContext('2d')!;
      const g = x.createLinearGradient(0, 0, W as number, H as number);
      g.addColorStop(0, c1 as string); g.addColorStop(1, c2 as string);
      x.fillStyle = g; x.fillRect(0, 0, W as number, H as number);
      x.fillStyle = 'rgba(255,255,255,0.22)';
      if (k === 0) { x.beginPath(); x.arc((W as number) * 0.72, (H as number) * 0.3, (H as number) * 0.18, 0, 7); x.fill(); x.beginPath(); x.moveTo(0, H as number); x.lineTo((W as number) * 0.35, (H as number) * 0.5); x.lineTo((W as number) * 0.7, H as number); x.fill(); }
      else if (k === 1) { for (let i = 0; i < 5; i++) { x.fillRect((W as number) * (0.1 + i * 0.17), (H as number) * (0.55 - i * 0.07), (W as number) * 0.12, (H as number) * (0.45 + i * 0.07)); } }
      else { x.beginPath(); x.arc((W as number) * 0.5, (H as number) * 0.5, (H as number) * 0.28, 0, 7); x.fill(); x.beginPath(); x.arc((W as number) * 0.5, (H as number) * 0.5, (H as number) * 0.14, 0, 7); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fill(); }
      return c.toDataURL('image/png');
    }, [a, b, kind, w, h] as const);
    return Buffer.from(url.split(',')[1]!, 'base64');
  };
  const upload = async (buf: Buffer, name: string) => `asset:${(await admin.upload('/api/assets', name, buf)).body.id}`;

  // ---- brand headers with the real logos
  const logoDir = path.resolve(here, '../../../references/logos/trimmed');
  const widths: Record<PaletteId, number> = { travel: 180, events: 170, cosmetics: 200 };
  for (const palette of ['travel', 'events', 'cosmetics'] as const) {
    const file = path.join(logoDir, `${palette}-logo.png`);
    const cur = (await admin.get('/api/brand')).body.profiles[palette];
    const header = { ...cur.header, logoWidth: widths[palette] };
    if (fs.existsSync(file)) header.logoUrl = await upload(fs.readFileSync(file), `${palette}-logo.png`);
    await admin.put(`/api/brand/${palette}`, { header, footer: cur.footer, baseVersion: cur.version });
  }

  // ---- starter emails with sample pictures
  const sheets: { palette: PaletteId; desktop: string; mobile: string }[] = [];
  for (const palette of ['travel', 'events', 'cosmetics'] as const) {
    const p = PALETTES[palette];
    const camp = (await builder.post('/api/campaigns', { name: `${p.label} starter`, palette, starter: true })).body;
    const content: EmailContent = camp.draft.content;
    const tints: [string, string][] = palette === 'travel' ? [['#fa8739', '#2f5d8a'], ['#2f323b', '#fa8739'], ['#3a7bd5', '#00d2ff']]
      : palette === 'events' ? [['#354552', '#6c8aa0'], ['#151e23', '#354552'], ['#6c8aa0', '#d9dde1']]
      : [['#ff3fb4', '#ffd1ec'], ['#00a3d9', '#bfeaf7'], ['#f15822', '#ffd9c7']];
    let k = 0;
    for (const b of content.blocks) {
      for (const key of Object.keys(b.props)) {
        if (/Image$|^c\d+Image$|^p\d+Image$/.test(key) && !/Alt$/.test(key) && b.props[key] === '') {
          const [c1, c2] = tints[k % 3]!;
          b.props[key] = await upload(await picture(c1, c2, k % 3, key.startsWith('p') ? 600 : 800, key.startsWith('p') ? 600 : 600), `${palette}-sample-${k + 1}.png`);
          k++;
        }
      }
      if (b.type === 'hero' && b.props.imageUrl === '') {
        const [c1, c2] = tints[0]!;
        b.props.imageUrl = await upload(await picture(c1, c2, 0, 1200, 480), `${palette}-hero-sample.png`);
      }
    }
    const saved = await builder.put(`/api/campaigns/${camp.id}/draft`, { content, baseVersion: 1 });
    if (saved.status !== 200) throw new Error(`save failed ${palette}: ${JSON.stringify(saved.body)}`);
    const html = (await builder.get(`/api/campaigns/${camp.id}/preview`)).body.html as string;
    fs.writeFileSync(path.join(out, `${palette}.html`), html);
    const shot = async (width: number, name: string) => {
      const pg = await browser.newPage({ viewport: { width, height: 900 } });
      await pg.setContent(html, { waitUntil: 'networkidle' });
      await pg.waitForTimeout(500);
      const file = path.join(out, name);
      await pg.screenshot({ path: file, fullPage: true });
      await pg.close();
      return file;
    };
    sheets.push({ palette, desktop: await shot(680, `${palette}-desktop.png`), mobile: await shot(375, `${palette}-mobile.png`) });
    console.log(palette, 'rendered', html.length, 'bytes');
  }

  // ---- overview sheets (three templates side by side)
  const b64 = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
  const sheet = async (name: string, kind: 'desktop' | 'mobile', width: number, imgWidth: number) => {
    const cells = sheets.map((s) => `<figure><figcaption>${PALETTES[s.palette].label}</figcaption><img src="${b64(s[kind])}" style="width:${imgWidth}px"></figure>`).join('');
    const html = `<html><body style="margin:0;padding:24px;background:#e8e4ea;font:700 22px system-ui"><style>.g{display:flex;gap:24px;justify-content:center;align-items:flex-start}figure{margin:0}figcaption{margin:0 0 8px}img{display:block;border:1px solid #b9b2bd;border-radius:6px}</style><div class="g">${cells}</div></body></html>`;
    const p = await browser.newPage({ viewport: { width, height: 800 } });
    await p.setContent(html);
    await p.screenshot({ path: path.join(out, name), fullPage: true });
    await p.close();
  };
  await sheet('overview-desktop.png', 'desktop', 2200, 680);
  await sheet('overview-mobile.png', 'mobile', 1300, 375);
  console.log('saved to', out);
} finally {
  await browser.close();
  await t.close();
}
