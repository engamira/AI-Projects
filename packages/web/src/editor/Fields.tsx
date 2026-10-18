import { useId, useState } from 'react';
import { checkField, type FieldDef, type FieldGroup, type PropValue } from '@cl/shared';
import { pictureSrc } from '../api';
import { AssetPickerDialog } from './AssetPicker';

const GROUP_LABELS: Record<FieldGroup, string> = { content: 'Content', style: 'Style', spacing: 'Spacing' };

function FieldInput({ field, value, onChange }: { field: FieldDef; value: PropValue; onChange: (v: PropValue) => void }) {
  const id = useId();
  const [picking, setPicking] = useState(false);
  const error = checkField(field, value);
  const describedBy = [field.help ? `${id}-help` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
  const common = { id, 'aria-invalid': !!error, 'aria-describedby': describedBy };

  let control;
  switch (field.kind) {
    case 'textarea':
      control = <textarea {...common} rows={4} maxLength={field.max} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'select':
      control = (
        <select {...common} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {field.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'toggle':
      return (
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {field.label}
          </label>
        </div>
      );
    case 'number':
      control = (
        <div className="num-row">
          <input type="range" aria-label={`${field.label} slider`} min={field.min} max={field.max} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />
          <input {...common} type="number" min={field.min} max={field.max} value={Number(value)} onChange={(e) => onChange(Math.round(Number(e.target.value)))} />
          <span className="muted">{field.unit ?? 'px'}</span>
        </div>
      );
      break;
    case 'image': {
      const v = String(value);
      control = (
        <div className="picture-field">
          {v && <img className="picture-thumb" src={pictureSrc(v)} alt="" />}
          <div className="picture-actions">
            <button type="button" onClick={() => setPicking(true)}>{v ? 'Change picture' : 'Choose or upload a picture'}</button>
            {v && <button type="button" className="link" onClick={() => onChange('')}>Remove</button>}
          </div>
          <input {...common} type="text" inputMode="url" placeholder="…or paste a secure https:// picture address" maxLength={2000} value={v.startsWith('asset:') ? '' : v} onChange={(e) => onChange(e.target.value)} />
          {picking && <AssetPickerDialog onClose={() => setPicking(false)} onPick={(ref) => onChange(ref)} />}
        </div>
      );
      break;
    }
    default:
      control = (
        <input
          {...common}
          type="text"
          inputMode={field.kind === 'url' ? 'url' : undefined}
          placeholder={field.kind === 'url' ? 'https://…' : undefined}
          maxLength={field.kind === 'url' ? 2000 : field.max}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      {control}
      {field.help && <div id={`${id}-help`} className="muted small">{field.help}</div>}
      {error && <div id={`${id}-err`} className="error small" role="alert">{error}</div>}
    </div>
  );
}

export function FieldForm({
  fields,
  values,
  onChange,
  disabled,
}: {
  fields: FieldDef[];
  values: Record<string, PropValue>;
  onChange: (key: string, v: PropValue) => void;
  disabled?: boolean;
}) {
  const groups: FieldGroup[] = ['content', 'style', 'spacing'];
  return (
    <fieldset disabled={disabled} className="form-fieldset">
      {groups.map((g) => {
        const list = fields.filter((f) => f.group === g);
        if (!list.length) return null;
        return (
          <section key={g} aria-label={GROUP_LABELS[g]}>
            <h3>{GROUP_LABELS[g]}</h3>
            {list.map((f) => <FieldInput key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => onChange(f.key, v)} />)}
          </section>
        );
      })}
    </fieldset>
  );
}
