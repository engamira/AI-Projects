import type { ContactFieldType } from './contacts.js';

// Conditions decide whether a block is shown to a contact ("Show this block when Country is UAE or KSA and VIP is yes").
// They only look at the campaign's segment fields, so every segment gets exactly one result that can be previewed and checked.

export type Comparison = 'is' | 'is_not' | 'contains' | 'not_contains' | 'is_one_of' | 'is_blank' | 'is_not_blank' | 'greater' | 'less';

export type ConditionRule = { field: string; op: Comparison; values: string[] };
export type ConditionGroup = { match: 'all' | 'any'; rules: (ConditionRule | ConditionGroup)[] };

export const MAX_CONDITION_RULES = 20;
export const MAX_CONDITION_DEPTH = 3;
const MAX_VALUES = 20;
const MAX_VALUE_LENGTH = 100;

/** Which comparisons make sense for each kind of field. */
export const COMPARISONS: Record<ContactFieldType, Comparison[]> = {
  text: ['is', 'is_not', 'contains', 'not_contains', 'is_one_of', 'is_blank', 'is_not_blank'],
  number: ['is', 'is_not', 'greater', 'less', 'is_one_of', 'is_blank', 'is_not_blank'],
  date: ['is', 'is_not', 'greater', 'less', 'is_blank', 'is_not_blank'],
  boolean: ['is', 'is_not'],
};

const LABELS: Record<Comparison, string> = {
  is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain', is_one_of: 'is one of',
  is_blank: 'is blank', is_not_blank: 'is not blank', greater: 'is greater than', less: 'is less than',
};
export function comparisonLabel(op: Comparison, type: ContactFieldType = 'text'): string {
  if (type === 'date' && op === 'greater') return 'is after';
  if (type === 'date' && op === 'less') return 'is before';
  return LABELS[op];
}
export const needsValue = (op: Comparison): boolean => op !== 'is_blank' && op !== 'is_not_blank';
export const allowsSeveralValues = (op: Comparison): boolean => op === 'is_one_of';

export const emptyRule = (field: string): ConditionRule => ({ field, op: 'is', values: [''] });
export const emptyGroup = (field: string): ConditionGroup => ({ match: 'all', rules: [emptyRule(field)] });
export const isGroup = (x: ConditionRule | ConditionGroup): x is ConditionGroup => 'rules' in x;

/** Checks the shape of a stored condition. Returns an error message or null. */
export function validateCondition(input: unknown): string | null {
  let count = 0;
  const walk = (x: unknown, depth: number): string | null => {
    if (!x || typeof x !== 'object') return 'a condition is not valid';
    if (depth > MAX_CONDITION_DEPTH) return `conditions can be nested at most ${MAX_CONDITION_DEPTH} levels deep`;
    const o = x as Record<string, unknown>;
    if ('rules' in o) {
      if (o.match !== 'all' && o.match !== 'any') return 'a condition group must be "all" or "any"';
      if (!Array.isArray(o.rules) || o.rules.length === 0) return 'a condition group needs at least one rule';
      for (const r of o.rules) { const e = walk(r, depth + 1); if (e) return e; }
      return null;
    }
    if (++count > MAX_CONDITION_RULES) return `a block can have at most ${MAX_CONDITION_RULES} condition rules`;
    if (typeof o.field !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(o.field)) return 'a condition rule has an invalid field';
    const ops = Object.values(COMPARISONS).flat();
    if (typeof o.op !== 'string' || !ops.includes(o.op as Comparison)) return 'a condition rule has an unknown comparison';
    if (!Array.isArray(o.values) || o.values.length > MAX_VALUES || o.values.some((v) => typeof v !== 'string' || v.length > MAX_VALUE_LENGTH)) return 'a condition rule has invalid values';
    if (needsValue(o.op as Comparison) && o.values.length === 0) return 'a condition rule needs a value';
    return null;
  };
  const top = input as { rules?: unknown } | null;
  if (!top || typeof top !== 'object' || !('rules' in top)) return 'a condition is not valid';
  return walk(input, 1);
}

type Value = string | number | boolean | null | undefined;
const isBlank = (v: Value): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const yes = (v: Value): boolean | null => {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['yes', 'true', '1', 'y'].includes(s)) return true;
  if (['no', 'false', '0', 'n'].includes(s)) return false;
  return null;
};
const day = (v: Value): string => String(v ?? '').trim().slice(0, 10);

function same(type: ContactFieldType, raw: Value, v: string): boolean {
  if (type === 'number') return Number.isFinite(Number(raw)) && Number(raw) === Number(v);
  if (type === 'date') return day(raw) !== '' && day(raw) === day(v);
  if (type === 'boolean') { const a = yes(raw); return a !== null && a === yes(v); }
  return String(raw).trim().toLowerCase() === v.trim().toLowerCase();
}

function order(type: ContactFieldType, raw: Value, v: string): number | null {
  if (type === 'number') { const a = Number(raw), b = Number(v); return Number.isFinite(a) && Number.isFinite(b) ? a - b : null; }
  if (type === 'date') { const a = day(raw), b = day(v); return a && b ? (a < b ? -1 : a > b ? 1 : 0) : null; }
  return null;
}

/** The values of a rule as a list: several values may be typed in one box separated by commas ("UAE, SA"). */
export function valueList(values: string[]): string[] {
  return values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
}

function evalRule(r: ConditionRule, get: (field: string) => Value, typeOf: (field: string) => ContactFieldType | undefined): boolean {
  const type = typeOf(r.field) ?? 'text';
  const raw = get(r.field);
  if (r.op === 'is_blank') return isBlank(raw);
  if (r.op === 'is_not_blank') return !isBlank(raw);
  if (isBlank(raw)) return r.op === 'is_not' || r.op === 'not_contains'; // a blank value is "not" anything
  const values = r.values.filter((v) => v.trim() !== '');
  const list = valueList(r.values); // "is" and "is not" also accept several values separated by commas (UAE, SA)
  switch (r.op) {
    case 'is': return list.length > 0 && list.some((v) => same(type, raw, v));
    case 'is_not': return !(list.length > 0 && list.some((v) => same(type, raw, v)));
    case 'is_one_of': return list.some((v) => same(type, raw, v));
    case 'contains': return values.length > 0 && String(raw).toLowerCase().includes(values[0]!.trim().toLowerCase());
    case 'not_contains': return !(values.length > 0 && String(raw).toLowerCase().includes(values[0]!.trim().toLowerCase()));
    case 'greater': { const c = values.length ? order(type, raw, values[0]!) : null; return c !== null && c > 0; }
    case 'less': { const c = values.length ? order(type, raw, values[0]!) : null; return c !== null && c < 0; }
  }
}

/** Does a contact (its values, by field) meet the condition? */
export function evaluateCondition(c: ConditionGroup, get: (field: string) => Value, typeOf: (field: string) => ContactFieldType | undefined = () => 'text'): boolean {
  const results = c.rules.map((r) => (isGroup(r) ? evaluateCondition(r, get, typeOf) : evalRule(r, get, typeOf)));
  return c.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

/** The condition in plain words, for showing on the block: "Country is UAE or KSA and VIP is yes". */
export function describeCondition(c: ConditionGroup, labelOf: (field: string) => string, typeOf: (field: string) => ContactFieldType | undefined = () => 'text', nested = false): string {
  const parts = c.rules.map((r) => {
    if (isGroup(r)) return describeCondition(r, labelOf, typeOf, true);
    const type = typeOf(r.field) ?? 'text';
    const vals = r.values.filter((v) => v.trim() !== '');
    const joined = r.op === 'is_one_of' || r.op === 'is' || r.op === 'is_not' ? valueList(vals).join(' or ') : vals[0] ?? '';
    return `${labelOf(r.field)} ${comparisonLabel(r.op, type)}${needsValue(r.op) ? ` ${joined || '…'}` : ''}`;
  });
  const text = parts.join(c.match === 'all' ? ' and ' : ' or ');
  return nested && parts.length > 1 ? `(${text})` : text;
}
