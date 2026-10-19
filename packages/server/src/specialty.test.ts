import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCK_DEFINITIONS, PALETTE_IDS, PALETTES, SPECIALTY_TYPES, blockDefinition, canonicalJson, createInstance, emptyContent, starterContent, validateContent,
  type BlockDefinition, type EmailContent, type PaletteId,
} from '@cl/shared';
import { renderEmail } from './render.js';
import { createTestApp, type Client, type TestApp } from './testkit.js';

let t: TestApp;
let builder: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
});
afterAll(() => t.close());

const specialty = BLOCK_DEFINITIONS.filter((d) => d.category !== 'shared');
const inst = (type: string) => createInstance(blockDefinition(type)!);

describe('template-specific blocks', () => {
  it('there are four for each template, matching what was agreed', () => {
    const by = (p: PaletteId) => specialty.filter((d) => d.category === p).map((d) => d.type);
    expect(by('travel')).toEqual(['destinations', 'fares', 'travel_offer', 'booking_cta']);
    expect(by('events')).toEqual(['event_details', 'agenda', 'speakers', 'registration_cta']);
    expect(by('cosmetics')).toEqual(['products', 'benefits', 'promo_offer', 'shopping_cta']);
    expect(specialty.map((d) => d.type).sort()).toEqual([...SPECIALTY_TYPES].sort());
  });

  it('every one starts valid, with no color controls, and has an alias next to every link', () => {
    for (const def of specialty) {
      const v = validateContent({ ...emptyContent(def.category as PaletteId), blocks: [createInstance(def)] });
      expect(v.ok, `${def.type}: ${!v.ok ? v.error : ''}`).toBe(true);
      expect(def.fields.map((f) => f.kind as string)).not.toContain('color');
      for (const f of def.fields.filter((x) => x.kind === 'url')) {
        const alias = def.fields[def.fields.indexOf(f) + 1];
        expect(alias?.key, `${def.type}.${f.key}`).toBe(`${f.key}Alias`);
        expect(typeof def.defaults[`${f.key}Alias`]).toBe('string');
      }
    }
  });

  it('a template block can only be used in an email of that template', () => {
    for (const def of specialty) {
      for (const palette of PALETTE_IDS) {
        const v = validateContent({ ...emptyContent(palette), blocks: [createInstance(def)] });
        expect(v.ok, `${def.type} in ${palette}`).toBe(def.category === palette);
        if (!v.ok) expect(v.error).toContain('cannot be used in this email');
      }
    }
  });

  it('the editor can only add them to the right emails (server refuses a travel block in an events email)', async () => {
    const events = (await builder.post('/api/campaigns', { name: 'Events', palette: 'events' })).body;
    const travelBlock = inst('destinations');
    const res = await builder.put(`/api/campaigns/${events.id}/draft`, { content: { ...events.draft.content, blocks: [travelBlock] }, baseVersion: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('travel template');
    const ok = await builder.put(`/api/campaigns/${events.id}/draft`, { content: { ...events.draft.content, blocks: [inst('agenda')] }, baseVersion: 1 });
    expect(ok.status).toBe(200);
  });

  it('render with the palette colors, escape typed text, and leave empty cards out', async () => {
    const dest = inst('destinations');
    dest.props.c1Name = '<script>alert(1)</script>';
    dest.props.c3Name = '';
    dest.props.c3Detail = '';
    dest.props.c3Price = '';
    dest.props.c3ButtonText = '';
    const html = (await renderEmail({ ...emptyContent('travel'), blocks: [dest] })).html;
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Lisbon');
    expect(html).not.toContain('Cairo'); // the third card was emptied
    expect(html.toLowerCase()).toContain(PALETTES.travel.button);

    const promo = inst('promo_offer');
    const promoHtml = (await renderEmail({ ...emptyContent('cosmetics'), blocks: [promo] })).html.toLowerCase();
    expect(promoHtml).toContain(PALETTES.cosmetics.accent);
    expect(promoHtml).toContain('welcome20');
  });
});

describe('starter layouts', () => {
  it('each template has one, made only of blocks that template may use, with a subject and preview text', () => {
    for (const palette of PALETTE_IDS) {
      const c = starterContent(palette);
      expect(c.settings.palette).toBe(palette);
      expect(c.settings.subject.length).toBeGreaterThan(5);
      expect(c.settings.preheader.length).toBeGreaterThan(5);
      expect(c.blocks.length).toBeGreaterThanOrEqual(5);
      const v = validateContent(c);
      expect(v.ok, `${palette}: ${!v.ok ? v.error : ''}`).toBe(true);
      const own = c.blocks.filter((b) => blockDefinition(b.type)!.category === palette).length;
      expect(own, `${palette} should use its own specialty blocks`).toBeGreaterThanOrEqual(3);
      expect(new Set(c.blocks.map((b) => b.id)).size).toBe(c.blocks.length);
    }
    expect(starterContent('travel').blocks.map((b) => b.type)).toEqual(['hero', 'travel_offer', 'destinations', 'fares', 'text', 'booking_cta']);
    expect(starterContent('events').blocks.map((b) => b.type)).toEqual(['hero', 'event_details', 'text', 'agenda', 'speakers', 'registration_cta']);
    expect(starterContent('cosmetics').blocks.map((b) => b.type)).toEqual(['hero', 'products', 'benefits', 'promo_offer', 'two_column', 'shopping_cta']);
  });

  it('every starter renders to a complete email with no rendering problems', async () => {
    for (const palette of PALETTE_IDS) {
      const { html, warnings } = await renderEmail(starterContent(palette));
      expect(warnings, palette).toEqual([]);
      expect(html).toContain('Unsubscribe');
      expect(html.toLowerCase()).toContain(PALETTES[palette].primary);
    }
  });

  it('creating a campaign "from the ready-made layout" gives independent copies; blank stays blank', async () => {
    const a = (await builder.post('/api/campaigns', { name: 'Starter A', palette: 'cosmetics', starter: true })).body;
    const b = (await builder.post('/api/campaigns', { name: 'Starter B', palette: 'cosmetics', starter: true })).body;
    const blank = (await builder.post('/api/campaigns', { name: 'Blank', palette: 'cosmetics' })).body;
    expect(a.draft.content.blocks.map((x: { type: string }) => x.type)).toEqual(['hero', 'products', 'benefits', 'promo_offer', 'two_column', 'shopping_cta']);
    expect(blank.draft.content.blocks).toEqual([]);
    // different ids, same starting words
    expect(a.draft.content.blocks[0].id).not.toBe(b.draft.content.blocks[0].id);
    expect(canonicalJson(a.draft.content.blocks.map((x: { props: unknown }) => x.props))).toBe(canonicalJson(b.draft.content.blocks.map((x: { props: unknown }) => x.props)));

    // editing A never changes B, or the starting layout itself
    const edited: EmailContent = JSON.parse(JSON.stringify(a.draft.content));
    edited.blocks[1]!.props.c1Name = 'Edited in A only';
    expect((await builder.put(`/api/campaigns/${a.id}/draft`, { content: edited, baseVersion: 1 })).status).toBe(200);
    expect((await builder.get(`/api/campaigns/${b.id}`)).body.draft.content.blocks[1].props.c1Name).toBe('Hydrating serum');
    expect((starterContent('cosmetics').blocks[1] as { props: Record<string, unknown> }).props.c1Name).toBe('Hydrating serum');
  });

  it('a starter email previews with its own template header and colors', async () => {
    for (const [palette, name] of [['travel', 'Fly'], ['events', 'Agenda'], ['cosmetics', 'PrettyWoman']] as const) {
      const c = (await builder.post('/api/campaigns', { name: `${name} starter`, palette, starter: true })).body;
      const html = ((await builder.get(`/api/campaigns/${c.id}/preview`)).body.html as string);
      expect(html).toContain(name);
      expect(html.toLowerCase()).toContain(PALETTES[palette].primary);
    }
  });

  it('the library lists the template blocks with their template, for the editor to filter', async () => {
    const lib = (await builder.get('/api/library/blocks')).body.blocks as BlockDefinition[];
    expect(lib.filter((d) => d.category === 'events').map((d) => d.type)).toEqual(['event_details', 'agenda', 'speakers', 'registration_cta']);
    expect(lib.filter((d) => d.category === 'shared').length).toBe(8);
  });
});

describe('stacked columns on a phone', () => {
  it('Two columns keep a gap under each column so stacked items do not touch, without changing the total spacing', async () => {
    const two = inst('two_column');
    const { html } = await renderEmail({ ...emptyContent('cosmetics'), blocks: [two] });
    // each of the two columns has 24px of space below it
    expect((html.match(/padding:\s*0 12px 24px/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // the section's own bottom space is reduced by the same amount (default 24 → 0), so desktop spacing is unchanged
    expect(html).toMatch(/padding:\s*24px 12px 0px/);
  });

  it('every row of columns keeps a gap under its columns (cards, speakers, benefits, event facts)', async () => {
    for (const [type, palette] of [['destinations', 'travel'], ['speakers', 'events'], ['benefits', 'cosmetics'], ['products', 'cosmetics']] as const) {
      const { html } = await renderEmail({ ...emptyContent(palette), blocks: [inst(type)] });
      expect(html, type).toMatch(/padding:\s*0 12px 16px/);
    }
  });
});
