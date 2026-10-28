import {
  COMPARISONS, MAX_CONDITION_DEPTH, MAX_CONDITION_RULES, allowsSeveralValues, comparisonLabel, emptyRule, isGroup, needsValue,
  type Comparison, type ConditionGroup, type ConditionRule, type ContactField,
} from '@cl/shared';

const plain = (label: string): string => label.replace(/ \(.*\)$/, '');

const countRules = (g: ConditionGroup): number => g.rules.reduce((n, r) => n + (isGroup(r) ? countRules(r) : 1), 0);

function RuleRow({ rule, fields, disabled, onChange, onRemove, canRemove }: {
  rule: ConditionRule; fields: ContactField[]; disabled?: boolean; onChange: (r: ConditionRule) => void; onRemove: () => void; canRemove: boolean;
}) {
  const field = fields.find((f) => f.key === rule.field) ?? fields[0]!;
  const type = field.type;
  const ops = COMPARISONS[type];
  const setField = (key: string) => {
    const f = fields.find((x) => x.key === key)!;
    const op: Comparison = COMPARISONS[f.type].includes(rule.op) ? rule.op : 'is';
    onChange({ field: key, op, values: needsValue(op) ? [f.type === 'boolean' ? 'yes' : ''] : [] });
  };
  const setOp = (op: Comparison) => onChange({ ...rule, op, values: needsValue(op) ? (rule.values.length ? (allowsSeveralValues(op) ? rule.values : [rule.values[0]!]) : ['']) : [] });
  return (
    <div className="cond-rule">
      <select aria-label="Field" disabled={disabled} value={field.key} onChange={(e) => setField(e.target.value)}>
        {fields.map((f) => <option key={f.key} value={f.key}>{plain(f.label)}</option>)}
      </select>
      <select aria-label="Comparison" disabled={disabled} value={rule.op} onChange={(e) => setOp(e.target.value as Comparison)}>
        {ops.map((o) => <option key={o} value={o}>{comparisonLabel(o, type)}</option>)}
      </select>
      {needsValue(rule.op) && type === 'boolean' && (
        <select aria-label="Value" disabled={disabled} value={rule.values[0] ?? 'yes'} onChange={(e) => onChange({ ...rule, values: [e.target.value] })}>
          <option value="yes">Yes</option><option value="no">No</option>
        </select>
      )}
      {needsValue(rule.op) && type !== 'boolean' && allowsSeveralValues(rule.op) && (
        <input aria-label="Values (separate several with commas)" disabled={disabled} placeholder="e.g. UAE, KSA" value={rule.values.join(', ')}
          onChange={(e) => onChange({ ...rule, values: e.target.value.split(',').map((s) => s.trimStart()) })} />
      )}
      {needsValue(rule.op) && type !== 'boolean' && !allowsSeveralValues(rule.op) && (
        <input aria-label="Value" disabled={disabled} type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'} value={rule.values[0] ?? ''} placeholder={type === 'text' && (rule.op === 'is' || rule.op === 'is_not') ? 'e.g. UAE, SA' : ''}
          onChange={(e) => onChange({ ...rule, values: [e.target.value] })} />
      )}
      {canRemove && !disabled && <button type="button" className="link danger" aria-label="Remove this rule" onClick={onRemove}>Remove</button>}
    </div>
  );
}

/**
 * Builds "show this block when …": rules about the campaign's segment fields, joined by AND (all) or OR (any),
 * with groups for mixed logic such as "(Country is UAE or KSA) and VIP is yes".
 */
export function ConditionBuilder({ value, fields, onChange, disabled, depth = 1, onRemoveGroup }: {
  value: ConditionGroup; fields: ContactField[]; onChange: (g: ConditionGroup) => void; disabled?: boolean; depth?: number; onRemoveGroup?: () => void;
}) {
  const total = countRules(value);
  const setRule = (i: number, r: ConditionRule | ConditionGroup) => onChange({ ...value, rules: value.rules.map((x, k) => (k === i ? r : x)) });
  const removeAt = (i: number) => onChange({ ...value, rules: value.rules.filter((_, k) => k !== i) });
  const first = fields[0]!;
  return (
    <div className={`cond-group depth-${depth}`} role="group" aria-label={depth === 1 ? 'Conditions' : 'Group of conditions'}>
      <div className="cond-head">
        <span>{depth === 1 ? 'When' : 'Group'}</span>
        <label className="cond-not" title="Met when these conditions are NOT met"><input type="checkbox" disabled={disabled} checked={!!value.not} onChange={(e) => { const { not: _n, ...rest } = value; onChange(e.target.checked ? { ...rest, not: true } : rest); }} /> NOT</label>
        {onRemoveGroup && !disabled && <button type="button" className="link danger" onClick={onRemoveGroup}>Remove group</button>}
      </div>
      {value.rules.map((r, i) => (
        <div key={i}>
          {i > 0 && (
            <div className="cond-join">
              <select aria-label={`Join rule ${i} and ${i + 1} with`} disabled={disabled} value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as 'all' | 'any' })}>
                <option value="all">AND</option>
                <option value="any">OR</option>
              </select>
            </div>
          )}
          {isGroup(r)
            ? <ConditionBuilder value={r} fields={fields} depth={depth + 1} disabled={disabled} onChange={(g) => setRule(i, g)} onRemoveGroup={() => removeAt(i)} />
            : <RuleRow rule={r} fields={fields} disabled={disabled} canRemove={value.rules.length > 1 || depth > 1} onChange={(x) => setRule(i, x)} onRemove={() => removeAt(i)} />}
        </div>
      ))}
      {!disabled && (
        <div className="cond-add">
          <button type="button" disabled={total >= MAX_CONDITION_RULES} onClick={() => onChange({ ...value, rules: [...value.rules, emptyRule(first.key)] })}>＋ Add a rule</button>
          {depth < MAX_CONDITION_DEPTH && <button type="button" disabled={total >= MAX_CONDITION_RULES} onClick={() => onChange({ ...value, rules: [...value.rules, { match: value.match === 'all' ? 'any' : 'all', rules: [emptyRule(first.key)] }] })}>＋ Add a group</button>}
        </div>
      )}
    </div>
  );
}
