import { blockDefinition, type BlockType } from './blocks.js';
import { createInstance, emptyContent, type EmailContent } from './content.js';
import type { Props } from './fields.js';
import type { PaletteId } from './palettes.js';

// Ready-made starting layouts, one per template. Wording is original placeholder text to be replaced.
// A starter is just a list of ordinary blocks: once created, every block is the email's own independent copy.

type Step = [BlockType, Props?];

const STARTERS: Record<PaletteId, { subject: string; preheader: string; steps: Step[] }> = {
  travel: {
    subject: 'Summer fares from AED 999',
    preheader: 'Book now and fly to your next destination for less.',
    steps: [
      ['hero', { headline: 'Summer fares from AED 999', subheadline: 'Fly to 40 destinations this season and lock in the lowest fare before the rush.', buttonText: 'Book now', buttonUrlAlias: 'Hero booking button' }],
      ['travel_offer'],
      ['destinations'],
      ['fares'],
      ['text', { heading: 'Why book with us', body: 'Flexible changes, friendly support around the clock, and fares that include taxes. Choose your destination and we will take care of the rest.', align: 'center' }],
      ['booking_cta'],
    ],
  },
  events: {
    subject: 'You are invited: Agenda Summit',
    preheader: 'Save the date and reserve your seat.',
    steps: [
      ['hero', { headline: 'You are invited', subheadline: 'A day of talks, workshops and conversations with people shaping the industry.', buttonText: 'Register now', buttonUrlAlias: 'Hero registration button' }],
      ['event_details'],
      ['text', { heading: 'What to expect', body: 'Inspiring speakers, practical workshops and plenty of time to meet other attendees. Lunch and refreshments are included.', align: 'center' }],
      ['agenda'],
      ['speakers'],
      ['registration_cta'],
    ],
  },
  cosmetics: {
    subject: 'Meet your new favourites',
    preheader: 'Discover the new collection and enjoy 20% off your first order.',
    steps: [
      ['hero', { headline: 'Meet your new favourites', subheadline: 'Gentle formulas for glowing, healthy-looking skin.', buttonText: 'Shop now', buttonUrlAlias: 'Hero shop button' }],
      ['products'],
      ['benefits'],
      ['promo_offer'],
      ['two_column', { leftHeading: 'Skin care', leftBody: 'Cleansers, serums and moisturisers for every routine.', leftButtonText: 'Explore skin care', leftButtonUrlAlias: 'Skin care button', rightHeading: 'Make-up', rightBody: 'Easy shades that look good all day.', rightButtonText: 'Explore make-up', rightButtonUrlAlias: 'Make-up button' }],
      ['shopping_cta'],
    ],
  },
};

/** A new email of the template, filled with its ready-made layout. Every block is a fresh independent copy. */
export function starterContent(palette: PaletteId): EmailContent {
  const s = STARTERS[palette];
  const content = emptyContent(palette);
  content.settings.subject = s.subject;
  content.settings.preheader = s.preheader;
  content.blocks = s.steps.map(([type, overrides]) => {
    const inst = createInstance(blockDefinition(type)!);
    Object.assign(inst.props, overrides ?? {});
    return inst;
  });
  return content;
}
