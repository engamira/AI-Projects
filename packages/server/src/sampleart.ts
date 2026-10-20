import { SAMPLE_ART_KEYS, sampleAssetId } from '@cl/shared';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';

// Original illustrations drawn in code (no photos or third-party artwork, so there is nothing to license).
// They are stand-ins for the ready-made content drop-downs; real photos can replace them from the asset library.

const W = 600;
const H = 450;
const svg = (body: string, w = W, h = H): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const sky = (a: string, b: string): string => `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#s)"/>`;
const sun = (x: number, y: number, r: number, c: string): string => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;

type Scene = { sky: [string, string]; sun: string; dark: string; mid: string; accent: string };

function city(p: Scene, seed: number): string {
  let out = sky(...p.sky) + sun(440, 120, 50, p.sun);
  const heights = [150, 220, 180, 260, 200, 300, 170, 240, 190, 210];
  heights.forEach((h, i) => {
    const hh = h + ((seed * (i + 3)) % 40);
    const x = i * 60;
    out += `<rect x="${x}" y="${H - hh}" width="54" height="${hh}" fill="${i % 2 ? p.dark : p.mid}"/>`;
    for (let r = 0; r < Math.floor(hh / 45); r++) out += `<rect x="${x + 10}" y="${H - hh + 18 + r * 40}" width="12" height="16" fill="${p.accent}"/><rect x="${x + 32}" y="${H - hh + 18 + r * 40}" width="12" height="16" fill="${p.accent}"/>`;
  });
  return svg(out);
}
function beach(p: Scene): string {
  return svg(
    sky(...p.sky) + sun(150, 130, 55, p.sun) +
    `<rect y="270" width="${W}" height="100" fill="${p.mid}"/><path d="M0 330 Q150 300 300 330 T600 330 V450 H0Z" fill="${p.accent}"/>` +
    `<path d="M400 440 Q430 330 470 250" stroke="${p.dark}" stroke-width="14" fill="none" stroke-linecap="round"/>` +
    [-60, -20, 20, 60].map((d) => `<ellipse cx="${470 + d}" cy="${245 + Math.abs(d) / 3}" rx="55" ry="14" transform="rotate(${d / 2} 470 250)" fill="${p.dark}"/>`).join(''),
  );
}
function desert(p: Scene): string {
  return svg(
    sky(...p.sky) + sun(470, 120, 50, p.sun) +
    `<path d="M0 330 Q150 260 300 320 T600 300 V450 H0Z" fill="${p.mid}"/><path d="M0 390 Q200 330 400 390 T600 370 V450 H0Z" fill="${p.accent}"/>` +
    `<polygon points="140,320 230,210 320,320" fill="${p.dark}"/><polygon points="290,330 350,255 410,330" fill="${p.dark}" opacity="0.85"/>`,
  );
}
function temple(p: Scene): string {
  const tier = (y: number, w: number): string => `<path d="M${300 - w} ${y} H${300 + w} L${300 + w - 20} ${y - 28} H${300 - w + 20}Z" fill="${p.dark}"/><rect x="${300 - w + 30}" y="${y}" width="${2 * w - 60}" height="26" fill="${p.mid}"/>`;
  return svg(sky(...p.sky) + sun(130, 120, 45, p.sun) + `<rect y="390" width="${W}" height="60" fill="${p.accent}"/>` + tier(380, 150) + tier(320, 110) + tier(262, 75) + `<polygon points="300,150 285,210 315,210" fill="${p.dark}"/>`);
}
function mountain(p: Scene): string {
  return svg(
    sky(...p.sky) + sun(480, 110, 45, p.sun) +
    `<polygon points="60,350 260,110 460,350" fill="${p.dark}"/><polygon points="200,350 400,170 600,350" fill="${p.mid}"/><polygon points="260,110 225,160 260,145 290,165" fill="#ffffff"/>` +
    `<rect y="350" width="${W}" height="100" fill="${p.accent}"/>`,
  );
}
function dome(p: Scene): string {
  return svg(
    sky(...p.sky) + sun(480, 110, 45, p.sun) + `<rect y="360" width="${W}" height="90" fill="${p.accent}"/>` +
    `<rect x="150" y="260" width="300" height="110" fill="${p.mid}"/><path d="M180 262 A120 120 0 0 1 420 262Z" fill="${p.dark}"/><rect x="296" y="110" width="8" height="40" fill="${p.dark}"/>` +
    `<rect x="100" y="190" width="30" height="180" fill="${p.dark}"/><polygon points="100,190 115,150 130,190" fill="${p.mid}"/><rect x="470" y="190" width="30" height="180" fill="${p.dark}"/><polygon points="470,190 485,150 500,190" fill="${p.mid}"/>`,
  );
}

const SCENES: Record<string, string> = {
  paris: city({ sky: ['#ffd9e0', '#9ec5ff'], sun: '#fff3c4', dark: '#3b3f6b', mid: '#6a6fa8', accent: '#ffe69a' }, 3),
  rome: dome({ sky: ['#ffe2b8', '#f7a98b'], sun: '#fff6d6', dark: '#8a4b3a', mid: '#d98b6a', accent: '#6b8f71' }),
  prague: city({ sky: ['#ffe9c7', '#ffb48a'], sun: '#fff7da', dark: '#7a3b3b', mid: '#b4584f', accent: '#ffe69a' }, 7),
  maldives: beach({ sky: ['#bfe9ff', '#e8fbff'], sun: '#fff1b0', dark: '#1d6b4f', mid: '#f2dfae', accent: '#27b3c9' }),
  phuket: beach({ sky: ['#ffd1a9', '#ffeede'], sun: '#fff4c2', dark: '#2a7d5b', mid: '#f5e2b5', accent: '#1c8fb4' }),
  cairo: desert({ sky: ['#ffe0a3', '#fff3d6'], sun: '#fff8e1', dark: '#a8742e', mid: '#e8c070', accent: '#d9a652' }),
  bangkok: temple({ sky: ['#ffc9a0', '#ffe8cf'], sun: '#fff3c2', dark: '#b2432f', mid: '#e6b04b', accent: '#5a8a5a' }),
  tokyo: mountain({ sky: ['#ffd3dd', '#e9eeff'], sun: '#ffefef', dark: '#516080', mid: '#7d8fb2', accent: '#9bc3a8' }),
  muscat: dome({ sky: ['#bfe3ff', '#f1f9ff'], sun: '#fff6c8', dark: '#35708a', mid: '#e8e1d0', accent: '#4aa5bd' }),
};

// ---------- Products: a soft colored disc with a simple shape ----------
function product(bg: string, shape: string): string {
  return svg(`<rect width="${W}" height="${H}" fill="${bg}"/><circle cx="300" cy="225" r="170" fill="#ffffff" opacity="0.55"/>${shape}<ellipse cx="300" cy="400" rx="130" ry="14" fill="#000" opacity="0.08"/>`);
}
const PRODUCTS: Record<string, string> = {
  serum: product('#f9d9e6', `<rect x="262" y="190" width="76" height="190" rx="14" fill="#d6247f"/><rect x="278" y="150" width="44" height="46" rx="6" fill="#2f323b"/><path d="M290 80 H310 V150 H290Z" fill="#2f323b"/><ellipse cx="300" cy="82" rx="22" ry="10" fill="#4a4e5c"/><rect x="274" y="240" width="52" height="80" rx="6" fill="#ffffff" opacity="0.7"/>`),
  moisturiser: product('#e0f2fa', `<rect x="210" y="250" width="180" height="130" rx="20" fill="#00a3d9"/><rect x="200" y="205" width="200" height="58" rx="14" fill="#ffffff"/><rect x="240" y="290" width="120" height="50" rx="8" fill="#ffffff" opacity="0.7"/>`),
  cleanser: product('#fde8d8', `<path d="M250 380 L260 130 H340 L350 380Z" fill="#f15822"/><rect x="262" y="90" width="76" height="46" rx="8" fill="#2f323b"/><rect x="272" y="230" width="56" height="70" rx="6" fill="#ffffff" opacity="0.75"/>`),
  lipstick: product('#f8d6e3', `<rect x="250" y="250" width="100" height="130" rx="10" fill="#2f323b"/><rect x="262" y="190" width="76" height="70" fill="#c9a24a"/><path d="M268 190 V140 Q300 100 332 140 V190Z" fill="#d6247f"/>`),
  mascara: product('#e6e2f7', `<rect x="276" y="180" width="48" height="200" rx="12" fill="#2f323b"/><rect x="286" y="90" width="28" height="96" rx="8" fill="#8a7cc9"/><rect x="262" y="230" width="76" height="26" fill="#ff3fb4"/>`),
  highlighter: product('#fdebc8', `<circle cx="300" cy="235" r="115" fill="#d4a15c"/><circle cx="300" cy="235" r="88" fill="#f6d9a4"/><path d="M240 210 Q300 160 360 210" stroke="#ffffff" stroke-width="12" fill="none" stroke-linecap="round" opacity="0.8"/>`),
  shampoo: product('#d9f1e6', `<rect x="240" y="170" width="120" height="210" rx="22" fill="#2fa37a"/><rect x="278" y="110" width="44" height="66" rx="6" fill="#2f323b"/><rect x="278" y="100" width="90" height="22" rx="8" fill="#2f323b"/><rect x="262" y="250" width="76" height="80" rx="8" fill="#ffffff" opacity="0.75"/>`),
  mist: product('#e7f0fb', `<rect x="250" y="190" width="100" height="190" rx="20" fill="#5a8bd6"/><rect x="278" y="140" width="44" height="56" rx="6" fill="#2f323b"/><rect x="266" y="120" width="68" height="28" rx="8" fill="#2f323b"/><circle cx="360" cy="120" r="6" fill="#5a8bd6"/><circle cx="385" cy="100" r="5" fill="#5a8bd6"/><circle cx="378" cy="135" r="4" fill="#5a8bd6"/>`),
  giftset: product('#fbe0e0', `<rect x="190" y="230" width="220" height="150" rx="10" fill="#d6247f"/><rect x="190" y="200" width="220" height="44" rx="8" fill="#f06aa8"/><rect x="284" y="200" width="32" height="180" fill="#ffffff" opacity="0.85"/><path d="M300 200 Q250 130 220 170 Q250 205 300 200Z M300 200 Q350 130 380 170 Q350 205 300 200Z" fill="#ffffff" opacity="0.9"/>`),
};

// ---------- Two columns: a white icon on a colored background ----------
function icon(bg: string, shape: string): string {
  return svg(`<rect width="${W}" height="${H}" fill="${bg}"/><circle cx="300" cy="225" r="150" fill="#ffffff" opacity="0.22"/><g fill="#ffffff" stroke="#ffffff" stroke-linejoin="round" stroke-linecap="round">${shape}</g>`);
}
const COLUMNS: Record<string, string> = {
  delivery: icon('#f15822', `<rect x="170" y="190" width="170" height="100" rx="8" stroke-width="0"/><path d="M340 215 H400 L430 255 V290 H340Z" stroke-width="0"/><circle cx="220" cy="300" r="26" fill="#f15822" stroke-width="12"/><circle cx="390" cy="300" r="26" fill="#f15822" stroke-width="12"/>`),
  returns: icon('#00a3d9', `<path d="M380 210 A100 100 0 1 0 395 290" fill="none" stroke-width="26"/><polygon points="395,170 395,250 335,215" stroke-width="4"/>`),
  new: icon('#d6247f', `<path d="M300 130 L330 200 L405 205 L348 252 L368 325 L300 285 L232 325 L252 252 L195 205 L270 200Z" stroke-width="10"/>`),
  bestsellers: icon('#8a5cc9', `<circle cx="300" cy="205" r="80" stroke-width="0"/><polygon points="250,270 235,350 300,320 365,350 350,270" stroke-width="6"/><path d="M300 165 L312 197 L346 199 L320 221 L329 254 L300 235 L271 254 L280 221 L254 199 L288 197Z" fill="#8a5cc9" stroke-width="0"/>`),
  story: icon('#e04a6f', `<path d="M300 340 C170 250 190 160 250 160 C280 160 295 180 300 195 C305 180 320 160 350 160 C410 160 430 250 300 340Z" stroke-width="8"/>`),
  help: icon('#2fa37a', `<path d="M170 170 H430 V290 H300 L240 340 V290 H170Z" stroke-width="10"/><circle cx="240" cy="230" r="14" fill="#2fa37a" stroke-width="0"/><circle cx="300" cy="230" r="14" fill="#2fa37a" stroke-width="0"/><circle cx="360" cy="230" r="14" fill="#2fa37a" stroke-width="0"/>`),
  offers: icon('#f0a020', `<path d="M180 230 L290 130 H420 V260 L310 360Z" stroke-width="10"/><circle cx="370" cy="180" r="18" fill="#f0a020" stroke-width="0"/>`),
  events: icon('#3f6fd6', `<rect x="180" y="150" width="240" height="200" rx="18" stroke-width="0"/><rect x="180" y="150" width="240" height="56" rx="18" fill="#2a4fa8" stroke-width="0"/><rect x="225" y="120" width="20" height="50" rx="8" stroke-width="0"/><rect x="355" y="120" width="20" height="50" rx="8" stroke-width="0"/><g fill="#3f6fd6" stroke-width="0"><rect x="212" y="236" width="36" height="30" rx="4"/><rect x="282" y="236" width="36" height="30" rx="4"/><rect x="352" y="236" width="36" height="30" rx="4"/><rect x="212" y="290" width="36" height="30" rx="4"/><rect x="282" y="290" width="36" height="30" rx="4"/></g>`),
};

// ---------- Speakers: simple portrait illustrations (square) ----------
function portrait(bg: string, skin: string, hair: string, shirt: string, style: 'short' | 'long' | 'bun' | 'cap'): string {
  const S = 400;
  const hairShape = {
    short: `<path d="M140 185 Q140 105 200 105 Q260 105 260 185 Q235 150 200 150 Q165 150 140 185Z" fill="${hair}"/>`,
    long: `<path d="M132 230 Q120 100 200 100 Q280 100 268 230 L262 200 Q262 140 200 140 Q138 140 138 200Z" fill="${hair}"/>`,
    bun: `<circle cx="200" cy="90" r="30" fill="${hair}"/><path d="M140 185 Q140 108 200 108 Q260 108 260 185 Q235 150 200 150 Q165 150 140 185Z" fill="${hair}"/>`,
    cap: `<path d="M138 175 Q140 100 200 100 Q260 100 262 175Z" fill="${hair}"/><rect x="130" y="168" width="140" height="14" rx="7" fill="${hair}"/>`,
  }[style];
  return svg(
    `<rect width="${S}" height="${S}" fill="${bg}"/><path d="M60 400 Q70 290 200 285 Q330 290 340 400Z" fill="${shirt}"/>` +
    `<rect x="178" y="240" width="44" height="55" rx="14" fill="${skin}"/><ellipse cx="200" cy="190" rx="62" ry="72" fill="${skin}"/>${hairShape}` +
    `<circle cx="178" cy="195" r="5" fill="#2f323b"/><circle cx="222" cy="195" r="5" fill="#2f323b"/><path d="M180 225 Q200 242 220 225" stroke="#2f323b" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    S, S,
  );
}
const SPEAKERS: Record<string, string> = {
  layla: portrait('#ffd9c9', '#e3b08a', '#2b1d17', '#d6247f', 'long'),
  omar: portrait('#cfe6f5', '#c68b64', '#1d1a19', '#2f5f8a', 'short'),
  sofia: portrait('#e6e0f5', '#f0c7a5', '#8a4b2b', '#2fa37a', 'bun'),
  daniel: portrait('#d9efe0', '#8a5a3c', '#14110f', '#3f3f5a', 'cap'),
  mei: portrait('#fdeac4', '#f4d2b0', '#1c1a22', '#f15822', 'long'),
  arjun: portrait('#fbd6dc', '#b9784f', '#1f1613', '#4a6fd6', 'short'),
};

/** The drawing for each art key used by the ready-made content (see presets in @cl/shared). */
export const SAMPLE_ART: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [`destinations/${k}`, v])),
  ...Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [`products/${k}`, v])),
  ...Object.fromEntries(Object.entries(COLUMNS).map(([k, v]) => [`two_column/${k}`, v])),
  ...Object.fromEntries(Object.entries(SPEAKERS).map(([k, v]) => [`speakers/${k}`, v])),
};

let rendered: Map<string, { buf: Buffer; width: number; height: number }> | null = null;

async function renderAll(): Promise<NonNullable<typeof rendered>> {
  if (rendered) return rendered;
  const sharp = (await import('sharp')).default;
  const out = new Map<string, { buf: Buffer; width: number; height: number }>();
  for (const key of SAMPLE_ART_KEYS) {
    const drawing = SAMPLE_ART[key];
    if (!drawing) throw new Error(`No sample picture drawn for "${key}"`);
    const buf = await sharp(Buffer.from(drawing)).png({ compressionLevel: 9, palette: true }).toBuffer();
    const meta = await sharp(buf).metadata();
    out.set(key, { buf, width: meta.width ?? W, height: meta.height ?? H });
  }
  rendered = out;
  return out;
}

/**
 * Makes sure the built-in sample pictures exist in the asset library (fixed ids, safe to run on every start).
 * They are named "Sample - ..." so they are easy to tell apart from the team's own pictures.
 */
export async function seedSamplePictures(q: Queryable): Promise<void> {
  const ids = SAMPLE_ART_KEYS.map(sampleAssetId);
  const have = await q.query<{ id: string }>('SELECT id FROM asset WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [DEFAULT_WORKSPACE_ID, ids]);
  if (have.rows.length === ids.length) return;
  const known = new Set(have.rows.map((r) => r.id));
  const all = await renderAll();
  const { createHash } = await import('node:crypto');
  for (const key of SAMPLE_ART_KEYS) {
    const id = sampleAssetId(key);
    if (known.has(id)) continue;
    const { buf, width, height } = all.get(key)!;
    const sha = createHash('sha256').update(buf).digest('hex');
    await q.query(
      `INSERT INTO asset (id, workspace_id, filename, mime, size_bytes, width, height, sha256, data, created_by, created_at)
       VALUES ($1, $2, $3, 'image/png', $4, $5, $6, $7, $8, NULL, TIMESTAMPTZ '2000-01-01')
       ON CONFLICT DO NOTHING`,
      [id, DEFAULT_WORKSPACE_ID, `Sample - ${key.replace('/', ' - ')}.png`, buf.length, width, height, sha, buf],
    );
  }
}
