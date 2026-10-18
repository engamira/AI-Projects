// Template color palettes. Colors are NOT editable in the editor: every block takes its colors
// from the palette of the campaign's template, so each template always looks the same.
// Palettes are inspired by the three reference designs; text/button colors are adjusted where needed
// for readable contrast. Only colors are borrowed, never wording, images, logos or markup.

export const PALETTE_IDS = ['travel', 'events', 'cosmetics'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

export type Palette = {
  id: PaletteId;
  label: string;
  page: string; // area around the email
  surface: string; // main email background
  text: string; // headings and body text on surface
  muted: string; // secondary text
  divider: string;
  primary: string; // hero / main band
  onPrimary: string; // text on primary
  heroButton: string; // button on the primary band
  onHeroButton: string;
  dark: string; // dark band
  onDark: string;
  secondary: string; // second band (benefits, soft sections)
  onSecondary: string;
  accent: string; // offer strips and highlights
  onAccent: string;
  button: string; // buttons on the surface
  onButton: string;
  link: string; // text links on the surface
  placeholder: string; // empty image placeholder
  footerBg: string;
  footerText: string;
  footerLink: string;
};

export const PALETTES: Record<PaletteId, Palette> = {
  // Inspired by the "racoon" colors: sunset orange with charcoal
  travel: {
    id: 'travel', label: 'Travel',
    page: '#e4e9ef', surface: '#ffffff', text: '#1b1d22', muted: '#55585f', divider: '#d3d9e1',
    primary: '#fa8739', onPrimary: '#2f323b', heroButton: '#2f323b', onHeroButton: '#ffffff',
    dark: '#2f323b', onDark: '#ffffff', secondary: '#f1f3f6', onSecondary: '#1b1d22',
    accent: '#fa8739', onAccent: '#2f323b', button: '#fa8739', onButton: '#2f323b', link: '#b8480a',
    placeholder: '#e5e7eb', footerBg: '#2f323b', footerText: '#e9ecf1', footerLink: '#fa8739',
  },
  // Inspired by the "christmas" colors: quiet neutrals with dark slate
  events: {
    id: 'events', label: 'Events',
    page: '#f4f4f4', surface: '#ffffff', text: '#151e23', muted: '#55575d', divider: '#d9dde1',
    primary: '#354552', onPrimary: '#ffffff', heroButton: '#ffffff', onHeroButton: '#354552',
    dark: '#151e23', onDark: '#ffffff', secondary: '#eceff1', onSecondary: '#151e23',
    accent: '#354552', onAccent: '#ffffff', button: '#354552', onButton: '#ffffff', link: '#354552',
    placeholder: '#e5e7eb', footerBg: '#151e23', footerText: '#cfd4d8', footerLink: '#ffffff',
  },
  // Inspired by the "sphero-mini" colors: pink, sky blue and a warm orange strip
  cosmetics: {
    id: 'cosmetics', label: 'Cosmetics',
    page: '#f3f0f4', surface: '#fcfcfd', text: '#2a1c26', muted: '#5f5f66', divider: '#eadfe6',
    primary: '#ff3fb4', onPrimary: '#2a1020', heroButton: '#2a1020', onHeroButton: '#ffffff',
    dark: '#2a1c26', onDark: '#ffffff', secondary: '#00a3d9', onSecondary: '#082a38',
    accent: '#f15822', onAccent: '#2a1c26', button: '#d6247f', onButton: '#ffffff', link: '#b0176a',
    placeholder: '#ece6ee', footerBg: '#2a1c26', footerText: '#f3e8ef', footerLink: '#ff3fb4',
  },
};

export const paletteOf = (id: unknown): Palette => PALETTES[id as PaletteId] ?? PALETTES.travel;
