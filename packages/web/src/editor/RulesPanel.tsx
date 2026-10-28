import { useContext } from 'react';
import { MAX_RULES_PER_BLOCK, blockRules, lintRules, newRule, type BlockInstance, type BlockRule } from '@cl/shared';
import { ConditionBuilder } from '../components/ConditionBuilder';
import { AudienceCtx } from './EditorPage';
import { useEditor } from './store';

const plain = (label: string): string => label.replace(/ \(.*\)$/, '');

/**
 * The rules of one block: any number of "show when" / "hide when" rules, each an AND / OR / NOT condition on any contact
 * field. A block with no rules is shown to everyone; hide wins over show. The segments and test audiences follow these rules.
 */
export function RulesPanel({ block, canEdit }: { block: BlockInstance; canEdit: boolean }) {
  const { conditionFields } = useContext(AudienceCtx);
  const setRules = useEditor((s) => s.setRules);
  const rules = blockRules(block);
  const defaultField = (conditionFields.find((f) => f.key === 'country') ?? conditionFields[0])?.key;
  // the older single "show when" is written back as a normal rule with its own id the first time it is edited
  const write = (next: BlockRule[]) => setRules(block.id, next.map((r) => (r.id === 'legacy-show-when' ? { ...r, id: crypto.randomUUID() } : r)));
  const problems = lintRules([block], conditionFields.map((f) => f.key), (k) => conditionFields.find((f) => f.key === k)?.type);

  if (!defaultField) return <div className="show-when"><h3>Rules</h3><p className="muted small">No contact fields are available yet.</p></div>;
  return (
    <div className="show-when" data-testid="show-when">
      <h3>Rules for this block</h3>
      {rules.length === 0 && <p className="muted small">No rules: everyone sees this block.</p>}
      {rules.map((r, i) => (
        <div key={r.id} className={`rule-card ${r.effect}`} data-testid="rule-card">
          <div className="rule-head">
            <select aria-label={`Rule ${i + 1}: show or hide`} disabled={!canEdit} value={r.effect} onChange={(e) => write(rules.map((x) => (x.id === r.id ? { ...x, effect: e.target.value as 'show' | 'hide' } : x)))}>
              <option value="show">Show this block when…</option>
              <option value="hide">Hide this block when…</option>
            </select>
            {canEdit && <button type="button" className="link danger" aria-label={`Remove rule ${i + 1}`} onClick={() => write(rules.filter((x) => x.id !== r.id))}>Remove rule</button>}
          </div>
          <ConditionBuilder value={r.when} fields={conditionFields} disabled={!canEdit} onChange={(g) => write(rules.map((x) => (x.id === r.id ? { ...x, when: g } : x)))} />
        </div>
      ))}
      {canEdit && (
        <p>
          <button type="button" disabled={rules.length >= MAX_RULES_PER_BLOCK} onClick={() => write([...rules, newRule(defaultField, rules.length ? 'hide' : 'show')])}>＋ Add a show/hide rule</button>
        </p>
      )}
      {problems.map((p, i) => <p key={i} className="error small" role="alert">{p.message}</p>)}
      <p className="muted small">If a hide rule is met the block is hidden, even when a show rule is also met. Segments and test audiences are made from these rules ({conditionFields.slice(0, 4).map((f) => plain(f.label)).join(', ')}…).</p>
    </div>
  );
}
