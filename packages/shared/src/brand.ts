import { BRAND_FOOTER_DEFAULTS, BRAND_FOOTER_FIELDS, BRAND_HEADER_DEFAULTS, BRAND_HEADER_FIELDS, type Props } from './blocks.js';
import { checkFields } from './content.js';
import type { PaletteId } from './palettes.js';

// Each template (Travel, Events, Cosmetics) has its own shared header and footer, edited in Brand settings.
// Every campaign of that template shows them automatically; Builders cannot change them inside a campaign.

export type BrandProfile = {
  palette: PaletteId;
  version: number;
  header: Props;
  footer: Props;
};

export type BrandProfileDto = BrandProfile & { updatedAt: string; updatedByName: string | null };
export type BrandResponse = { profiles: Record<PaletteId, BrandProfileDto> };
export type SaveBrandRequest = { header: Props; footer: Props; baseVersion: number };
export type BrandVersionDto = { version: number; updatedAt: string; updatedByName: string | null };

const BRAND_NAMES: Record<PaletteId, { name: string; alt: string; width: number }> = {
  travel: { name: 'Fly', alt: 'Fly - Like a bird', width: 200 },
  events: { name: 'Agenda', alt: 'Agenda', width: 200 },
  cosmetics: { name: 'PrettyWoman', alt: 'PrettyWoman', width: 220 },
};

/** Starting header and footer for a template, used until an Admin sets the real ones. */
export function defaultBrand(palette: PaletteId): { header: Props; footer: Props } {
  const b = BRAND_NAMES[palette];
  return {
    header: { ...BRAND_HEADER_DEFAULTS, logoAlt: b.alt, logoWidth: b.width, brandName: b.name, linkUrlAlias: 'Header logo' },
    footer: { ...BRAND_FOOTER_DEFAULTS, companyName: b.name, notice: `You are receiving this email because you subscribed to ${b.name} updates.` },
  };
}

export function validateBrand(header: unknown, footer: unknown): { ok: true; header: Props; footer: Props } | { ok: false; error: string } {
  if (!header || typeof header !== 'object' || !footer || typeof footer !== 'object') return { ok: false, error: 'Header and footer are required.' };
  const h = checkFields(BRAND_HEADER_FIELDS, header as Record<string, unknown>, 'Header');
  if (h) return { ok: false, error: h };
  const f = checkFields(BRAND_FOOTER_FIELDS, footer as Record<string, unknown>, 'Footer');
  if (f) return { ok: false, error: f };
  return { ok: true, header: header as Props, footer: footer as Props };
}

// ---------- Assets (images) ----------
export const ASSET_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const ASSET_MAX_BYTES = 2 * 1024 * 1024;

export type AssetDto = {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  createdByName: string | null;
};
