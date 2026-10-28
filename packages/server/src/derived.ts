import { blockRules, canonicalJson, generateScenarios, lintRules, normalizeContent, type DerivedResponse, type EmailContent, type Scenario } from '@cl/shared';
import { allFields } from './contacts.js';
import { sha256 } from './crypto.js';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';
import { listLanguages, selectedLanguageIds } from './emails.js';

// Segments and test audiences made from the rules of the language emails. They are rebuilt from the saved drafts whenever the
// languages or the rules change, in the same transaction as the change, so they never disagree with the emails.

/** What the segments and audiences depend on: which blocks exist and their rules (not the words in the email). */
export const rulesSignature = (c: EmailContent): string => canonicalJson(c.blocks.map((b) => [b.id, blockRules(b)]));

const plain = (label: string): string => label.replace(/ \(.*\)$/, '');
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Robin', 'Casey', 'Morgan', 'Riley', 'Jamie', 'Quinn'];

type Desired = { scenario: Scenario; languageId: string; name: string; email: string; data: Record<string, unknown>; position: number };

/** What the rules of the saved drafts create, without writing anything. */
export async function planDerived(q: Queryable, campaignId: string): Promise<{ desired: Desired[]; warnings: { languageId: string; message: string }[] } | null> {
  const camp = await q.query<{ model: string }>('SELECT model FROM campaign WHERE id = $1 AND workspace_id = $2', [campaignId, DEFAULT_WORKSPACE_ID]);
  if (camp.rows[0]?.model !== 'v2') return null;
  const registry = await listLanguages(q);
  const fields = await allFields(q);
  const typeOf = (k: string) => fields.find((f) => f.key === k)?.type;
  const labelOf = (k: string) => plain(fields.find((f) => f.key === k)?.label ?? k);
  const selected = await selectedLanguageIds(q, campaignId);
  const variants = await q.query<{ language_id: string; draft_content: EmailContent }>('SELECT language_id, draft_content FROM email_variant WHERE campaign_id = $1', [campaignId]);
  const byLanguage = new Map(variants.rows.map((v) => [v.language_id, normalizeContent(v.draft_content)]));

  const warnings: { languageId: string; message: string }[] = [];
  const desired: Desired[] = [];
  const usedEmails = new Set<string>();
  for (const [i, id] of selected.entries()) {
    const language = registry.find((l) => l.id === id);
    if (!language) continue;
    const content = byLanguage.get(id);
    const blocks = content?.blocks ?? [];
    const gen = generateScenarios({ language: { id, name: language.name }, blocks, typeOf, labelOf });
    if (gen.tooMany) warnings.push({ languageId: id, message: `${language.name} has more rule scenarios than the limit, so some are not listed.` });
    for (const u of gen.unreachable) warnings.push({ languageId: id, message: u.message });
    for (const p of lintRules(blocks, fields.map((f) => f.key), typeOf)) warnings.push({ languageId: id, message: p.message });
    for (const sc of gen.scenarios) {
      let email = `${slug(sc.audienceName)}@test-audience.invalid`;
      if (usedEmails.has(email)) email = `${slug(sc.audienceName)}-${sha256(sc.fingerprint).slice(0, 6)}@test-audience.invalid`;
      usedEmails.add(email);
      const data: Record<string, unknown> = { first_name: FIRST_NAMES[(i + desired.length) % FIRST_NAMES.length], last_name: 'Test', company: 'Test Co', email, ...sc.attributes };
      desired.push({ scenario: sc, languageId: id, name: sc.audienceName, email, data, position: gen.scenarios.indexOf(sc) });
    }
  }

  return { desired, warnings };
}

/** Rebuilds the derived segments and test audiences of one email from its saved drafts. Safe to run any number of times. */
export async function syncDerived(q: Queryable, campaignId: string): Promise<{ warnings: { languageId: string; message: string }[] }> {
  const plan = await planDerived(q, campaignId);
  if (!plan) return { warnings: [] };
  const { desired, warnings } = plan;

  // test audiences
  const have = await q.query<{ id: string; fingerprint: string; name: string; attributes: unknown; rule_ids: unknown; expected: unknown; email: string; position: number }>(
    'SELECT id, fingerprint, name, attributes, rule_ids, expected, email, position FROM test_audience WHERE campaign_id = $1', [campaignId]);
  const haveBy = new Map(have.rows.map((r) => [r.fingerprint, r]));
  const want = new Set(desired.map((d) => d.scenario.fingerprint));
  for (const r of have.rows) if (!want.has(r.fingerprint)) await q.query('DELETE FROM test_audience WHERE id = $1', [r.id]);
  for (const d of desired) {
    const sc = d.scenario;
    const row = haveBy.get(sc.fingerprint);
    if (!row) {
      await q.query(
        `INSERT INTO test_audience (workspace_id, campaign_id, language_id, fingerprint, kind, polarity, name, email, attributes, rule_ids, expected, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [DEFAULT_WORKSPACE_ID, campaignId, d.languageId, sc.fingerprint, sc.kind, sc.polarity, d.name, d.email, JSON.stringify(d.data), JSON.stringify(sc.ruleIds), JSON.stringify(sc.expected), d.position],
      );
    } else if (row.name !== d.name || canonicalJson(row.rule_ids) !== canonicalJson(sc.ruleIds) || canonicalJson(row.expected) !== canonicalJson(sc.expected) || canonicalJson(row.attributes) !== canonicalJson(d.data) || row.email !== d.email || row.position !== d.position) {
      await q.query('UPDATE test_audience SET name = $2, email = $3, attributes = $4, rule_ids = $5, expected = $6, position = $7 WHERE id = $1',
        [row.id, d.name, d.email, JSON.stringify(d.data), JSON.stringify(sc.ruleIds), JSON.stringify(sc.expected), d.position]);
    }
  }

  // derived segments (every scenario except the baseline)
  const haveSeg = await q.query<{ id: string; fingerprint: string; name: string; predicate: unknown; rule_ids: unknown; position: number }>('SELECT id, fingerprint, name, predicate, rule_ids, position FROM derived_segment WHERE campaign_id = $1', [campaignId]);
  const segBy = new Map(haveSeg.rows.map((r) => [r.fingerprint, r]));
  const wantSeg = desired.filter((d) => d.scenario.kind === 'scenario');
  const wantSegFp = new Set(wantSeg.map((d) => d.scenario.fingerprint));
  for (const r of haveSeg.rows) if (!wantSegFp.has(r.fingerprint)) await q.query('DELETE FROM derived_segment WHERE id = $1', [r.id]);
  for (const d of wantSeg) {
    const sc = d.scenario;
    const row = segBy.get(sc.fingerprint);
    if (!row) {
      await q.query(
        `INSERT INTO derived_segment (workspace_id, campaign_id, language_id, fingerprint, name, polarity, predicate, rule_ids, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [DEFAULT_WORKSPACE_ID, campaignId, d.languageId, sc.fingerprint, sc.segmentName, sc.polarity, JSON.stringify(sc.attributes), JSON.stringify(sc.ruleIds), d.position],
      );
    } else if (row.name !== sc.segmentName || canonicalJson(row.rule_ids) !== canonicalJson(sc.ruleIds) || canonicalJson(row.predicate) !== canonicalJson(sc.attributes) || row.position !== d.position) {
      await q.query('UPDATE derived_segment SET name = $2, predicate = $3, rule_ids = $4, position = $5 WHERE id = $1', [row.id, sc.segmentName, JSON.stringify(sc.attributes), JSON.stringify(sc.ruleIds), d.position]);
    }
  }
  return { warnings };
}

export async function readDerived(q: Queryable, campaignId: string): Promise<DerivedResponse> {
  const seg = await q.query<{ id: string; language_id: string; name: string; polarity: 'positive' | 'negative'; predicate: Record<string, unknown>; rule_ids: string[] }>(
    `SELECT s.id, s.language_id, s.name, s.polarity, s.predicate, s.rule_ids FROM derived_segment s JOIN language l ON l.id = s.language_id
      WHERE s.campaign_id = $1 ORDER BY l.sort, s.position`, [campaignId]);
  const aud = await q.query<{ id: string; language_id: string; kind: 'baseline' | 'scenario'; polarity: 'baseline' | 'positive' | 'negative'; name: string; email: string; attributes: Record<string, unknown>; rule_ids: string[]; expected: { visible: string[]; hidden: string[] } }>(
    `SELECT a.id, a.language_id, a.kind, a.polarity, a.name, a.email, a.attributes, a.rule_ids, a.expected FROM test_audience a JOIN language l ON l.id = a.language_id
      WHERE a.campaign_id = $1 ORDER BY l.sort, a.position`, [campaignId]);
  return {
    segments: seg.rows.map((r) => ({ id: r.id, languageId: r.language_id, name: r.name, polarity: r.polarity, predicate: r.predicate, ruleIds: r.rule_ids })),
    audiences: aud.rows.map((r) => ({ id: r.id, languageId: r.language_id, kind: r.kind, polarity: r.polarity, name: r.name, email: r.email, attributes: r.attributes, ruleIds: r.rule_ids, expected: r.expected })),
    warnings: (await planDerived(q, campaignId))?.warnings ?? [],
  };
}
