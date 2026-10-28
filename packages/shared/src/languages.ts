// The language registry and the typed list of languages ("English, Arabic, German" or "all languages").

export type LanguageDto = { id: string; locale: string; name: string; nativeName: string; direction: 'ltr' | 'rtl'; aliases: string[]; active: boolean; sort: number };

export type ParsedLanguages = {
  /** Registry ids, in the order typed, English first, without duplicates. */
  ids: string[];
  /** Names that are not in the registry. */
  unknown: string[];
  /** Names typed more than once (kept once). */
  duplicates: string[];
};

export const ALL_LANGUAGES_KEYWORD = 'all languages';
export const BASE_LANGUAGE_ID = 'en';

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Turns "English, arabic ,German" (or "all languages") into registry ids. Names and codes are matched without regard to
 * capitals or spacing; unknown names are reported, not guessed; English always comes first.
 */
export function parseLanguageList(input: string, registry: LanguageDto[]): ParsedLanguages {
  const active = registry.filter((l) => l.active).sort((a, b) => a.sort - b.sort);
  if (norm(input) === ALL_LANGUAGES_KEYWORD) return { ids: active.map((l) => l.id), unknown: [], duplicates: [] };
  const lookup = new Map<string, LanguageDto>();
  for (const l of active) {
    for (const k of [l.id, l.locale, l.name, ...l.aliases]) lookup.set(norm(k), l);
  }
  const ids: string[] = [];
  const unknown: string[] = [];
  const duplicates: string[] = [];
  // Parts are separated by commas, semicolons or new lines. "Portuguese (Portugal)" keeps its brackets.
  for (const raw of input.split(/[,;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const l = lookup.get(norm(part));
    if (!l) { unknown.push(part); continue; }
    if (ids.includes(l.id)) { duplicates.push(l.name); continue; }
    ids.push(l.id);
  }
  // English first (it is the master email)
  const i = ids.indexOf(BASE_LANGUAGE_ID);
  if (i > 0) { ids.splice(i, 1); ids.unshift(BASE_LANGUAGE_ID); }
  return { ids, unknown, duplicates };
}

/** The email name of a language: "German-Email". */
export const emailName = (language: Pick<LanguageDto, 'name'>): string => `${language.name.replace(/\s+/g, ' ')}-Email`;

// ---- DTOs of the language emails ----

export type EmailRevisionSummary = { id: string; number: number; kind: string; label: string | null; createdByName: string | null; createdAt: string; hash: string };

export type EmailVariantSummary = {
  id: string;
  languageId: string;
  name: string;
  sourceVariantId: string | null;
  draftVersion: number;
  revisionCount: number;
  latestRevision: number | null;
  /** True when the draft differs from the latest saved revision. */
  unsavedChanges: boolean;
  updatedAt: string;
};

export type CampaignEmails = {
  model: 'legacy' | 'v2';
  languages: Array<LanguageDto & { variant: EmailVariantSummary | null; emailName: string }>;
  /** Present for a legacy email that can be upgraded. */
  upgradable: boolean;
};

export type EmailDraftDto = {
  id: string;
  campaignId: string;
  languageId: string;
  name: string;
  status: string;
  direction: 'ltr' | 'rtl';
  draft: { content: unknown; version: number; hash: string; updatedAt: string };
};

// ---- segments and test audiences made from the rules ----

export type DerivedSegmentDto = { id: string; languageId: string; name: string; polarity: 'positive' | 'negative'; predicate: Record<string, unknown>; ruleIds: string[] };
export type TestAudienceDto = {
  id: string; languageId: string; kind: 'baseline' | 'scenario'; polarity: 'baseline' | 'positive' | 'negative'; name: string; email: string;
  attributes: Record<string, unknown>; ruleIds: string[]; expected: { visible: string[]; hidden: string[] };
};
export type DerivedResponse = { segments: DerivedSegmentDto[]; audiences: TestAudienceDto[]; warnings: { languageId: string; message: string }[] };
