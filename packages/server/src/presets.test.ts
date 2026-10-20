import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCK_PRESETS, SAMPLE_ART_KEYS, applyItem, blockDefinition, checkField, createInstance, emptyContent, matchingItem, presetKeys, sampleAssetId, validateContent,
  type PaletteId,
} from '@cl/shared';
import { SAMPLE_ART } from './sampleart.js';
import { createTestApp, type Client, type TestApp } from './testkit.js';

let t: TestApp;
let builder: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
});
afterAll(() => t.close());

describe('ready-made content: one drop-down for each item of a picture-and-text block', () => {
  it('is offered only for the picture-and-text blocks, never hero, text, button, header or footer', () => {
    expect(Object.keys(BLOCK_PRESETS).sort()).toEqual(['destinations', 'products', 'speakers', 'travel_offer', 'two_column']);
    for (const type of ['hero', 'text', 'button', 'header', 'footer']) expect(BLOCK_PRESETS[type]).toBeUndefined();
  });

  it('has one drop-down per item: 3 speakers, 3 destinations, 3 products, 2 columns', () => {
    expect(BLOCK_PRESETS.speakers!.slots.map((s) => s.label)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 3']);
    expect(BLOCK_PRESETS.destinations!.slots).toHaveLength(3);
    expect(BLOCK_PRESETS.products!.slots).toHaveLength(3);
    expect(BLOCK_PRESETS.two_column!.slots.map((s) => s.label)).toEqual(['Left column', 'Right column']);
    expect(BLOCK_PRESETS.travel_offer!.slots.map((s) => s.label)).toEqual(['Offer']);
  });

  it('Two columns, Products and Destinations also fill the button link and its alias; Destinations leave the price to the Builder', () => {
    for (const type of ['two_column', 'products', 'destinations']) {
      const keys = [...presetKeys(type)];
      expect(keys.some((k) => k.endsWith('ButtonUrl')), type).toBe(true);
      expect(keys.some((k) => k.endsWith('ButtonUrlAlias')), type).toBe(true);
      const def = blockDefinition(type)!;
      const next = applyItem(type, createInstance(def).props, 0, BLOCK_PRESETS[type]!.items[0]!.id);
      const prefix = BLOCK_PRESETS[type]!.slots[0]!.prefix;
      expect(String(next[`${prefix}ButtonUrl`])).toMatch(/^https:\/\//);
      expect(String(next[`${prefix}ButtonUrlAlias`]).length).toBeGreaterThan(3);
    }
    const d = presetKeys('destinations');
    expect([...d].some((k) => k.endsWith('Price'))).toBe(false);
    const base = createInstance(blockDefinition('destinations')!).props;
    const next = applyItem('destinations', { ...base, c1Price: 'from AED 1,234' }, 0, 'paris');
    expect(next.c1Price).toBe('from AED 1,234'); // a price the Builder typed survives
    expect(next.c1Name).toBe('Paris');
  });

  it('Travel offer has one drop-down that fills the whole banner including its button link and alias', () => {
    const def = blockDefinition('travel_offer')!;
    const next = applyItem('travel_offer', createInstance(def).props, 0, 'lounge');
    expect(next.highlight).toBe('LOUNGE ACCESS INCLUDED');
    expect(next.eyebrow).toBeTruthy();
    expect(String(next.buttonUrl)).toMatch(/^https:\/\//);
    expect(next.buttonUrlAlias).toBeTruthy();
    expect(next.align).toBe('center'); // layout choices are untouched
    expect(matchingItem('travel_offer', 0, next)?.id).toBe('lounge');
    expect(presetKeys('travel_offer').has('paddingY')).toBe(false);
  });

  it('every entry only fills real text and picture fields with valid values, and never links or spacing', () => {
    for (const [type, b] of Object.entries(BLOCK_PRESETS)) {
      const def = blockDefinition(type)!;
      const keys = presetKeys(type);
      for (const k of keys) {
        const f = def.fields.find((x) => x.key === k);
        expect(f, `${type}.${k} exists`).toBeDefined();
        expect(['text', 'textarea', 'image', 'url']).toContain(f!.kind);
      }
      expect(b.items.length, type).toBeGreaterThanOrEqual(6);
      expect(b.slots.length).toBeGreaterThan(0);
      const props = createInstance(def).props;
      for (const slot of b.slots.keys()) {
        for (const item of b.items) {
          const next = applyItem(type, props, slot, item.id);
          for (const k of Object.keys(next)) {
            if (next[k] === props[k]) continue;
            const f = def.fields.find((x) => x.key === k)!;
            expect(checkField(f, next[k]!), `${type}/${item.id}.${k}`).toBeNull();
          }
        }
      }
    }
  });

  it('choosing an entry for one item changes only that item; links, spacing and other items stay', () => {
    for (const [type, b] of Object.entries(BLOCK_PRESETS)) {
      const def = blockDefinition(type)!;
      const base = createInstance(def).props;
      const [first, second] = [b.items[0]!, b.items[1]!];
      const after1 = applyItem(type, base, 0, first.id);
      const after2 = applyItem(type, after1, 1, second.id);
      expect(matchingItem(type, 0, after2)?.id).toBe(first.id);
      if (b.slots[1]) expect(matchingItem(type, 1, after2)?.id).toBe(second.id);
      const mine = presetKeys(type);
      const slot0 = b.slots[0]!.prefix;
      for (const [k, v] of Object.entries(after2)) {
        if (!mine.has(k)) expect(v, `${type}.${k} untouched`).toBe(base[k]);
      }
      // the third item (if there is one) is untouched by choosing for items 1 and 2
      if (b.slots[2]) for (const f of b.fields.map((x) => `${b.slots[2]!.prefix}${x}`)) expect(after2[f]).toBe(base[f]);
      // the picture comes with the words
      if (first.art) {
        expect(after1[`${slot0}Image`]).toBe(`asset:${sampleAssetId(first.art)}`);
        expect(String(after1[`${slot0}ImageAlt`]).length).toBeGreaterThan(3);
      }
    }
  });

  it('the email stays valid with any entry in any slot', () => {
    for (const [type] of Object.entries(BLOCK_PRESETS)) {
      const def = blockDefinition(type)!;
      const palette = def.category === 'shared' ? 'cosmetics' : (def.category as PaletteId);
      let props = createInstance(def).props;
      BLOCK_PRESETS[type]!.slots.forEach((_, slot) => { props = applyItem(type, props, slot, BLOCK_PRESETS[type]!.items[slot + 2]!.id); });
      const v = validateContent({ ...emptyContent(palette), blocks: [{ ...createInstance(def), props }] });
      expect(v.ok, `${type}: ${!v.ok ? v.error : ''}`).toBe(true);
    }
  });

  it('every entry has a drawn picture, with ids that are unique and well-formed', () => {
    expect(new Set(SAMPLE_ART_KEYS).size).toBe(SAMPLE_ART_KEYS.length);
    for (const key of SAMPLE_ART_KEYS) {
      expect(SAMPLE_ART[key], key).toBeDefined();
      expect(sampleAssetId(key)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(SAMPLE_ART_KEYS.map(sampleAssetId)).size).toBe(SAMPLE_ART_KEYS.length);
  });

  it('the sample pictures exist in the library, can be used in an email and are served', async () => {
    const lib = (await builder.get('/api/assets')).body as { id: string; filename: string }[];
    for (const key of SAMPLE_ART_KEYS) expect(lib.some((a) => a.id === sampleAssetId(key)), key).toBe(true);
    const c = (await builder.post('/api/campaigns', { name: 'Presets', palette: 'events' })).body;
    const def = blockDefinition('speakers')!;
    let props = createInstance(def).props;
    props = applyItem('speakers', props, 0, 'layla');
    props = applyItem('speakers', props, 1, 'omar');
    const res = await builder.put(`/api/campaigns/${c.id}/draft`, { content: { ...c.draft.content, blocks: [{ ...createInstance(def), props }] }, baseVersion: 1 });
    expect(res.status).toBe(200);
    const html = (await builder.get(`/api/campaigns/${c.id}/preview`)).body.html as string;
    expect(html).toContain('Layla Haddad');
    expect(html).toContain('Omar Khalid');
    expect(html).toContain(`/media/${sampleAssetId('speakers/layla')}/square-240.jpg`);
    const img = await t.app.inject({ url: `/media/${sampleAssetId('speakers/layla')}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });
});
