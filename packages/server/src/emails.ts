import {
  canonicalJson, cloneContent, emailName, normalizeContent,
  type CampaignEmails, type EmailContent, type EmailVariantSummary, type LanguageDto,
} from '@cl/shared';
import { sha256 } from './crypto.js';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';

// Language emails: one email per language of a campaign, each with its own draft and its own numbered revisions.

export const hashOf = (c: EmailContent): string => sha256(canonicalJson(c));

type LanguageRow = { id: string; locale: string; name: string; native_name: string; direction: 'ltr' | 'rtl'; aliases: string[]; active: boolean; sort: number };
const toLanguage = (r: LanguageRow): LanguageDto => ({ id: r.id, locale: r.locale, name: r.name, nativeName: r.native_name, direction: r.direction, aliases: r.aliases, active: r.active, sort: r.sort });

export async function listLanguages(q: Queryable): Promise<LanguageDto[]> {
  const r = await q.query<LanguageRow>('SELECT id, locale, name, native_name, direction, aliases, active, sort FROM language ORDER BY sort');
  return r.rows.map(toLanguage);
}

export async function selectedLanguageIds(q: Queryable, campaignId: string): Promise<string[]> {
  const r = await q.query<{ language_id: string }>('SELECT language_id FROM campaign_language WHERE campaign_id = $1 ORDER BY position', [campaignId]);
  return r.rows.map((x) => x.language_id);
}

/** Replaces the campaign's language list. Languages that already have an email cannot be dropped (delete that email first). */
export async function setSelectedLanguages(q: Queryable, campaignId: string, ids: string[]): Promise<{ blocked: string[] } | { ok: true }> {
  const used = await q.query<{ language_id: string }>('SELECT language_id FROM email_variant WHERE campaign_id = $1', [campaignId]);
  const blocked = used.rows.map((x) => x.language_id).filter((x) => !ids.includes(x));
  if (blocked.length) return { blocked };
  await q.query('DELETE FROM campaign_language WHERE campaign_id = $1', [campaignId]);
  for (const [i, id] of ids.entries()) await q.query('INSERT INTO campaign_language (campaign_id, language_id, position) VALUES ($1, $2, $3)', [campaignId, id, i]);
  return { ok: true };
}

type VariantRow = {
  id: string; language_id: string; source_variant_id: string | null; draft_version: number; draft_hash: string; updated_at: Date;
  revision_count: string; latest_revision: number | null; latest_hash: string | null;
};

export async function campaignEmails(q: Queryable, campaignId: string, model: 'legacy' | 'v2'): Promise<CampaignEmails> {
  const languages = await listLanguages(q);
  const ids = await selectedLanguageIds(q, campaignId);
  const v = await q.query<VariantRow>(
    `SELECT v.id, v.language_id, v.source_variant_id, v.draft_version, v.draft_hash, v.updated_at,
            (SELECT count(*) FROM email_revision r WHERE r.variant_id = v.id) AS revision_count,
            (SELECT max(number) FROM email_revision r WHERE r.variant_id = v.id) AS latest_revision,
            (SELECT content_hash FROM email_revision r WHERE r.variant_id = v.id ORDER BY number DESC LIMIT 1) AS latest_hash
       FROM email_variant v WHERE v.campaign_id = $1`,
    [campaignId],
  );
  const byLanguage = new Map(v.rows.map((x) => [x.language_id, x]));
  return {
    model,
    upgradable: model === 'legacy',
    languages: ids.map((id) => languages.find((l) => l.id === id)).filter((l): l is LanguageDto => !!l).map((l) => {
      const x = byLanguage.get(l.id);
      const variant: EmailVariantSummary | null = x ? {
        id: x.id, languageId: l.id, name: emailName(l), sourceVariantId: x.source_variant_id, draftVersion: x.draft_version,
        revisionCount: Number(x.revision_count), latestRevision: x.latest_revision, unsavedChanges: x.latest_hash !== x.draft_hash, updatedAt: x.updated_at.toISOString(),
      } : null;
      return { ...l, variant, emailName: emailName(l) };
    }),
  };
}

export async function addEmailRevision(
  q: Queryable, variantId: string, userId: string, kind: 'created' | 'manual' | 'restore' | 'clone' | 'upgrade', content: EmailContent,
  opts: { label?: string | null; restoredFromId?: string } = {},
): Promise<number> {
  // The variant row must be locked by the caller so numbers never collide.
  const r = await q.query<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM email_revision WHERE variant_id = $1', [variantId]);
  const number = r.rows[0]!.n;
  await q.query(
    `INSERT INTO email_revision (workspace_id, variant_id, number, kind, label, content, content_hash, restored_from_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [DEFAULT_WORKSPACE_ID, variantId, number, kind, opts.label ?? null, JSON.stringify(content), hashOf(content), opts.restoredFromId ?? null, userId],
  );
  return number;
}

export type CreateResult = { kind: 'ok'; id: string; existing: boolean } | { kind: 'error'; status: number; error: string; message: string };

/**
 * Creates the email of one language. English (no source) starts from the campaign's starting layout; any other language is
 * created from a saved email: its blocks, styling and rules are copied (new ids), after which the copy is independent.
 * Retrying with the same requestId returns the first result.
 */
export async function createEmailVariant(
  q: Queryable, p: { campaignId: string; languageId: string; createFromId: string | null; userId: string; requestId: string | null },
): Promise<CreateResult> {
  const camp = await q.query<{ draft_content: EmailContent; status: string; model: string }>('SELECT draft_content, status, model FROM campaign WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [p.campaignId, DEFAULT_WORKSPACE_ID]);
  const c = camp.rows[0];
  if (!c) return { kind: 'error', status: 404, error: 'not_found', message: 'Email not found.' };
  if (c.model !== 'v2') return { kind: 'error', status: 409, error: 'legacy_email', message: 'This email uses the previous editor. Upgrade it first.' };
  if (c.status !== 'draft') return { kind: 'error', status: 409, error: 'locked', message: 'This email can no longer be edited.' };

  if (p.requestId) {
    const prior = await q.query<{ id: string; language_id: string }>('SELECT id, language_id FROM email_variant WHERE campaign_id = $1 AND request_id = $2', [p.campaignId, p.requestId]);
    if (prior.rows[0]) return { kind: 'ok', id: prior.rows[0].id, existing: true };
  }
  if (!(await selectedLanguageIds(q, p.campaignId)).includes(p.languageId)) {
    return { kind: 'error', status: 400, error: 'language_not_selected', message: 'Add this language to the Languages list first.' };
  }
  const dup = await q.query('SELECT 1 FROM email_variant WHERE campaign_id = $1 AND language_id = $2', [p.campaignId, p.languageId]);
  if (dup.rowCount) return { kind: 'error', status: 409, error: 'duplicate', message: 'This language already has an email.' };

  let content: EmailContent;
  let kind: 'created' | 'clone' = 'created';
  if (p.createFromId) {
    const src = await q.query<{ content: EmailContent; number: number }>(
      `SELECT r.content, r.number FROM email_revision r JOIN email_variant v ON v.id = r.variant_id
        WHERE v.id = $1 AND v.campaign_id = $2 ORDER BY r.number DESC LIMIT 1`,
      [p.createFromId, p.campaignId],
    );
    if (!src.rows[0]) return { kind: 'error', status: 400, error: 'source_not_saved', message: 'Choose an email that has been created and saved.' };
    content = cloneContent(normalizeContent(src.rows[0].content), true); // new block ids; rules and styling are kept
    kind = 'clone';
  } else {
    if (p.languageId !== 'en') return { kind: 'error', status: 400, error: 'source_required', message: 'Choose which saved email to create this one from.' };
    content = cloneContent(normalizeContent(c.draft_content), true);
  }
  delete (content as { variants?: unknown }).variants;
  delete (content as { versioning?: unknown }).versioning;

  const ins = await q.query<{ id: string }>(
    `INSERT INTO email_variant (workspace_id, campaign_id, language_id, source_variant_id, request_id, draft_content, draft_hash, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, p.campaignId, p.languageId, p.createFromId, p.requestId, JSON.stringify(content), hashOf(content), p.userId],
  );
  const id = ins.rows[0]!.id;
  await addEmailRevision(q, id, p.userId, kind, content);
  await q.query('UPDATE campaign SET updated_at = now(), updated_by = $2 WHERE id = $1', [p.campaignId, p.userId]);
  return { kind: 'ok', id, existing: false };
}

/** Copies every language and language email of one campaign to another (new ids, independent), for "Duplicate". */
export async function duplicateEmails(q: Queryable, fromCampaignId: string, toCampaignId: string, userId: string): Promise<void> {
  await q.query('DELETE FROM campaign_language WHERE campaign_id = $1', [toCampaignId]);
  await q.query('INSERT INTO campaign_language (campaign_id, language_id, position) SELECT $2, language_id, position FROM campaign_language WHERE campaign_id = $1', [fromCampaignId, toCampaignId]);
  const src = await q.query<{ id: string; language_id: string; draft_content: EmailContent }>('SELECT id, language_id, draft_content FROM email_variant WHERE campaign_id = $1 ORDER BY created_at', [fromCampaignId]);
  const made = new Map<string, string>();
  for (const v of src.rows) {
    const content = cloneContent(normalizeContent(v.draft_content), true);
    const r = await q.query<{ id: string }>(
      `INSERT INTO email_variant (workspace_id, campaign_id, language_id, source_variant_id, draft_content, draft_hash, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [DEFAULT_WORKSPACE_ID, toCampaignId, v.language_id, null, JSON.stringify(content), hashOf(content), userId],
    );
    made.set(v.id, r.rows[0]!.id);
    await addEmailRevision(q, r.rows[0]!.id, userId, 'clone', content, { label: 'Copied from another email' });
  }
}

// ---------- upgrade of an email made with the previous editor ----------

const legacyLanguageId = (value: string, registry: LanguageDto[]): string | null => {
  const v = value.trim().toLowerCase();
  const hit = registry.find((l) => l.id === v || l.locale.toLowerCase() === v || l.name.toLowerCase() === v || l.aliases.includes(v));
  return hit?.id ?? null;
};

export type UpgradeReport = { languages: string[]; revisions: number; keptAsLegacy: number; skippedLanguages: string[] };

/**
 * Moves an email made with the previous editor to the language model, without deleting anything: the English email comes
 * from the Default version (with its saved versions as revisions), every language email becomes its own email with a first
 * revision, and copies written for single segments are kept untouched under legacy_variants. Safe to run again (no-op once done).
 */
export async function upgradeCampaign(q: Queryable, campaignId: string, userId: string): Promise<UpgradeReport | 'missing' | 'locked' | 'done'> {
  const camp = await q.query<{ draft_content: EmailContent; status: string; model: string }>('SELECT draft_content, status, model FROM campaign WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [campaignId, DEFAULT_WORKSPACE_ID]);
  const c = camp.rows[0];
  if (!c) return 'missing';
  if (c.model === 'v2') return 'done';
  if (c.status !== 'draft') return 'locked';
  const registry = await listLanguages(q);
  const content = normalizeContent(c.draft_content);
  const strip = (x: EmailContent): EmailContent => { const { variants: _v, versioning: _g, ...rest } = x; return rest as EmailContent; };

  const ids: string[] = ['en'];
  const skipped: string[] = [];
  const languageEmails: { languageId: string; content: EmailContent }[] = [];
  const segmentCopies = (content.variants ?? []).filter((v) => !v.kind);
  for (const v of (content.variants ?? []).filter((x) => x.kind === 'language')) {
    const id = legacyLanguageId(v.values[0] ?? '', registry);
    if (!id || id === 'en' || ids.includes(id)) { skipped.push(v.values[0] ?? ''); continue; }
    ids.push(id);
    languageEmails.push({ languageId: id, content: { schemaVersion: 1, settings: v.settings, blocks: v.blocks } as EmailContent });
  }
  await setSelectedLanguages(q, campaignId, ids);

  const mk = async (languageId: string, body: EmailContent, kind: 'created' | 'upgrade'): Promise<string> => {
    const r = await q.query<{ id: string }>(
      `INSERT INTO email_variant (workspace_id, campaign_id, language_id, draft_content, draft_hash, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
      [DEFAULT_WORKSPACE_ID, campaignId, languageId, JSON.stringify(body), hashOf(body), userId],
    );
    const id = r.rows[0]!.id;
    if (kind === 'upgrade') await addEmailRevision(q, id, userId, 'upgrade', body, { label: 'Moved from the previous editor' });
    return id;
  };

  const english = strip(content);
  const enId = await mk('en', english, 'created');
  // the saved versions of the previous editor become the English email's revisions (same order, same content without language emails)
  const old = await q.query<{ number: number; kind: string; label: string | null; content: EmailContent; created_by: string; created_at: Date }>(
    'SELECT number, kind, label, content, created_by, created_at FROM campaign_revision WHERE campaign_id = $1 ORDER BY number', [campaignId],
  );
  let revisions = 0;
  for (const r of old.rows) {
    const body = strip(normalizeContent(r.content));
    const kind = r.kind === 'restore' ? 'restore' : r.kind === 'manual' ? 'manual' : 'upgrade';
    await addEmailRevision(q, enId, r.created_by, kind, body, { label: r.label });
    revisions++;
  }
  // the working draft always has a saved revision to match, so "unsaved changes" starts false
  if (hashOf(english) !== (old.rows.length ? hashOf(strip(normalizeContent(old.rows[old.rows.length - 1]!.content))) : '')) {
    await addEmailRevision(q, enId, userId, 'upgrade', english, { label: 'Moved from the previous editor' });
    revisions++;
  }
  for (const l of languageEmails) { await mk(l.languageId, l.content, 'upgrade'); revisions++; }

  await q.query(
    `UPDATE campaign SET model = 'v2', legacy_variants = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
    [campaignId, segmentCopies.length ? JSON.stringify(segmentCopies) : null, userId],
  );
  return { languages: ids, revisions, keptAsLegacy: segmentCopies.length, skippedLanguages: skipped };
}

