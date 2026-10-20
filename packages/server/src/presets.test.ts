import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_PRESETS, applyPreset, blockDefinition, checkField, createInstance, emptyContent, matchingPreset, presetKeys, validateContent, type PaletteId } from '@cl/shared';

describe('ready-made content for blocks with text and pictures', () => {
  it('is offered only for the picture-and-text blocks, never hero, plain text, button, header or footer', () => {
    expect(Object.keys(BLOCK_PRESETS).sort()).toEqual(['destinations', 'products', 'speakers', 'two_column']);
    for (const type of Object.keys(BLOCK_PRESETS)) {
      expect(blockDefinition(type)!.fields.some((f) => f.kind === 'image'), type).toBe(true);
    }
    for (const type of ['hero', 'text', 'button', 'header', 'footer']) expect(BLOCK_PRESETS[type]).toBeUndefined();
  });

  it('every preset only fills existing text fields with valid values, and never pictures, links or spacing', () => {
    for (const [type, presets] of Object.entries(BLOCK_PRESETS)) {
      const def = blockDefinition(type)!;
      expect(presets.length, type).toBeGreaterThanOrEqual(3);
      expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
      for (const p of presets) {
        for (const [key, value] of Object.entries(p.props)) {
          const f = def.fields.find((x) => x.key === key);
          expect(f, `${type}/${p.id}: ${key} exists`).toBeDefined();
          expect(['text', 'textarea'], `${type}/${p.id}: ${key}`).toContain(f!.kind);
          expect(checkField(f!, value), `${type}/${p.id}: ${key}`).toBeNull();
        }
      }
    }
  });

  it('applying one fills the words, keeps pictures, links and spacing, and the email stays valid', () => {
    for (const [type, presets] of Object.entries(BLOCK_PRESETS)) {
      const def = blockDefinition(type)!;
      const palette = def.category === 'shared' ? 'cosmetics' : (def.category as PaletteId);
      const block = createInstance(def);
      const mine = Object.fromEntries(def.fields.filter((f) => f.kind === 'image' || f.kind === 'url' || f.kind === 'number').map((f) => [f.key, f.kind === 'image' ? 'https://example.com/a.png' : block.props[f.key]!]));
      for (const preset of presets) {
        const next = applyPreset(type, { ...block.props, ...mine }, preset.id);
        for (const [k, v] of Object.entries(preset.props)) expect(next[k]).toBe(v);
        for (const [k, v] of Object.entries(mine)) expect(next[k], `${type}/${preset.id}: ${k} untouched`).toBe(v);
        expect(matchingPreset(type, next)?.id).toBe(preset.id);
        const v = validateContent({ ...emptyContent(palette), blocks: [{ ...block, props: next }] });
        expect(v.ok, `${type}/${preset.id}: ${!v.ok ? v.error : ''}`).toBe(true);
      }
    }
  });

  it('picture descriptions follow the new name, but a description someone wrote is kept', () => {
    const def = blockDefinition('products')!;
    const base = createInstance(def).props; // c1ImageAlt equals the default name
    const p = BLOCK_PRESETS.products![1]!;
    expect(applyPreset('products', base, p.id).c1ImageAlt).toBe(p.props.c1Name);
    const written = applyPreset('products', { ...base, c1ImageAlt: 'A bottle on a marble shelf' }, p.id);
    expect(written.c1ImageAlt).toBe('A bottle on a marble shelf');
    const two = createInstance(blockDefinition('two_column')!).props;
    const t = BLOCK_PRESETS.two_column![0]!;
    expect(applyPreset('two_column', { ...two, leftImageAlt: '' }, t.id).leftImageAlt).toBe(t.props.leftHeading);
  });

  it('presetKeys lists the words that are hidden while ready-made content is on', () => {
    const keys = presetKeys('two_column');
    expect(keys.has('leftHeading')).toBe(true);
    expect(keys.has('leftImage')).toBe(false);
    expect(keys.has('leftButtonUrl')).toBe(false);
    expect(BLOCK_DEFINITIONS.length).toBeGreaterThan(0);
  });
});
