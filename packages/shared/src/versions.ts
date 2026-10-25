import type { EmailContent, EmailVersion, SegmentVersion } from './content.js';
import { segmentCode } from './contacts.js';

// Versions of an email for segments of the audience. The Default version is the email itself; a segment version is a
// full, independent copy written for one segment. A contact whose segment has no version gets the Default.

type Value = string | number | boolean | null | undefined;

/** How a value appears in a segment name: blank = '', yes/no for booleans. */
export function segmentPart(v: Value): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v).trim().replace(/\s+/g, ' ');
}

/** Identifies a segment for matching: the fields and the values, ignoring capitals (UAE and uae are the same segment). */
export function segmentKey(fields: string[], values: Value[]): string {
  return JSON.stringify([fields, values.map((v) => segmentPart(v).toLowerCase())]);
}

/** The short name of a segment version, for example UAE-ar. */
export const variantCode = (v: Pick<SegmentVersion, 'values'>): string => segmentCode(v.values.map((x) => x || null));

/** The words and blocks being edited: the Default (id null) or one segment version. Falls back to the Default if the id is unknown. */
export function versionOf(content: EmailContent, variantId: string | null): EmailVersion {
  const v = variantId ? content.variants?.find((x) => x.id === variantId) : undefined;
  return v ?? content;
}

/** The email as one plain version (no variants), ready to render. */
export function flatContent(content: EmailContent, variant: SegmentVersion | null): EmailContent {
  const src = variant ?? content;
  return { schemaVersion: 1, settings: src.settings, blocks: src.blocks };
}

/** The version that a contact with these values receives, or null for the Default. `audienceFields` are the campaign's segment fields. */
export function pickVariant(content: EmailContent, audienceFields: string[], contact: Record<string, Value>): SegmentVersion | null {
  if (!content.variants?.length || audienceFields.length === 0) return null;
  const key = segmentKey(audienceFields, audienceFields.map((k) => contact[k]));
  return content.variants.find((v) => v.key === key && v.fields.join(',') === audienceFields.join(',')) ?? null;
}

/** A new segment version, starting as an independent copy of `from` (the Default or another version). Blocks keep their ids so a shared fix can be copied across versions. */
export function newVariant(from: EmailVersion, fields: string[], values: Value[]): SegmentVersion {
  const copy = JSON.parse(JSON.stringify({ settings: from.settings, blocks: from.blocks })) as EmailVersion;
  return { id: crypto.randomUUID(), fields, values: values.map(segmentPart), key: segmentKey(fields, values), settings: copy.settings, blocks: copy.blocks };
}

/** Versions that belong to the campaign's current segment fields (the others are kept but unused until the fields match again). */
export function activeVariants(content: EmailContent, audienceFields: string[]): SegmentVersion[] {
  return (content.variants ?? []).filter((v) => v.fields.join(',') === audienceFields.join(','));
}
