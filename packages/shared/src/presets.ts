import type { Props } from './fields.js';

// Ready-made content for blocks that mix pictures and text. Each item in a block (a speaker, a destination, a product,
// the left or right column) has its own drop-down. Choosing an entry fills that item's picture, picture description
// and words. Links, link aliases and spacing are never touched.
// Wording is original sample text. Names, people and prices are made up on purpose ("AED 000"): they must be replaced
// with real details before an email is sent. Pictures are original illustrations (see sampleart.ts on the server).

export type ItemPreset = {
  id: string;
  /** Shown in the drop-down. */
  label: string;
  /** Which illustration to use (one picture per key). */
  art: string;
  /** Values for the item's fields, keyed by field suffix (e.g. Name, Detail). The picture is added from `art`. */
  values: Record<string, string>;
};

export type PresetBlock = {
  /** The items of the block, each with its own drop-down. `prefix` is the start of its property keys (c1, p2, left). */
  slots: { label: string; prefix: string }[];
  /** Field suffixes a preset fills (the picture and picture description are always included). */
  fields: string[];
  items: ItemPreset[];
};

/** A fixed, valid id for a built-in sample picture, so every environment refers to the same pictures. */
export function sampleAssetId(art: string): string {
  const hex = (seed: number): string => {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < art.length; i++) h = Math.imul(h ^ art.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, '0');
  };
  const h = hex(1) + hex(2) + hex(3) + hex(4);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const price = 'AED 000';

const dest = (id: string, name: string, detail: string): ItemPreset => ({ id, label: name, art: `destinations/${id}`, values: { Name: name, Detail: detail, Price: `from ${price}`, ButtonText: 'Book now', ImageAlt: `Illustration for ${name}` } });
const product = (id: string, name: string, detail: string): ItemPreset => ({ id, label: name, art: `products/${id}`, values: { Name: name, Detail: detail, Price: price, ButtonText: 'Shop now', ImageAlt: `Illustration of ${name.toLowerCase()}` } });
const column = (id: string, heading: string, body: string, button: string): ItemPreset => ({ id, label: heading, art: `two_column/${id}`, values: { Heading: heading, Body: body, ButtonText: button, ImageAlt: `Illustration for ${heading.toLowerCase()}` } });
const speaker = (id: string, name: string, role: string, bio: string): ItemPreset => ({ id, label: `${name} (${role.split(',')[0]})`, art: `speakers/${id}`, values: { Name: name, Role: role, Bio: bio, ImageAlt: `Portrait illustration of ${name}` } });

export const BLOCK_PRESETS: Record<string, PresetBlock> = {
  two_column: {
    slots: [{ label: 'Left column', prefix: 'left' }, { label: 'Right column', prefix: 'right' }],
    fields: ['Image', 'ImageAlt', 'Heading', 'Body', 'ButtonText'],
    items: [
      column('delivery', 'Free delivery', 'On every order over AED 200, straight to your door.', 'Shop now'),
      column('returns', 'Easy returns', 'Changed your mind? Send it back within 30 days.', 'How returns work'),
      column('new', 'New arrivals', 'Fresh picks that just landed. Be the first to try them.', 'See what is new'),
      column('bestsellers', 'Best sellers', 'The favourites our customers keep coming back for.', 'Shop best sellers'),
      column('story', 'Our story', 'Learn who we are and what we care about.', 'Read our story'),
      column('help', 'Need help?', 'Our team is happy to answer your questions.', 'Contact us'),
      column('offers', 'Special offers', 'Limited-time deals chosen just for our subscribers.', 'View offers'),
      column('events', 'Upcoming events', 'Save the date for what is coming up next.', 'See the calendar'),
    ],
  },
  destinations: {
    slots: [1, 2, 3].map((i) => ({ label: `Destination ${i}`, prefix: `c${i}` })),
    fields: ['Image', 'ImageAlt', 'Name', 'Detail', 'Price', 'ButtonText'],
    items: [
      dest('paris', 'Paris', 'Short flights, long weekends'),
      dest('rome', 'Rome', 'History and great food'),
      dest('prague', 'Prague', 'Fairytale old town'),
      dest('maldives', 'Maldives', 'Overwater villas and calm lagoons'),
      dest('phuket', 'Phuket', 'Beaches for every mood'),
      dest('cairo', 'Cairo', 'Ancient wonders, modern buzz'),
      dest('bangkok', 'Bangkok', 'Street food and temples'),
      dest('tokyo', 'Tokyo', 'Tradition meets the future'),
      dest('muscat', 'Muscat', 'Mountains, coast and calm'),
    ],
  },
  products: {
    slots: [1, 2, 3].map((i) => ({ label: `Product ${i}`, prefix: `c${i}` })),
    fields: ['Image', 'ImageAlt', 'Name', 'Detail', 'Price', 'ButtonText'],
    items: [
      product('serum', 'Hydrating serum', 'Lightweight daily boost'),
      product('moisturiser', 'Daily moisturiser', 'Soft, comfortable all day'),
      product('cleanser', 'Gentle cleanser', 'Fresh skin, never tight'),
      product('lipstick', 'Soft matte lipstick', 'Comfortable colour that lasts'),
      product('mascara', 'Volume mascara', 'Bold lashes, no clumps'),
      product('highlighter', 'Glow highlighter', 'A healthy, lit-from-within look'),
      product('shampoo', 'Repair shampoo', 'Cleans and strengthens'),
      product('mist', 'Leave-in mist', 'Shine and frizz control'),
      product('giftset', 'Gift set', 'Three favourites in one box'),
    ],
  },
  speakers: {
    slots: [1, 2, 3].map((i) => ({ label: `Speaker ${i}`, prefix: `p${i}` })),
    fields: ['Image', 'ImageAlt', 'Name', 'Role', 'Bio'],
    items: [
      speaker('layla', 'Layla Haddad', 'Keynote speaker, Example Co', 'Opens the day with a look at where the industry is heading.'),
      speaker('omar', 'Omar Khalid', 'Panel moderator, Sample Media', 'Guides a lively conversation with leaders from across the field.'),
      speaker('sofia', 'Sofia Marin', 'Workshop leader, Demo Studio', 'A hands-on session you can put into practice the same day.'),
      speaker('daniel', 'Daniel Okafor', 'Industry expert, Sample Group', 'Explains the trends worth paying attention to this year.'),
      speaker('mei', 'Mei Tanaka', 'Founder, Example Labs', 'Tells the story behind building a business from scratch.'),
      speaker('arjun', 'Arjun Rao', 'Researcher, Demo Institute', 'Shares fresh data and what it means for you.'),
    ],
  },
};

/** Types that offer ready-made content. */
export const PRESET_TYPES = Object.keys(BLOCK_PRESETS);

/** Every illustration that presets refer to. */
export const SAMPLE_ART_KEYS: string[] = Object.values(BLOCK_PRESETS).flatMap((b) => b.items.map((i) => i.art));

/** The full property values an entry gives to an item: its words plus the picture. */
function itemProps(item: ItemPreset, prefix: string): Props {
  const out: Props = {};
  for (const [suffix, value] of Object.entries({ ...item.values, Image: `asset:${sampleAssetId(item.art)}` })) out[`${prefix}${suffix}`] = value;
  return out;
}

/** Property keys filled by presets for a block (hidden while "ready-made content" is on). */
export function presetKeys(type: string): Set<string> {
  const b = BLOCK_PRESETS[type];
  return new Set(b ? b.slots.flatMap((s) => b.fields.map((f) => `${s.prefix}${f}`)) : []);
}

/** The entry that currently matches one item of the block, if any. */
export function matchingItem(type: string, slot: number, props: Props): ItemPreset | undefined {
  const b = BLOCK_PRESETS[type];
  const s = b?.slots[slot];
  if (!b || !s) return undefined;
  return b.items.find((it) => Object.entries(itemProps(it, s.prefix)).every(([k, v]) => props[k] === v));
}

/** Props after choosing an entry for one item. Everything else in the block, including the other items, stays as it was. */
export function applyItem(type: string, props: Props, slot: number, itemId: string): Props {
  const b = BLOCK_PRESETS[type];
  const s = b?.slots[slot];
  const item = b?.items.find((i) => i.id === itemId);
  if (!b || !s || !item) return props;
  return { ...props, ...itemProps(item, s.prefix) };
}
