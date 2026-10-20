import type { Props } from './fields.js';

// Ready-made wording for blocks that mix pictures and text. Choosing one fills in the words so nobody has to type
// every field. Presets never touch pictures, links or spacing: those stay as the Builder set them.
// All wording is original sample text. Prices are shown as "AED 000" on purpose: real names, prices and details
// must be filled in before an email is sent.

export type BlockPreset = { id: string; label: string; props: Props };

/** Words for three cards (destinations, products): keys c1Name, c1Detail, c1Price, c1ButtonText. */
function cards(id: string, label: string, heading: string, button: string, rows: [string, string, string][]): BlockPreset {
  const props: Props = { heading };
  rows.forEach(([name, detail, price], i) => {
    props[`c${i + 1}Name`] = name;
    props[`c${i + 1}Detail`] = detail;
    props[`c${i + 1}Price`] = price;
    props[`c${i + 1}ButtonText`] = button;
  });
  return { id, label, props };
}

function columns(id: string, label: string, l: [string, string, string], r: [string, string, string]): BlockPreset {
  return {
    id, label,
    props: { leftHeading: l[0], leftBody: l[1], leftButtonText: l[2], rightHeading: r[0], rightBody: r[1], rightButtonText: r[2] },
  };
}

/** Role and bio for three speakers (names are left for the Builder): keys p1Role, p1Bio. */
function people(id: string, label: string, heading: string, rows: [string, string][]): BlockPreset {
  const props: Props = { heading };
  rows.forEach(([role, bio], i) => {
    props[`p${i + 1}Role`] = role;
    props[`p${i + 1}Bio`] = bio;
  });
  return { id, label, props };
}

export const BLOCK_PRESETS: Record<string, BlockPreset[]> = {
  two_column: [
    columns('delivery_returns', 'Free delivery and easy returns', ['Free delivery', 'On every order over AED 200, straight to your door.', 'Shop now'], ['Easy returns', 'Changed your mind? Send it back within 30 days.', 'How returns work']),
    columns('new_bestsellers', 'New arrivals and best sellers', ['New arrivals', 'Fresh picks that just landed. Be the first to try them.', 'See what is new'], ['Best sellers', 'The favourites our customers keep coming back for.', 'Shop best sellers']),
    columns('story_contact', 'Our story and contact us', ['Our story', 'Learn who we are and what we care about.', 'Read our story'], ['Need help?', 'Our team is happy to answer your questions.', 'Contact us']),
    columns('guides_offers', 'Guides and special offers', ['Helpful guides', 'Simple tips to help you get the most out of every purchase.', 'Read the guides'], ['Special offers', 'Limited-time deals chosen just for our subscribers.', 'View offers']),
    columns('events_news', 'Upcoming events and latest news', ['Upcoming events', 'Save the date for what is coming up next.', 'See the calendar'], ['Latest news', 'A quick update on what has been happening lately.', 'Read the news']),
  ],
  destinations: [
    cards('city_breaks', 'European city breaks', 'City breaks to love', 'Book now', [['Paris', 'Short flights, long weekends', 'from AED 000'], ['Rome', 'History and great food', 'from AED 000'], ['Prague', 'Fairytale old town', 'from AED 000']]),
    cards('beach', 'Beach getaways', 'Sun, sea and sand', 'Book now', [['Maldives', 'Overwater villas and calm lagoons', 'from AED 000'], ['Phuket', 'Beaches for every mood', 'from AED 000'], ['Zanzibar', 'White sand and turquoise water', 'from AED 000']]),
    cards('region', 'Middle East and Africa', 'Closer than you think', 'Book now', [['Cairo', 'Ancient wonders, modern buzz', 'from AED 000'], ['Amman', 'Gateway to Petra and the Dead Sea', 'from AED 000'], ['Nairobi', 'Safari adventures start here', 'from AED 000']]),
    cards('asia', 'Asian adventures', 'Adventures in Asia', 'Book now', [['Bangkok', 'Street food and temples', 'from AED 000'], ['Tokyo', 'Tradition meets the future', 'from AED 000'], ['Singapore', 'Gardens, skyline and flavours', 'from AED 000']]),
    cards('weekend', 'Weekend escapes', 'Quick weekend escapes', 'Book now', [['Muscat', 'Mountains and coast', 'from AED 000'], ['Doha', 'Museums and waterfront', 'from AED 000'], ['Salalah', 'Green hills and beaches', 'from AED 000']]),
  ],
  products: [
    cards('skincare', 'Skin care essentials', 'Skin care essentials', 'Shop now', [['Hydrating serum', 'Lightweight daily boost', 'AED 000'], ['Daily moisturiser', 'Soft, comfortable all day', 'AED 000'], ['Gentle cleanser', 'Fresh skin, never tight', 'AED 000']]),
    cards('makeup', 'Make-up favourites', 'Make-up favourites', 'Shop now', [['Soft matte lipstick', 'Comfortable colour that lasts', 'AED 000'], ['Volume mascara', 'Bold lashes, no clumps', 'AED 000'], ['Glow highlighter', 'A healthy, lit-from-within look', 'AED 000']]),
    cards('hair', 'Hair care', 'Healthy hair, simplified', 'Shop now', [['Repair shampoo', 'Cleans and strengthens', 'AED 000'], ['Smoothing conditioner', 'Softness from root to tip', 'AED 000'], ['Leave-in mist', 'Shine and frizz control', 'AED 000']]),
    cards('gifts', 'Gift ideas', 'Gifts they will love', 'Shop now', [['Mini set', 'Three travel-size favourites', 'AED 000'], ['Self-care box', 'Everything for a calm evening', 'AED 000'], ['Gift card', 'Let them choose', 'AED 000']]),
    cards('body', 'Body and bath', 'Treat yourself', 'Shop now', [['Body butter', 'Rich, non-greasy moisture', 'AED 000'], ['Shower oil', 'Gentle, soft-scented cleansing', 'AED 000'], ['Hand cream', 'Small size, big comfort', 'AED 000']]),
  ],
  speakers: [
    people('keynote', 'Keynote and panel', 'Meet the speakers', [['Keynote speaker', 'Opens the day with a look at where the industry is heading.'], ['Panel moderator', 'Guides a lively conversation with leaders from across the field.'], ['Panel guest', 'Shares lessons learned from real projects.']]),
    people('workshops', 'Workshop leaders', 'Learn from the experts', [['Workshop leader', 'A hands-on session you can put into practice the same day.'], ['Workshop leader', 'Practical tools and templates to take back to your team.'], ['Workshop leader', 'Small-group coaching with time for your questions.']]),
    people('industry', 'Industry voices', 'Voices from the industry', [['Industry expert', 'Explains the trends worth paying attention to this year.'], ['Founder', 'Tells the story behind building a business from scratch.'], ['Researcher', 'Shares fresh data and what it means for you.']]),
  ],
};

/** Types that offer ready-made content. */
export const PRESET_TYPES = Object.keys(BLOCK_PRESETS);

/** The property keys a block's presets fill in (these are the text fields hidden while ready-made content is in use). */
export function presetKeys(type: string): Set<string> {
  return new Set((BLOCK_PRESETS[type] ?? []).flatMap((p) => Object.keys(p.props)));
}

/** The preset whose words exactly match the block now, if any. */
export function matchingPreset(type: string, props: Props): BlockPreset | undefined {
  return (BLOCK_PRESETS[type] ?? []).find((p) => Object.entries(p.props).every(([k, v]) => props[k] === v));
}

/**
 * Props after choosing a preset. Only the preset's words change. A picture description that matched the old name or
 * heading (or was empty) follows the new one; a description someone wrote themselves is kept.
 */
export function applyPreset(type: string, props: Props, presetId: string): Props {
  const preset = (BLOCK_PRESETS[type] ?? []).find((p) => p.id === presetId);
  if (!preset) return props;
  const next: Props = { ...props, ...preset.props };
  for (const [key, value] of Object.entries(preset.props)) {
    if (!/(Name|Heading)$/.test(key) || key === 'heading') continue;
    const altKey = key.replace(/(Name|Heading)$/, 'ImageAlt');
    if (altKey in props && (props[altKey] === '' || props[altKey] === props[key])) next[altKey] = value;
  }
  return next;
}
