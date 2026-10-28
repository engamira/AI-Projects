import { blockDefinition, blockRules, describeCondition, type BlockInstance, type EmailContent } from '@cl/shared';

// What changed between two saved revisions of one language email, in plain words.

export type BlockChange = { id: string; label: string; change: 'added' | 'removed' | 'changed' | 'moved'; details: string[] };
export type RevisionDiff = { settings: { key: string; from: string; to: string }[]; blocks: BlockChange[]; same: boolean };

const SETTING_LABELS: Record<string, string> = { subject: 'Subject line', preheader: 'Preview text', senderName: 'Sender name', senderEmail: 'Sender email', replyTo: 'Reply-to email', contentWidth: 'Email width', fontFamily: 'Font', palette: 'Template colors' };

const text = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'string') return v.length > 70 ? `${v.slice(0, 67)}…` : v;
  return JSON.stringify(v).slice(0, 70);
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const label = (b: BlockInstance): string => blockDefinition(b.type)?.label ?? b.type;
const rulesText = (b: BlockInstance): string => (blockRules(b).map((r) => `${r.effect === 'hide' ? 'hide' : 'show'} when ${describeCondition(r.when, (f) => f)}`).join('; ') || 'no rules');

export function diffRevisions(from: EmailContent, to: EmailContent): RevisionDiff {
  const settings: RevisionDiff['settings'] = [];
  for (const key of new Set([...Object.keys(from.settings), ...Object.keys(to.settings)])) {
    const a = (from.settings as unknown as Record<string, unknown>)[key];
    const b = (to.settings as unknown as Record<string, unknown>)[key];
    if (!same(a, b)) settings.push({ key: SETTING_LABELS[key] ?? key, from: text(a), to: text(b) });
  }
  const blocks: BlockChange[] = [];
  const before = new Map(from.blocks.map((b, i) => [b.id, { b, i }]));
  const after = new Map(to.blocks.map((b, i) => [b.id, { b, i }]));
  for (const { b } of before.values()) if (!after.has(b.id)) blocks.push({ id: b.id, label: label(b), change: 'removed', details: [] });
  for (const [i, b] of to.blocks.entries()) {
    const old = before.get(b.id);
    if (!old) { blocks.push({ id: b.id, label: label(b), change: 'added', details: [] }); continue; }
    const details: string[] = [];
    for (const k of new Set([...Object.keys(old.b.props), ...Object.keys(b.props)])) {
      if (!same(old.b.props[k], b.props[k])) details.push(`${k}: ${text(old.b.props[k])} → ${text(b.props[k])}`);
    }
    if (rulesText(old.b) !== rulesText(b)) details.push(`rules: ${rulesText(old.b)} → ${rulesText(b)}`);
    if (details.length) blocks.push({ id: b.id, label: label(b), change: 'changed', details });
    else if (old.i !== i && from.blocks.length === to.blocks.length) blocks.push({ id: b.id, label: label(b), change: 'moved', details: [`position ${old.i + 1} → ${i + 1}`] });
  }
  return { settings, blocks, same: settings.length === 0 && blocks.length === 0 };
}
