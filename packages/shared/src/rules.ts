import type { BlockInstance } from './content.js';
import { describeCondition, evaluateCondition, isGroup, validateCondition, valueList, type ConditionGroup, type ConditionRule } from './conditions.js';
import type { ContactFieldType } from './contacts.js';

// THE rules engine. One place decides whether a block is shown, which segments and test audiences the rules create, and why
// a block is shown or hidden. Preview, rendering, derived segments, test audiences and QA all call this module and nothing else.
//
// A block has zero or more rules. A rule says "show" or "hide" when a condition is met (AND / OR / NOT, nested).
//   - A block is hidden if any hide rule is met.
//   - Otherwise, if the block has show rules, it is shown only if one of them is met.
//   - Otherwise it is shown.   (Hide wins over show.)
// A missing value counts as blank. Older emails stored one "showWhen" condition per block: it is read as one show rule.

export type BlockRule = { id: string; effect: 'show' | 'hide'; when: ConditionGroup };
export const MAX_RULES_PER_BLOCK = 10;

type Value = string | number | boolean | null | undefined;
type TypeOf = (field: string) => ContactFieldType | undefined;
type Getter = (field: string) => Value;

export const LEGACY_RULE_ID = 'legacy-show-when';

/** All rules of a block, including the single "show when" condition of older emails. */
export function blockRules(b: Pick<BlockInstance, 'showWhen' | 'rules'>): BlockRule[] {
  return [...(b.showWhen ? [{ id: LEGACY_RULE_ID, effect: 'show' as const, when: b.showWhen }] : []), ...(b.rules ?? [])];
}

export const hasBlockRules = (b: Pick<BlockInstance, 'showWhen' | 'rules'>): boolean => blockRules(b).length > 0;

export function isBlockVisible(b: Pick<BlockInstance, 'showWhen' | 'rules'>, get: Getter, typeOf: TypeOf = () => 'text'): boolean {
  const rules = blockRules(b);
  if (rules.length === 0) return true;
  const met = (r: BlockRule) => evaluateCondition(r.when, get, typeOf);
  if (rules.some((r) => r.effect === 'hide' && met(r))) return false;
  const shows = rules.filter((r) => r.effect === 'show');
  return shows.length === 0 || shows.some(met);
}

export type BlockExplanation = { visible: boolean; reasons: { ruleId: string; effect: 'show' | 'hide'; met: boolean; text: string }[]; summary: string };

/** Why a block is shown or hidden for one contact, in plain words. */
export function explainBlock(b: Pick<BlockInstance, 'showWhen' | 'rules'>, get: Getter, typeOf: TypeOf = () => 'text', labelOf: (field: string) => string = (f) => f): BlockExplanation {
  const rules = blockRules(b);
  const visible = isBlockVisible(b, get, typeOf);
  const reasons = rules.map((r) => ({ ruleId: r.id, effect: r.effect, met: evaluateCondition(r.when, get, typeOf), text: `${r.effect === 'hide' ? 'Hide' : 'Show'} when ${describeCondition(r.when, labelOf, typeOf)}` }));
  const hidingRule = reasons.find((r) => r.effect === 'hide' && r.met);
  const summary = rules.length === 0 ? 'No rules: always shown.'
    : hidingRule ? `Hidden: ${hidingRule.text} is met.`
    : visible ? (reasons.some((r) => r.effect === 'show') ? `Shown: ${reasons.find((r) => r.effect === 'show' && r.met)!.text} is met.` : 'Shown: no hide rule is met.')
    : 'Hidden: none of its show rules is met.';
  return { visible, reasons, summary };
}

/** Blocks the contact sees. */
export function visibleBlocks(blocks: BlockInstance[], get: Getter, typeOf: TypeOf = () => 'text'): BlockInstance[] {
  return blocks.filter((b) => isBlockVisible(b, get, typeOf));
}

// ---------- shape check ----------

export function validateRules(input: unknown): string | null {
  if (input === undefined) return null;
  if (!Array.isArray(input)) return 'rules must be a list';
  if (input.length > MAX_RULES_PER_BLOCK) return `a block can have at most ${MAX_RULES_PER_BLOCK} rules`;
  const ids = new Set<string>();
  for (const r of input) {
    if (!r || typeof r !== 'object') return 'a rule is not valid';
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(o.id)) return 'a rule has an invalid id';
    if (ids.has(o.id)) return 'two rules have the same id';
    ids.add(o.id);
    if (o.effect !== 'show' && o.effect !== 'hide') return 'a rule must either show or hide the block';
    const e = validateCondition(o.when);
    if (e) return e;
  }
  return null;
}

/** New rule ids (and the same behaviour), used when a block or an email is copied. */
export function withFreshRuleIds<T extends Pick<BlockInstance, 'rules'>>(b: T): T {
  return b.rules ? { ...b, rules: b.rules.map((r) => ({ ...r, id: crypto.randomUUID() })) } : b;
}

export const newRule = (field: string, effect: 'show' | 'hide' = 'show'): BlockRule => ({ id: crypto.randomUUID(), effect, when: { match: 'all', rules: [{ field, op: 'is', values: [''] }] } });

// ---------- problems in the rules ----------

export type RuleProblem = { blockId: string; ruleId: string | null; message: string };

/** Mistakes the rules themselves can contain: unknown fields, rules that can never be met, a show and a hide rule that cancel out. */
export function lintRules(blocks: BlockInstance[], knownFields?: string[], typeOf: TypeOf = () => 'text'): RuleProblem[] {
  const out: RuleProblem[] = [];
  const leafFields = (g: ConditionGroup): string[] => g.rules.flatMap((r) => (isGroup(r) ? leafFields(r) : [r.field]));
  for (const b of blocks) {
    const rules = blockRules(b);
    for (const r of rules) {
      if (knownFields) for (const f of new Set(leafFields(r.when))) if (!knownFields.includes(f)) out.push({ blockId: b.id, ruleId: r.id, message: `A rule uses "${f}", which is not a contact field.` });
      if (!solve(r.when, true, { typeOf, labelOf: (f) => f }, {})) out.push({ blockId: b.id, ruleId: r.id, message: 'This rule can never be met.' });
    }
    const shows = rules.filter((r) => r.effect === 'show');
    for (const h of rules.filter((r) => r.effect === 'hide')) {
      if (shows.some((s) => JSON.stringify(s.when) === JSON.stringify(h.when))) out.push({ blockId: b.id, ruleId: h.id, message: 'A show rule and a hide rule have the same condition, so the block is never shown.' });
    }
  }
  return out;
}

// ---------- solving a condition: which contact values meet it, or do not ----------

type Attrs = Record<string, string | number | boolean | null>;
type Solution = { attrs: Attrs; labels: string[] };
type SolveCtx = { typeOf: TypeOf; labelOf: (field: string) => string };

/** Example values for a field when we need one that a rule does NOT mention (rules about Country UAE get a control from SA). */
const CONTROL_VALUES: Record<string, string[]> = {
  country: ['SA', 'FR', 'DE', 'US', 'JP', 'IN', 'BR', 'ZA'],
  city: ['Riyadh', 'Paris', 'Berlin', 'Tokyo', 'Mumbai', 'Lagos'],
};
const CONTROL_BY_TYPE: Record<ContactFieldType, string[]> = { text: ['Other', 'Else'], number: ['0', '1', '7', '99', '1000'], date: ['1990-01-01', '2000-06-01'], boolean: ['yes', 'no'] };

const addDays = (d: string, n: number): string | null => {
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t + n * 86400000).toISOString().slice(0, 10);
};

function convert(raw: string, type: ContactFieldType): string | number | boolean | null {
  if (raw === '') return null;
  if (type === 'number') return Number(raw);
  if (type === 'boolean') return ['yes', 'true', '1', 'y'].includes(raw.toLowerCase());
  return raw;
}

function leafCandidates(r: ConditionRule, want: boolean, type: ContactFieldType): string[] {
  const vals = valueList(r.values);
  const v = vals[0] ?? '';
  const control = [...(CONTROL_VALUES[r.field] ?? []), ...CONTROL_BY_TYPE[type]];
  const step = (n: number): string[] => {
    if (type === 'date') return [addDays(v, n), addDays(v, 2 * n)].filter((x): x is string => !!x);
    const x = Number(v);
    return Number.isFinite(x) ? [String(x + n), String(x + 2 * n)] : [];
  };
  const same = type === 'date' ? [v.slice(0, 10)] : [v];
  switch (r.op) {
    case 'is':
    case 'is_one_of': return want ? vals : control;
    case 'is_not': return want ? control : vals;
    case 'contains': return want ? [v] : control;
    case 'not_contains': return want ? control : [v];
    case 'greater': return want ? step(1) : [...same, ...step(-1)];
    case 'less': return want ? step(-1) : [...same, ...step(1)];
    case 'is_blank': return want ? [''] : [type === 'number' ? '1' : type === 'date' ? '2000-01-01' : 'x'];
    case 'is_not_blank': return want ? [type === 'number' ? '1' : type === 'date' ? '2000-01-01' : 'x'] : [''];
  }
}

function leafLabel(r: ConditionRule, ctx: SolveCtx): string {
  const field = ctx.labelOf(r.field);
  const type = ctx.typeOf(r.field) ?? 'text';
  const vals = valueList(r.values);
  const v = vals[0] ?? '';
  switch (r.op) {
    case 'is':
    case 'is_one_of':
      if (type === 'boolean') return ['yes', 'true', '1', 'y'].includes(v.toLowerCase()) ? field : `No ${field}`;
      return v;
    case 'is_not': return type === 'boolean' ? (['yes', 'true', '1', 'y'].includes(v.toLowerCase()) ? `No ${field}` : field) : `Not ${v}`;
    case 'contains': return `${field} has ${v}`;
    case 'not_contains': return `${field} lacks ${v}`;
    case 'greater': return `${field} ${type === 'date' ? 'after' : 'over'} ${v}`;
    case 'less': return `${field} ${type === 'date' ? 'before' : 'under'} ${v}`;
    case 'is_blank': return `No ${field}`;
    case 'is_not_blank': return `Has ${field}`;
  }
}

function solveLeaf(r: ConditionRule, want: boolean, ctx: SolveCtx): Solution | null {
  const type = ctx.typeOf(r.field) ?? 'text';
  const probe: ConditionGroup = { match: 'all', rules: [r] };
  for (const c of leafCandidates(r, want, type)) {
    const value = convert(c, type);
    if (evaluateCondition(probe, () => value, (f) => (f === r.field ? type : undefined)) !== want) continue;
    const label = leafLabel(r, ctx);
    return { attrs: { [r.field]: value }, labels: [want ? label : `Not ${label}`] };
  }
  return null;
}

function merge(a: Solution, b: Solution): Solution | null {
  const attrs: Attrs = { ...a.attrs };
  for (const [k, v] of Object.entries(b.attrs)) {
    if (k in attrs && String(attrs[k]).toLowerCase() !== String(v).toLowerCase()) return null; // the two parts need different values of one field
    attrs[k] = v;
  }
  return { attrs, labels: [...a.labels, ...b.labels.filter((l) => !a.labels.includes(l))] };
}

/** Values of the contact fields that meet (want = true) or do not meet (false) the condition, or null when impossible. `base` is fixed (the email's language). */
export function solve(g: ConditionGroup, want: boolean, ctx: SolveCtx, base: Attrs): Solution | null {
  const effective = g.not ? !want : want;
  const needAll = (g.match === 'all' && effective) || (g.match === 'any' && !effective);
  const solveKid = (k: ConditionRule | ConditionGroup, w: boolean) => (isGroup(k) ? solve(k, w, ctx, base) : solveLeaf(k, w, ctx));
  const fits = (s: Solution | null): Solution | null => (s && merge({ attrs: base, labels: [] }, s) ? s : null);
  if (needAll) {
    let acc: Solution = { attrs: {}, labels: [] };
    for (const k of g.rules) {
      const s = fits(solveKid(k, effective));
      const m = s && merge(acc, s);
      if (!m) return null;
      acc = m;
    }
    return acc;
  }
  for (const k of g.rules) {
    const s = fits(solveKid(k, effective));
    if (s) return s;
  }
  return null;
}

// ---------- scenarios: the segments and test audiences the rules create ----------

export type Scenario = {
  /** Identifies the scenario: the same language and values always give the same fingerprint. */
  fingerprint: string;
  kind: 'baseline' | 'scenario';
  polarity: 'baseline' | 'positive' | 'negative';
  /** "UAE VIP English" (no suffix). */
  label: string;
  segmentName: string;
  audienceName: string;
  attributes: Attrs;
  ruleIds: string[];
  /** What the email looks like for this audience. */
  expected: { visible: string[]; hidden: string[] };
};

export const MAX_SCENARIOS_PER_LANGUAGE = 60;

export function fingerprintOf(languageId: string, attrs: Attrs): string {
  const parts = Object.entries(attrs).filter(([k]) => k !== 'language').map(([k, v]) => `${k}=${String(v ?? '').toLowerCase()}`).sort();
  return `${languageId}|${parts.join('&')}`;
}

/**
 * One baseline audience for the language, plus for every rule one audience that meets it and one that does not (so both
 * the "shown" and the "hidden" outcome are tested). Fields are only combined when one rule needs them together
 * (UAE and VIP), duplicates are removed, and the number is capped.
 */
export function generateScenarios(p: { language: { id: string; name: string }; blocks: BlockInstance[]; typeOf: TypeOf; labelOf: (field: string) => string; cap?: number }): { scenarios: Scenario[]; tooMany: boolean; unreachable: RuleProblem[] } {
  const cap = p.cap ?? MAX_SCENARIOS_PER_LANGUAGE;
  const base: Attrs = { language: p.language.id };
  const ctx: SolveCtx = { typeOf: p.typeOf, labelOf: p.labelOf };
  const expectedFor = (attrs: Attrs) => {
    const get: Getter = (f) => attrs[f];
    const visible = p.blocks.filter((b) => isBlockVisible(b, get, p.typeOf)).map((b) => b.id);
    return { visible, hidden: p.blocks.filter((b) => !visible.includes(b.id)).map((b) => b.id) };
  };
  const scenarios: Scenario[] = [{
    fingerprint: fingerprintOf(p.language.id, base), kind: 'baseline', polarity: 'baseline', label: p.language.name,
    segmentName: `${p.language.name} Segment`, audienceName: `${p.language.id}-Audience`, attributes: base, ruleIds: [], expected: expectedFor(base),
  }];
  const seen = new Map<string, Scenario>([[scenarios[0]!.fingerprint, scenarios[0]!]]);
  const unreachable: RuleProblem[] = [];
  let tooMany = false;
  outer: for (const b of p.blocks) {
    for (const r of blockRules(b)) {
      for (const want of [true, false]) {
        const s = solve(r.when, want, ctx, base);
        if (!s) { if (want) unreachable.push({ blockId: b.id, ruleId: r.id, message: 'This rule can never be met for this language.' }); continue; }
        const attrs: Attrs = { ...base, ...s.attrs };
        const fp = fingerprintOf(p.language.id, attrs);
        const prior = seen.get(fp);
        if (prior) { if (!prior.ruleIds.includes(r.id)) prior.ruleIds.push(r.id); continue; }
        if (scenarios.length >= cap) { tooMany = true; break outer; }
        const label = `${s.labels.join(' ')} ${p.language.name}`.replace(/\s+/g, ' ').trim();
        const sc: Scenario = {
          fingerprint: fp, kind: 'scenario', polarity: want ? 'positive' : 'negative', label,
          segmentName: `${label} Segment`, audienceName: `${label}-Audience`, attributes: attrs, ruleIds: [r.id], expected: expectedFor(attrs),
        };
        scenarios.push(sc);
        seen.set(fp, sc);
      }
    }
  }
  return { scenarios, tooMany, unreachable };
}

