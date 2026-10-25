import { MAX_SEGMENT_FIELDS, type ContactField } from '@cl/shared';

const plain = (label: string): string => label.replace(/ \(.*\)$/, '');

/**
 * Choose the fields that split an audience into segments: one drop-down per field, up to 10, so any number of
 * combinations is possible and the list stays tidy however many fields exist. The order of the drop-downs is the
 * order of the segment name (Country, Language gives UAE-en).
 */
export function SegmentFieldPicker({ available, chosen, onChange, disabled, idPrefix = 'segfield', max = MAX_SEGMENT_FIELDS }: {
  available: ContactField[];
  chosen: string[];
  onChange: (keys: string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
  /** The most fields that can be chosen (default 10). */
  max?: number;
}) {
  const valid = chosen.filter((k) => available.some((f) => f.key === k));
  const rows = valid.length < max && valid.length < available.length ? [...valid, ''] : valid; // one empty drop-down to add the next field
  if (rows.length === 0) rows.push('');

  const choices = (current: string) => available.filter((f) => f.key === current || !valid.includes(f.key));
  const set = (index: number, key: string) => {
    const next = [...valid];
    if (key === '') next.splice(index, 1);
    else if (index < next.length) next[index] = key;
    else next.push(key);
    onChange(next);
  };

  return (
    <div className="seg-picker" role="group" aria-label="Fields to segment by">
      {rows.map((current, i) => (
        <div className="seg-picker-row" key={i}>
          <label htmlFor={`${idPrefix}-${i}`}>{i === 0 ? 'Segment by' : `Then by`} <span className="muted small">{max > 1 ? `(field ${i + 1} of up to ${max})` : ''}</span></label>
          <select id={`${idPrefix}-${i}`} disabled={disabled} value={current} onChange={(e) => set(i, e.target.value)}>
            <option value="">{current ? '— remove this field —' : i === 0 ? '— choose a field —' : '— add another field —'}</option>
            {choices(current).map((f) => <option key={f.key} value={f.key}>{plain(f.label)}{f.custom ? ' (my field)' : ''}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}
