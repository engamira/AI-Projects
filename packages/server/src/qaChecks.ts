import {
  blockDefinition, blockRules, generateScenarios, hasBlockRules, lintRules,
  type BlockInstance, type ContactField, type EmailContent, type QaCategory, type QaSeverity, type TestAudienceDto,
} from '@cl/shared';
import { renderEmail, type BrandParts } from './render.js';

// The deterministic QA checks. Each one looks at the exact saved revision (and the email it renders to) and reports findings with
// evidence. They check what can be checked by looking, not what a recipient will experience: see `coverage.notRun`.

export const CHECK_SET_VERSION = 1;

export type Finding = {
  checkId: string;
  category: QaCategory;
  severity: QaSeverity;
  blockId: string | null;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  /** Identifies the subject within the check (a field, an address, a message): with the check id and block it makes the fingerprint. */
  key: string;
};

export type CheckInput = {
  content: EmailContent;
  language: { id: string; name: string; locale: string; direction: 'ltr' | 'rtl' };
  /** The English email the others are made from (its latest saved revision), to spot copy that was never translated. */
  english: EmailContent | null;
  audiences: Pick<TestAudienceDto, 'name' | 'expected'>[];
  fields: ContactField[];
  brand: BrandParts;
  baseUrl: string;
};

export const NOT_COVERED = [
  'How the email looks in Outlook, Gmail and other email apps (the browser preview is only an approximation)',
  'Links are not opened: only their format is checked',
  'Layout overflow measured in a real browser',
  'AI suggestions are not enabled',
];

const f = (checkId: string, category: QaCategory, severity: QaSeverity, blockId: string | null, title: string, description: string, evidence: Record<string, unknown> = {}, key = ''): Finding =>
  ({ checkId, category, severity, blockId, title, description, evidence, key });

const blockName = (b: BlockInstance): string => blockDefinition(b.type)?.label ?? b.type;
const isUrlKey = (key: string): boolean => /Url$|^url$/.test(key) && !/imageUrl$|logoUrl$/.test(key);
const imageAltKeys = (key: string): string[] => [key === 'src' ? 'alt' : `${key}Alt`, `${key.replace(/Url$/, '')}Alt`, 'alt'];
const GENERIC_LINK_TEXT = /^(click here|here|read more|learn more|more|link)$/i;
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/i;

/** Every piece of text a person typed into the blocks, with where it is. */
export function textsOf(content: EmailContent): { blockId: string | null; key: string; text: string }[] {
  const out: { blockId: string | null; key: string; text: string }[] = [];
  for (const k of ['subject', 'preheader'] as const) if (content.settings[k]?.trim()) out.push({ blockId: null, key: k, text: content.settings[k] });
  for (const b of content.blocks) {
    const def = blockDefinition(b.type);
    if (!def) continue;
    for (const fd of def.fields) {
      if ((fd.kind === 'text' || fd.kind === 'textarea') && !fd.key.endsWith('Alias') && typeof b.props[fd.key] === 'string' && (b.props[fd.key] as string).trim()) {
        out.push({ blockId: b.id, key: fd.key, text: b.props[fd.key] as string });
      }
    }
  }
  return out;
}

const SCRIPTS: Record<string, { name: string; re: RegExp }> = {
  ar: { name: 'Arabic', re: /\p{Script=Arabic}/gu }, th: { name: 'Thai', re: /\p{Script=Thai}/gu }, ru: { name: 'Cyrillic', re: /\p{Script=Cyrillic}/gu },
  el: { name: 'Greek', re: /\p{Script=Greek}/gu }, ko: { name: 'Hangul', re: /\p{Script=Hangul}/gu },
  ja: { name: 'Japanese', re: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu },
  'zh-tw': { name: 'Chinese', re: /\p{Script=Han}/gu }, 'zh-hans': { name: 'Chinese', re: /\p{Script=Han}/gu }, 'zh-hant': { name: 'Chinese', re: /\p{Script=Han}/gu },
};
const ENGLISH_WORDS = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'our', 'this', 'that', 'are', 'from', 'have', 'will', 'more', 'not', 'can', 'all', 'but', 'they', 'their', 'what', 'when', 'which', 'book', 'now', 'get']);

export async function runChecks(input: CheckInput): Promise<{ findings: Finding[]; coverage: { ran: string[]; notRun: string[] } }> {
  const { content, language } = input;
  const out: Finding[] = [];
  const ran = new Set<string>();
  const ok = (id: string) => ran.add(id);

  // ---- settings
  ok('settings');
  if (!content.settings.subject.trim()) out.push(f('settings.subject_missing', 'settings', 'high', null, 'The subject line is empty', 'Recipients see the subject first. Write one in the email settings.', {}, 'subject'));
  else if (content.settings.subject.length > 78) out.push(f('settings.subject_long', 'settings', 'low', null, 'The subject line is long', 'Long subject lines are cut off in many inboxes.', { length: content.settings.subject.length }, 'subject'));
  if (!content.settings.preheader.trim()) out.push(f('settings.preheader_missing', 'settings', 'low', null, 'There is no preview text', 'The preview text is the short line shown next to the subject.', {}, 'preheader'));
  if (!content.settings.senderEmail.trim() || !content.settings.senderName.trim()) {
    out.push(f('settings.sender_missing', 'settings', 'medium', null, 'The sender name or address is empty', 'Fill in who the email comes from.', { senderName: content.settings.senderName, senderEmail: content.settings.senderEmail }, 'sender'));
  }

  // ---- blocks: content, links, images, accessibility
  ok('content'); ok('links'); ok('images'); ok('accessibility');
  for (const b of content.blocks) {
    const def = blockDefinition(b.type);
    if (!def) continue;
    const name = blockName(b);
    const texts = textsOf({ ...content, settings: { ...content.settings, subject: '', preheader: '' }, blocks: [b] });
    if (b.type !== 'divider' && b.type !== 'spacer' && b.type !== 'custom_html' && b.type !== 'social' && texts.length === 0 && !def.fields.some((fd) => fd.kind === 'image' && b.props[fd.key])) {
      out.push(f('content.empty_block', 'content', 'medium', b.id, `${name} block is empty`, 'This block has no text or picture. Fill it in or delete it.', { block: name }));
    }
    for (const fd of def.fields) {
      const v = b.props[fd.key];
      if (fd.kind === 'url' && isUrlKey(fd.key)) {
        const value = typeof v === 'string' ? v.trim() : '';
        const required = /^(url|buttonUrl|leftButtonUrl|rightButtonUrl)$/.test(fd.key);
        if (!value) {
          if (required) out.push(f('links.button_missing_url', 'links', 'high', b.id, `${name}: ${fd.label} is empty`, 'A button without a link does nothing when it is tapped.', { field: fd.key, label: fd.label }, fd.key));
          continue;
        }
        if (value.includes('{{')) continue; // a merge field such as {{unsubscribe_url}}
        if (value === '#') { out.push(f('links.placeholder', 'links', 'high', b.id, `${name}: ${fd.label} is only “#”`, 'Replace the placeholder with the real address.', { field: fd.key, value }, fd.key)); continue; }
        let parsed: URL | null = null;
        try { parsed = new URL(value); } catch { /* handled below */ }
        if (!parsed || !/^(https?:|mailto:|tel:)$/.test(parsed.protocol) || /\s/.test(value)) {
          out.push(f('links.malformed', 'links', 'high', b.id, `${name}: ${fd.label} is not a valid address`, 'Use a full address starting with https://, or mailto: / tel:.', { field: fd.key, value }, `${fd.key}|${value}`));
        } else if (PLACEHOLDER_HOST.test(parsed.hostname)) {
          out.push(f('links.placeholder', 'links', 'high', b.id, `${name}: ${fd.label} points to example.${parsed.hostname.split('.').pop()}`, 'This is a placeholder address from the ready-made content. Replace it with the real one.', { field: fd.key, value }, `${fd.key}|${value}`));
        } else if (parsed.protocol === 'http:') {
          out.push(f('links.insecure_http', 'links', 'medium', b.id, `${name}: ${fd.label} is not secure (http)`, 'Use https:// so email apps do not warn about the link.', { field: fd.key, value }, `${fd.key}|${value}`));
        }
      }
      if (fd.kind === 'image') {
        const src = typeof v === 'string' ? v.trim() : '';
        if (!src) {
          if (b.type === 'image') out.push(f('images.missing', 'images', 'high', b.id, `${name}: no picture chosen`, 'The email shows a grey placeholder instead of a picture.', { field: fd.key }, fd.key));
          continue;
        }
        const decorative = b.props.decorative === true;
        const altKey = imageAltKeys(fd.key).find((k) => k in b.props);
        const alt = altKey && typeof b.props[altKey] === 'string' ? (b.props[altKey] as string).trim() : '';
        if (!decorative && !alt) out.push(f('images.missing_alt', 'accessibility', 'medium', b.id, `${name}: the picture has no description`, 'Add a short description (alt text) for people who cannot see the picture, or mark it as decorative.', { field: fd.key }, fd.key));
      }
      if (fd.key === 'label' && typeof v === 'string' && GENERIC_LINK_TEXT.test(v.trim())) {
        out.push(f('accessibility.generic_link_text', 'accessibility', 'low', b.id, `${name}: the button text “${v.trim()}” says little`, 'Say what happens when it is tapped, for example “See the fares”.', { label: v.trim() }, v.trim().toLowerCase()));
      }
    }
  }

  // ---- rules
  ok('rules');
  const known = input.fields.map((x) => x.key);
  const typeOf = (k: string) => input.fields.find((x) => x.key === k)?.type;
  for (const p of lintRules(content.blocks, known, typeOf)) out.push(f('rules.lint', 'rules', 'medium', p.blockId, p.message, 'Open the block and fix its rule.', { ruleId: p.ruleId }, `${p.ruleId}|${p.message}`));
  const gen = generateScenarios({ language: { id: language.id, name: language.name }, blocks: content.blocks, typeOf, labelOf: (k) => k });
  for (const u of gen.unreachable) out.push(f('rules.unreachable', 'rules', 'medium', u.blockId, u.message, `In ${language.name}, no contact can meet this rule.`, { ruleId: u.ruleId }, String(u.ruleId)));
  if (input.audiences.length > 1) {
    for (const b of content.blocks) {
      if (hasBlockRules(b) && !input.audiences.some((a) => a.expected.visible?.includes(b.id))) {
        out.push(f('rules.never_shown', 'rules', 'medium', b.id, `${blockName(b)} block is not shown to any test audience`, 'None of the test audiences of this language sees this block, so it may never be sent to anyone.', { audiences: input.audiences.length }));
      }
    }
  }

  // ---- localization
  ok('localization');
  const texts = textsOf(content);
  if (language.id !== 'en' && input.english) {
    const eng = new Set(textsOf(input.english).map((t) => t.text.trim().toLowerCase()));
    const translatable = texts.filter((t) => /\p{L}{3}/u.test(t.text) && !/^\{\{[^}]*\}\}$/.test(t.text.trim()));
    const same = translatable.filter((t) => eng.has(t.text.trim().toLowerCase()));
    if (translatable.length >= 3 && same.length / translatable.length >= 0.6) {
      out.push(f('localization.untranslated_copy', 'localization', 'high', null, `${same.length} of ${translatable.length} texts are still the English text`, `This ${language.name} email looks like an untranslated copy of the English email.`, { samples: same.slice(0, 5).map((t) => t.text), identical: same.length, total: translatable.length }));
    }
  }
  const body = texts.map((t) => t.text).join(' ');
  const letters = body.match(/\p{L}/gu) ?? [];
  const script = SCRIPTS[language.id];
  if (script && letters.length >= 20) {
    const share = (body.match(script.re) ?? []).length / letters.length;
    if (share < 0.5) out.push(f('localization.wrong_script', 'localization', 'high', null, `The text is not mostly in ${script.name} letters`, `${language.name} should be written in ${script.name} script, but most of the text is not.`, { share: Math.round(share * 100) }));
  } else if (!script && language.id !== 'en') {
    const words = body.toLowerCase().match(/[a-z]+/g) ?? [];
    const share = words.length ? words.filter((w) => ENGLISH_WORDS.has(w)).length / words.length : 0;
    if (words.length >= 25 && share >= 0.18) out.push(f('localization.english_text', 'localization', 'high', null, 'The text still contains a lot of English', `Many common English words were found in this ${language.name} email.`, { englishWordShare: Math.round(share * 100) }));
  }

  // ---- the rendered email
  ok('html'); ok('personalization');
  const rendered = await renderEmail(content, { baseUrl: input.baseUrl, brand: input.brand, knownFields: known, language: { locale: language.locale, direction: language.direction } });
  for (const p of rendered.placeholderIssues) out.push(f('personalization.unresolved', 'personalization', 'high', null, `Personalization problem: ${p.text}`, p.message, { text: p.text }, p.text));
  for (const w of rendered.warnings.slice(0, 5)) out.push(f('html.mjml_warning', 'html', 'medium', null, 'The email builder reported a problem', w, { warning: w }, w));
  const bytes = Buffer.byteLength(rendered.html, 'utf8');
  if (bytes > 100 * 1024) out.push(f('html.size', 'html', 'medium', null, 'The email is large', 'Gmail cuts off emails larger than about 102 KB. Remove content or pictures.', { kilobytes: Math.round(bytes / 1024) }));
  if (!/unsubscribe/i.test(rendered.html)) out.push(f('html.missing_unsubscribe', 'html', 'high', null, 'There is no unsubscribe text', 'Marketing emails must let people unsubscribe. Check the shared footer in Brand settings.', {}));
  if (language.direction === 'rtl' && !/<html[^>]*dir="rtl"/i.test(rendered.html)) out.push(f('html.rtl', 'html', 'medium', null, 'The email is not set to read right to left', `${language.name} is written right to left.`, {}));

  return { findings: out, coverage: { ran: [...ran], notRun: NOT_COVERED } };
}
