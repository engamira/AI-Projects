import { align, area, image, link, num, text, type FieldDef, type Props, type RawDefinition } from './fields.js';

// Template-specific blocks. Layouts follow the three reference designs in spirit (card grids, banner bands,
// alternating rows); all wording is original placeholder text. Colors always come from the template.
// Travel: destinations, fares, travel offer, booking.  Events: date and location, agenda, speakers, registration.
// Cosmetics: products, benefits, promotional offer, shopping.

export const SPECIALTY_TYPES = [
  'destinations', 'fares', 'travel_offer', 'booking_cta',
  'event_details', 'agenda', 'speakers', 'registration_cta',
  'products', 'benefits', 'promo_offer', 'shopping_cta',
] as const;

type Item = { [k: string]: string };

/** Fields and defaults for `n` repeated items ("Card 1", "Card 2", ...), keyed like c1Name, c2Name. */
function items(prefix: string, noun: string, n: number, spec: { key: string; label: string; kind: 'text' | 'area' | 'image' | 'link' }[], values: Item[]): { fields: FieldDef[]; defaults: Props } {
  const fields: FieldDef[] = [];
  const defaults: Props = {};
  for (let i = 1; i <= n; i++) {
    const v = values[i - 1] ?? {};
    for (const s of spec) {
      const key = `${prefix}${i}${s.key}`;
      const label = `${noun} ${i}: ${s.label}`;
      if (s.kind === 'image') fields.push(image(key, label));
      else if (s.kind === 'area') fields.push(area(key, label, 500));
      else if (s.kind === 'link') {
        fields.push(...link(key, label));
        defaults[key] = v[s.key] ?? '';
        defaults[`${key}Alias`] = v[`${s.key}Alias`] ?? '';
        continue;
      } else fields.push(text(key, label));
      defaults[key] = v[s.key] ?? '';
    }
  }
  return { fields, defaults };
}

const CARD = [
  { key: 'Image', label: 'picture', kind: 'image' as const },
  { key: 'ImageAlt', label: 'picture description (alt text)', kind: 'text' as const },
  { key: 'Name', label: 'name', kind: 'text' as const },
  { key: 'Detail', label: 'detail', kind: 'text' as const },
  { key: 'Price', label: 'price', kind: 'text' as const },
  { key: 'ButtonText', label: 'button text', kind: 'text' as const },
  { key: 'ButtonUrl', label: 'button link', kind: 'link' as const },
];

function cardBlock(o: { type: string; label: string; description: string; category: RawDefinition['category']; noun: string; heading: string; button: string; cards: [string, string, string][] }): RawDefinition {
  const it = items('c', o.noun, 3, CARD, o.cards.map(([name, detail, price], i) => ({
    Name: name, Detail: detail, Price: price, ButtonText: o.button, ImageAlt: name, ButtonUrlAlias: `${o.noun} ${i + 1} button`,
  })));
  return {
    type: o.type, version: 1, label: o.label, description: o.description, category: o.category,
    fields: [text('heading', 'Section heading'), ...it.fields, num('paddingY', 'Space above and below', 0, 80)],
    defaults: { heading: o.heading, ...it.defaults, paddingY: 28 },
  };
}

function ctaBlock(o: { type: string; label: string; description: string; category: RawDefinition['category']; heading: string; text: string; button: string; note: string; alias: string }): RawDefinition {
  return {
    type: o.type, version: 1, label: o.label, description: o.description, category: o.category,
    fields: [text('heading', 'Heading'), area('text', 'Text', 400), text('buttonText', 'Button text'), ...link('buttonUrl', 'Button link'), text('note', 'Small print under the button', 'content', undefined, 200), align(), num('paddingY', 'Space above and below', 0, 80)],
    defaults: { heading: o.heading, text: o.text, buttonText: o.button, buttonUrl: '', buttonUrlAlias: o.alias, note: o.note, align: 'center', paddingY: 36 },
  };
}

export const SPECIALTY_DEFINITIONS: RawDefinition[] = [
  // ---------------- Travel ----------------
  cardBlock({
    type: 'destinations', label: 'Destinations', description: 'Three destination cards with a picture, price and booking button.', category: 'travel',
    noun: 'Destination', heading: 'Popular destinations', button: 'Book now',
    cards: [['Istanbul', 'Direct flights daily', 'from AED 1,099'], ['Lisbon', 'Three flights a week', 'from AED 1,899'], ['Cairo', 'Several flights daily', 'from AED 899']],
  }),
  (() => {
    const rows = items('r', 'Fare', 5, [{ key: 'Route', label: 'route', kind: 'text' }, { key: 'Price', label: 'price', kind: 'text' }], [
      { Route: 'Dubai → Istanbul', Price: 'AED 1,099' }, { Route: 'Dubai → Cairo', Price: 'AED 899' }, { Route: 'Dubai → London', Price: 'AED 2,199' },
      { Route: 'Dubai → Lisbon', Price: 'AED 1,899' }, { Route: 'Dubai → Bangkok', Price: 'AED 1,499' },
    ]);
    return {
      type: 'fares', version: 1, label: 'Fares', description: 'A simple table of routes and fares.', category: 'travel',
      fields: [text('heading', 'Section heading'), ...rows.fields, area('note', 'Note under the table', 300), text('buttonText', 'Button text'), ...link('buttonUrl', 'Button link'), num('paddingY', 'Space above and below', 0, 80)],
      defaults: { heading: 'Fares from Dubai', ...rows.defaults, note: 'Round-trip fares, taxes included. Subject to availability.', buttonText: 'See all fares', buttonUrl: '', buttonUrlAlias: 'All fares button', paddingY: 28 },
    } satisfies RawDefinition;
  })(),
  {
    type: 'travel_offer', version: 1, label: 'Travel offer', description: 'A bold offer banner for a deal, upgrade or extra.', category: 'travel',
    fields: [text('eyebrow', 'Small label above'), text('highlight', 'Highlighted offer'), text('headline', 'Offer details', 'content', undefined, 300), text('buttonText', 'Button text (optional)'), ...link('buttonUrl', 'Button link'), align(), num('paddingY', 'Space above and below', 0, 80)],
    defaults: { eyebrow: 'This week only', highlight: 'FREE EXTRA BAGGAGE', headline: 'on every booking over AED 1,500', buttonText: 'See the offer', buttonUrl: '', buttonUrlAlias: 'Offer button', align: 'center', paddingY: 32 },
  },
  ctaBlock({ type: 'booking_cta', label: 'Booking button', description: 'A closing call to book, with a short reassurance line.', category: 'travel', heading: 'Ready to fly?', text: 'Pick your dates and book in just a few minutes.', button: 'Book your flight', note: 'Free changes within 24 hours of booking.', alias: 'Booking button' }),

  // ---------------- Events ----------------
  {
    type: 'event_details', version: 1, label: 'Date and location', description: 'A banner with the event name, date, time and place.', category: 'events',
    fields: [
      text('eyebrow', 'Small label above'), text('title', 'Event name'),
      text('dateLabel', 'Date label'), text('dateValue', 'Date'), text('timeLabel', 'Time label'), text('timeValue', 'Time'), text('placeLabel', 'Place label'), text('placeValue', 'Place'),
      text('address', 'Full address', 'content', undefined, 300), text('buttonText', 'Button text (optional)'), ...link('buttonUrl', 'Button link'), num('paddingY', 'Space above and below', 0, 80),
    ],
    defaults: {
      eyebrow: 'Save the date', title: 'Agenda Summit', dateLabel: 'Date', dateValue: 'Thursday, 12 March', timeLabel: 'Time', timeValue: '9:00 AM – 5:00 PM',
      placeLabel: 'Place', placeValue: 'Dubai Silicon Oasis', address: 'Pineapple Tower, Dubai Silicon Oasis, Dubai', buttonText: 'Add to calendar', buttonUrl: '', buttonUrlAlias: 'Add to calendar', paddingY: 32,
    },
  },
  (() => {
    const rows = items('s', 'Session', 6, [{ key: 'Time', label: 'time', kind: 'text' }, { key: 'Title', label: 'title', kind: 'text' }, { key: 'Text', label: 'description', kind: 'area' }], [
      { Time: '9:00', Title: 'Doors open and welcome coffee', Text: 'Meet the team and find your seat.' },
      { Time: '9:30', Title: 'Opening keynote', Text: 'Where the industry is heading next.' },
      { Time: '11:00', Title: 'Panel discussion', Text: 'Three leaders share what is working for them.' },
      { Time: '13:00', Title: 'Networking lunch', Text: '' },
      { Time: '15:00', Title: 'Workshops', Text: 'Hands-on sessions in small groups.' },
    ]);
    return {
      type: 'agenda', version: 1, label: 'Agenda', description: 'A timetable of sessions, up to six.', category: 'events',
      fields: [text('heading', 'Section heading'), ...rows.fields, num('paddingY', 'Space above and below', 0, 80)],
      defaults: { heading: 'The day at a glance', ...rows.defaults, paddingY: 28 },
    } satisfies RawDefinition;
  })(),
  (() => {
    const people = items('p', 'Speaker', 3, [
      { key: 'Image', label: 'photo', kind: 'image' }, { key: 'ImageAlt', label: 'photo description (alt text)', kind: 'text' },
      { key: 'Name', label: 'name', kind: 'text' }, { key: 'Role', label: 'role', kind: 'text' }, { key: 'Bio', label: 'short bio', kind: 'area' },
    ], [
      { Name: 'Speaker name', Role: 'Role, Company', Bio: 'One or two lines about what they will talk about.', ImageAlt: 'Speaker name' },
      { Name: 'Speaker name', Role: 'Role, Company', Bio: 'One or two lines about what they will talk about.', ImageAlt: 'Speaker name' },
      { Name: 'Speaker name', Role: 'Role, Company', Bio: 'One or two lines about what they will talk about.', ImageAlt: 'Speaker name' },
    ]);
    return {
      type: 'speakers', version: 1, label: 'Speakers', description: 'Up to three speaker cards with photo, role and bio.', category: 'events',
      fields: [text('heading', 'Section heading'), ...people.fields, num('paddingY', 'Space above and below', 0, 80)],
      defaults: { heading: 'Meet the speakers', ...people.defaults, paddingY: 28 },
    } satisfies RawDefinition;
  })(),
  {
    ...ctaBlock({ type: 'registration_cta', label: 'Registration button', description: 'A closing call to register, with the deadline.', category: 'events', heading: 'Reserve your seat', text: 'Places are limited, so register early.', button: 'Register now', note: 'Registration closes on 1 March.', alias: 'Registration button' }),
  },

  // ---------------- Cosmetics ----------------
  cardBlock({
    type: 'products', label: 'Products', description: 'Three product cards with a picture, price and shop button.', category: 'cosmetics',
    noun: 'Product', heading: 'Our favourites', button: 'Shop now',
    cards: [['Hydrating serum', '30 ml', 'AED 129'], ['Daily moisturiser', '50 ml', 'AED 99'], ['Soft matte lipstick', 'Shade: rose', 'AED 79']],
  }),
  (() => {
    const b = items('b', 'Benefit', 3, [{ key: 'Title', label: 'title', kind: 'text' }, { key: 'Text', label: 'description', kind: 'area' }], [
      { Title: 'Gentle formulas', Text: 'Made for everyday use on every skin type.' },
      { Title: 'Free delivery', Text: 'On every order over AED 200.' },
      { Title: 'Easy returns', Text: 'Changed your mind? Return within 30 days.' },
    ]);
    return {
      type: 'benefits', version: 1, label: 'Benefits', description: 'A colored strip with three short reasons to buy.', category: 'cosmetics',
      fields: [text('heading', 'Heading (optional)'), ...b.fields, num('paddingY', 'Space above and below', 0, 80)],
      defaults: { heading: 'Why you will love it', ...b.defaults, paddingY: 32 },
    } satisfies RawDefinition;
  })(),
  {
    type: 'promo_offer', version: 1, label: 'Promotional offer', description: 'A bright band with an offer, a code and a button.', category: 'cosmetics',
    fields: [text('eyebrow', 'Small label above'), text('headline', 'Offer'), text('codeLabel', 'Label before the code'), text('code', 'Promo code'), text('terms', 'Terms', 'content', undefined, 300), text('buttonText', 'Button text'), ...link('buttonUrl', 'Button link'), align(), num('paddingY', 'Space above and below', 0, 80)],
    defaults: { eyebrow: 'Limited time', headline: '20% off your first order', codeLabel: 'Use code', code: 'WELCOME20', terms: 'Valid until 31 March. One use per customer.', buttonText: 'Shop the offer', buttonUrl: '', buttonUrlAlias: 'Offer button', align: 'center', paddingY: 36 },
  },
  ctaBlock({ type: 'shopping_cta', label: 'Shopping button', description: 'A closing call to shop, with delivery information.', category: 'cosmetics', heading: 'Ready to glow?', text: 'Find the routine that works for you.', button: 'Shop all products', note: 'Free delivery on orders over AED 200.', alias: 'Shop all button' }),
];
