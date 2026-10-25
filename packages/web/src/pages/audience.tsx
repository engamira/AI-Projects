import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  EXCLUSION_LABELS, IMPORT_MAX_BYTES, fieldValue, valueLabel,
  type ContactDto, type ContactField, type ContactFieldType, type ContactsResponse, type ImportPreview, type ImportResult, type NewFieldRequest, type SegmentsResponse,
} from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';
import { SegmentFieldPicker } from '../components/SegmentFieldPicker';

const SAMPLE_CSV = [
  'Email,First Name,Last Name,Company,Country,City,Language,Customer Since,Orders,VIP,Marketing Permission,Interest',
  'amira.test+01@example.com,Amira,Ali,Example Travel,UAE,Dubai,en,2023-03-14,12,yes,yes,Flights',
  'omar.test+02@example.com,Omar,Khalid,Example Travel,UAE,Abu Dhabi,ar,2022-11-02,5,no,yes,Hotels',
  'sofia.test+03@example.com,Sofia,Marin,Demo Studio,Portugal,Lisbon,pt,2024-01-20,0,no,yes,Flights',
  'daniel.test+04@example.com,Daniel,Okafor,Sample Group,Nigeria,Lagos,en,2021-07-09,31,yes,yes,Cruises',
  'mei.test+05@example.com,Mei,Tanaka,Example Labs,Japan,Tokyo,ja,2024-06-30,2,no,yes,Hotels',
  'arjun.test+06@example.com,Arjun,Rao,Demo Institute,India,Mumbai,en,2020-12-01,18,yes,yes,Flights',
  'lena.test+07@example.com,,Fischer,Sample Media,Germany,Berlin,de,2023-09-09,1,no,yes,Cruises',
  'nour.test+08@example.com,Nour,Haddad,Example Co,Jordan,Amman,ar,2022-05-17,7,no,no,Hotels',
  'carlos.test+09@example.com,Carlos,Vega,Demo Studio,Spain,Madrid,es,2024-02-11,3,no,yes,Flights',
  'priya.test+10@example.com,Priya,Nair,Example Travel,UAE,Sharjah,en,2023-08-25,9,yes,yes,Hotels',
].join('\n');

const STATUS_LABEL: Record<ImportPreview['sample'][number]['status'], string> = {
  add: 'Will be added', update: 'Will be updated', skip_existing: 'Already stored: skipped', over_limit: 'Not saved: limit full', duplicate: 'Repeated in file: skipped', invalid: 'Problem: skipped',
};
const TYPE_LABEL: Record<ContactFieldType, string> = { text: 'Text', number: 'Number', date: 'Date', boolean: 'Yes / no' };

function downloadSample() {
  const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sample-contacts.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className={`switch${on ? ' on' : ''}`}>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      <span className="switch-text"><strong>{label}</strong><small>{hint}</small></span>
    </label>
  );
}

const display = (c: ContactDto, f: ContactField): string => {
  const v = fieldValue(c, f.key);
  return v === null || v === '' ? '—' : f.type === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
};

// ---------- Import ----------
function Importer({ stored, max, onDone }: { stored: number; max: number; onDone: (r: ImportResult) => void }) {
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [mapping, setMapping] = useState<Record<string, string> | undefined>(undefined);
  const [newFields, setNewFields] = useState<Record<string, { label: string; type: ContactFieldType }>>({}); // by CSV column
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const requestFor = (nf: typeof newFields): NewFieldRequest[] => Object.entries(nf).filter(([, v]) => v.label.trim()).map(([column, v]) => ({ column, label: v.label, type: v.type }));

  const run = useCallback(async (text: string, map: Record<string, string> | undefined, upd: boolean, nf: NewFieldRequest[]) => {
    setError('');
    try {
      const p = await api<ImportPreview>('POST', '/api/contacts/import/preview', { csv: text, mapping: map, updateExisting: upd, newFields: nf });
      setPreview(p);
      setMapping(p.mapping);
    } catch (e) {
      setPreview(null);
      setError(errorText(e));
    }
  }, []);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > IMPORT_MAX_BYTES) return setError(`That file is larger than ${IMPORT_MAX_BYTES / 1024} KB.`);
    const text = await f.text();
    setCsv(text);
    setFilename(f.name);
    setMapping(undefined);
    setNewFields({});
    await run(text, undefined, updateExisting, []);
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const r = await api<ImportResult>('POST', '/api/contacts/import', { csv, mapping, updateExisting, filename, newFields: requestFor(newFields) });
      setCsv(''); setPreview(null); setFilename(''); setNewFields({});
      onDone(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const nothingToSave = preview && preview.willAdd === 0 && preview.willUpdate === 0;
  const mappedColumns = new Set(Object.values(mapping ?? {}));
  const unmatched = preview ? preview.columns.filter((c) => !mappedColumns.has(c) || c in newFields) : [];
  const choosable = preview?.fields ?? [];

  return (
    <div className="card wide">
      <h2 style={{ marginTop: 0 }}>Import contacts from a CSV file</h2>
      <p className="muted small">The limit is {max} contacts ({stored} stored now). Use real email addresses of people who agreed to hear from you. Nothing is saved until you press Import.</p>
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ flex: '0 0 auto' }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" hidden aria-label="Choose a CSV file" onChange={(e) => void onFile(e)} />
          <button type="button" className="primary" onClick={() => fileRef.current?.click()}>Choose a CSV file</button>
        </div>
        <button type="button" className="link" onClick={downloadSample}>Download an example file</button>
        {filename && <span className="muted small">{filename}</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {preview && (
        <div data-testid="import-preview">
          <h3>Which column is which?</h3>
          <div className="map-grid">
            {choosable.map((f) => (
              <label key={f.key}>{f.label}{f.required ? ' *' : ''}
                <select
                  aria-label={`Column for ${f.label}`}
                  value={mapping?.[f.key] ?? ''}
                  onChange={(e) => { const next = { ...(mapping ?? {}), [f.key]: e.target.value }; setMapping(next); void run(csv, next, updateExisting, requestFor(newFields)); }}
                >
                  <option value="">{f.required ? '— choose a column —' : '— not in my file —'}</option>
                  {preview.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            ))}
          </div>

          {unmatched.length > 0 && (
            <div className="new-fields">
              <h3>Columns that did not match a field</h3>
              <p className="muted small">Bring a column in as a new field of your own (for example "Country of residence" or "Interest") to use it later for segments. Leave it unticked to ignore the column.</p>
              {unmatched.map((c) => {
                const on = c in newFields;
                return (
                  <div key={c} className="new-field-row">
                    <label className="check"><input type="checkbox" checked={on} onChange={(e) => {
                      const next = { ...newFields };
                      if (e.target.checked) next[c] = { label: c.slice(0, 40), type: 'text' }; else delete next[c];
                      setNewFields(next);
                      void run(csv, mapping, updateExisting, requestFor(next));
                    }} /> <span>Import <strong>{c}</strong> as a new field</span></label>
                    {on && (
                      <>
                        <input aria-label={`Name of the new field for ${c}`} maxLength={40} value={newFields[c]!.label} onChange={(e) => setNewFields({ ...newFields, [c]: { ...newFields[c]!, label: e.target.value } })} onBlur={() => void run(csv, mapping, updateExisting, requestFor(newFields))} />
                        <select aria-label={`Kind of values in ${c}`} value={newFields[c]!.type} onChange={(e) => { const next = { ...newFields, [c]: { ...newFields[c]!, type: e.target.value as ContactFieldType } }; setNewFields(next); void run(csv, mapping, updateExisting, requestFor(next)); }}>
                          {(Object.keys(TYPE_LABEL) as ContactFieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                        </select>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ margin: '12px 0' }}>
            <Switch on={updateExisting} onChange={(v) => { setUpdateExisting(v); void run(csv, mapping, v, requestFor(newFields)); }} label="Update contacts I already have" hint={updateExisting ? 'On: matching emails get the new details (blank cells change nothing)' : 'Off: contacts already stored are left as they are'} />
          </div>

          <div className="import-stats" role="group" aria-label="What will happen">
            <div className="stat good"><strong>{preview.willAdd}</strong><span>will be added</span></div>
            <div className="stat"><strong>{preview.willUpdate}</strong><span>will be updated</span></div>
            <div className="stat"><strong>{preview.existing - preview.willUpdate}</strong><span>already stored, skipped</span></div>
            <div className="stat warn"><strong>{preview.overLimit}</strong><span>over the limit, not saved</span></div>
            <div className="stat warn"><strong>{preview.invalid}</strong><span>have a problem</span></div>
            <div className="stat"><strong>{preview.duplicatesInFile}</strong><span>repeated in the file</span></div>
          </div>
          <p className="muted small">{preview.totalRows} rows in the file. Room left before this import: {preview.capacity.free} of {preview.capacity.max}.</p>

          {preview.issues.length > 0 && (
            <details open>
              <summary>{preview.issues.length} row{preview.issues.length > 1 ? 's' : ''} to look at</summary>
              <ul className="issue-list">{preview.issues.map((i, k) => <li key={k}><strong>Line {i.row}</strong>{i.email ? ` (${i.email})` : ''}: {i.message}</li>)}</ul>
            </details>
          )}
          <div className="table-scroll">
            <table>
              <thead><tr><th>Email</th><th>Name</th><th>What happens</th></tr></thead>
              <tbody>
                {preview.sample.map((s, k) => <tr key={k}><td>{s.email || '—'}</td><td>{[s.firstName, s.lastName].filter(Boolean).join(' ') || '—'}</td><td><span className={`badge ${s.status === 'add' || s.status === 'update' ? 'status-good' : 'status-warn'}`}>{STATUS_LABEL[s.status]}</span></td></tr>)}
              </tbody>
            </table>
          </div>
          {preview.totalRows > preview.sample.length && <p className="muted small">Showing the first {preview.sample.length} rows.</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <div style={{ flex: '0 0 auto' }}>
              <button type="button" className="primary" disabled={busy || !!nothingToSave} onClick={() => void confirm()}>
                {busy ? 'Importing…' : nothingToSave ? 'Nothing to import' : `Import ${preview.willAdd + preview.willUpdate} contact${preview.willAdd + preview.willUpdate === 1 ? '' : 's'}`}
              </button>
            </div>
            <button type="button" onClick={() => { setPreview(null); setCsv(''); setFilename(''); setNewFields({}); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- One contact ----------
function ContactDialog({ contact, fields, onClose, onSaved }: { contact: ContactDto | null; fields: ContactField[]; onClose: () => void; onSaved: () => void }) {
  const initial: Record<string, string> = { marketing_permission: contact ? (contact.marketingActive ? 'yes' : 'no') : 'yes' };
  if (contact) {
    for (const f of fields) {
      if (f.key === 'marketing_permission') continue;
      const v = fieldValue(contact, f.key);
      initial[f.key] = v === null ? '' : f.type === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    }
  }
  const [v, setV] = useState<Record<string, string>>(initial);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (contact) await api('PATCH', `/api/contacts/${contact.id}`, v);
      else await api('POST', '/api/contacts', v);
      onSaved();
    } catch (err) { setError(errorText(err)); }
  }
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-label={contact ? 'Edit contact' : 'Add a contact'} onSubmit={(e) => void submit(e)}>
        <h2 style={{ marginTop: 0 }}>{contact ? 'Edit contact' : 'Add a contact'}</h2>
        <div className="map-grid">
          {fields.filter((f) => f.key !== 'marketing_permission').map((f) => (
            <label key={f.key}>{f.label}{f.required ? ' *' : ''}
              {f.type === 'boolean'
                ? <select value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}><option value="">Not set</option><option value="yes">Yes</option><option value="no">No</option></select>
                : <input type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'numeric' : undefined} required={f.required} maxLength={f.max ?? 40} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}
            </label>
          ))}
          <label>Marketing permission
            <select value={v.marketing_permission ?? 'yes'} onChange={(e) => setV({ ...v, marketing_permission: e.target.value })}><option value="yes">Active: may be sent marketing email</option><option value="no">Inactive: never sent marketing email</option></select>
          </label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <div style={{ flex: '0 0 auto' }}><button className="primary">{contact ? 'Save' : 'Add contact'}</button></div>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// ---------- Settings and fields ----------
function LimitSetting({ max, ceiling, stored, onSaved }: { max: number; ceiling: number; stored: number; onSaved: () => void }) {
  const [value, setValue] = useState(String(max));
  const [msg, setMsg] = useState('');
  const [bad, setBad] = useState(false);
  useEffect(() => setValue(String(max)), [max]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    try {
      await api('PUT', '/api/audience/settings', { contactLimit: Number(value) });
      setBad(false);
      setMsg('Saved.');
      onSaved();
    } catch (err) { setBad(true); setMsg(errorText(err)); }
  }
  return (
    <form className="card wide" onSubmit={(e) => void save(e)}>
      <h2 style={{ marginTop: 0 }}>Contact limit</h2>
      <p className="muted small">While the app is being tested the limit is 10. When you are ready for your real audience, raise it here (up to {ceiling}). It cannot be lower than the {stored} contacts stored now.</p>
      <div className="row" style={{ alignItems: 'end' }}>
        <div><label htmlFor="limit">Most contacts that can be stored</label><input id="limit" type="number" min={1} max={ceiling} value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: 160 }} /></div>
        <div style={{ flex: '0 0 auto' }}><button className="primary" disabled={Number(value) === max}>Save limit</button></div>
      </div>
      {msg && <p className={bad ? 'error' : 'ok'} role={bad ? 'alert' : 'status'}>{msg}</p>}
    </form>
  );
}

function FieldsManager({ fields, onChanged }: { fields: ContactField[]; onChanged: () => void }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<ContactFieldType>('text');
  const [error, setError] = useState('');
  const custom = fields.filter((f) => f.custom);
  async function add(e: FormEvent) {
    e.preventDefault();
    setError('');
    try { await api('POST', '/api/contact-fields', { label, type }); setLabel(''); onChanged(); } catch (err) { setError(errorText(err)); }
  }
  async function remove(f: ContactField) {
    if (!window.confirm(`Remove the field "${f.label}"? Its values are removed from every contact.`)) return;
    setError('');
    try { await api('DELETE', `/api/contact-fields/${f.key}`); onChanged(); } catch (err) { setError(errorText(err)); }
  }
  return (
    <div className="card wide">
      <h2 style={{ marginTop: 0 }}>Your own fields</h2>
      <p className="muted small">Add fields such as "Country of residence" or "Interest" to keep on each contact. Any field, built in or your own, can be used to segment an audience.</p>
      {custom.length > 0 && (
        <ul className="field-chips">
          {custom.map((f) => <li key={f.key}>{f.label} <span className="muted small">({TYPE_LABEL[f.type]})</span> <button type="button" className="link danger" aria-label={`Remove field ${f.label}`} onClick={() => void remove(f)}>Remove</button></li>)}
        </ul>
      )}
      <form onSubmit={(e) => void add(e)} className="row" style={{ alignItems: 'end' }}>
        <div><label htmlFor="newfield">New field name</label><input id="newfield" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Country of residence" /></div>
        <div style={{ flex: '0 0 160px' }}><label htmlFor="newtype">Kind of values</label><select id="newtype" value={type} onChange={(e) => setType(e.target.value as ContactFieldType)}>{(Object.keys(TYPE_LABEL) as ContactFieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></div>
        <div style={{ flex: '0 0 auto' }}><button className="primary" disabled={!label.trim()}>Add field</button></div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// ---------- Segments ----------
const SEGMENT_KEY = 'cl.segmentFields';

function SegmentExplorer({ fields, refreshKey }: { fields: ContactField[]; refreshKey: number }) {
  const choices = fields.filter((f) => f.key !== 'email' && f.key !== 'marketing_permission');
  const [chosen, setChosen] = useState<string[]>(() => {
    try { return (JSON.parse(localStorage.getItem(SEGMENT_KEY) ?? '[]') as string[]).filter((k) => typeof k === 'string'); } catch { return []; }
  });
  const [data, setData] = useState<SegmentsResponse | null>(null);
  const [error, setError] = useState('');
  const valid = chosen.filter((k) => choices.some((f) => f.key === k));

  useEffect(() => {
    try { localStorage.setItem(SEGMENT_KEY, JSON.stringify(valid)); } catch { /* a remembered choice is only a convenience */ }
    if (valid.length === 0) { setData(null); return; }
    let live = true;
    api<SegmentsResponse>('GET', `/api/audience/segments?fields=${valid.join(',')}`)
      .then((r) => { if (live) { setData(r); setError(''); } })
      .catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [valid.join(','), refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card wide" data-testid="segments">
      <h2 style={{ marginTop: 0 }}>Segments</h2>
      <p className="muted small">Choose the fields to split your contacts into groups, one drop-down per field (up to 10). For example Country then Language gives one segment for each combination, named like UAE-en. Each campaign can use different fields.</p>
      <SegmentFieldPicker available={choices} chosen={valid} onChange={setChosen} idPrefix="explorer" />
      {error && <p className="error" role="alert">{error}</p>}
      {valid.length === 0 && <p className="muted">Pick at least one field to see the segments.</p>}
      {data && (
        <>
          <p className="muted small">{data.segments.length} segment{data.segments.length === 1 ? '' : 's'} from {data.totalContacts} contacts ({data.totalEligible} eligible to receive marketing email).</p>
          <div className="table-scroll">
            <table>
              <thead><tr>{data.fields.map((f) => <th key={f.key}>{f.label}</th>)}<th>Contacts</th><th>Eligible</th><th>Examples</th></tr></thead>
              <tbody>
                {data.segments.map((s) => (
                  <tr key={s.id}>
                    {s.values.map((v, i) => <td key={i}>{valueLabel(v)}</td>)}
                    <td>{s.total}</td>
                    <td>{s.eligible}{s.eligible < s.total && <span className="muted small"> ({s.total - s.eligible} excluded)</span>}</td>
                    <td className="muted small">{s.sampleEmails.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function AudiencePage() {
  const { can } = useSession();
  const [data, setData] = useState<ContactsResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<ContactDto | 'new' | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => { setData(await api<ContactsResponse>('GET', '/api/contacts')); setVersion((v) => v + 1); }, []);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  const guarded = async (fn: () => Promise<void>) => {
    setError('');
    try { await fn(); await load(); } catch (e) { setError(errorText(e)); }
  };
  const contacts = data?.contacts ?? [];
  const max = data?.max ?? 10;
  const fields = data?.fields ?? [];
  const eligible = contacts.filter((c) => !c.excludedReason).length;
  const full = contacts.length >= max;
  const shownFields = fields.filter((f) => !['email', 'first_name', 'last_name', 'marketing_permission'].includes(f.key));

  return (
    <>
      <h1>Audience</h1>
      <p className="muted">Your contacts, your own fields, and the segments you can send to. Filters and saved audiences for each campaign come next.</p>

      <div className="capacity" role="status" aria-label="Contacts stored">
        <div className="capacity-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (contacts.length / max) * 100)}%` }} /></div>
        <strong>{contacts.length} of {max} contacts stored</strong>
        <span className="muted small"> · {eligible} eligible to receive marketing email</span>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok" role="status">{notice}</p>}

      <Importer stored={contacts.length} max={max} onDone={(r) => { setNotice(`Imported: ${r.added} added, ${r.updated} updated, ${r.overLimit} not saved (limit), ${r.invalid} with problems, ${r.duplicatesInFile} repeated.`); void load(); }} />

      <SegmentExplorer fields={fields} refreshKey={version} />
      <FieldsManager fields={fields} onChanged={() => void load()} />
      {can('audience.settings') && data && <LimitSetting max={data.max} ceiling={data.ceiling} stored={contacts.length} onSaved={() => void load()} />}

      <div className="row" style={{ alignItems: 'center', margin: '16px 0 8px' }}>
        <h2 style={{ margin: 0 }}>Contacts</h2>
        <div style={{ flex: '0 0 auto' }}><button type="button" disabled={full} title={full ? `The limit of ${max} contacts is full` : undefined} onClick={() => setEditing('new')}>Add a contact</button></div>
      </div>
      {contacts.length === 0 && data && <p className="muted">No contacts yet. Import a file above, or add one by hand.</p>}
      {contacts.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Email</th><th>Name</th>{shownFields.map((f) => <th key={f.key}>{f.label.replace(/ \(.*\)$/, '')}</th>)}<th>Can receive?</th><th>Actions</th></tr></thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.email}</td>
                  <td>{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</td>
                  {shownFields.map((f) => <td key={f.key}>{display(c, f)}</td>)}
                  <td>{c.excludedReason ? <span className="badge status-warn" title="This contact is left out of every send">{EXCLUSION_LABELS[c.excludedReason].split(' (')[0]}</span> : <span className="badge status-good">Eligible</span>}</td>
                  <td className="row-actions">
                    <button className="link" aria-label={`Edit ${c.email}`} onClick={() => setEditing(c)}>Edit</button>
                    {!c.unsubscribedAt && <button className="link" aria-label={`Mark ${c.email} as unsubscribed`} onClick={() => { if (window.confirm(`Record that ${c.email} unsubscribed? They will never be sent marketing email. This cannot be undone here.`)) void guarded(async () => { await api('POST', `/api/contacts/${c.id}/mark/unsubscribed`); }); }}>Unsubscribed</button>}
                    {!c.suppressedReason && <button className="link" aria-label={`Suppress ${c.email}`} onClick={() => { if (window.confirm(`Suppress ${c.email}? They will never be sent email (as after a bounce or complaint). This cannot be undone here.`)) void guarded(async () => { await api('POST', `/api/contacts/${c.id}/mark/suppressed`); }); }}>Suppress</button>}
                    <button className="link danger" aria-label={`Delete ${c.email}`} onClick={() => { if (window.confirm(`Delete ${c.email}? This frees one place in the ${max}-contact limit.`)) void guarded(async () => { await api('DELETE', `/api/contacts/${c.id}`); }); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ContactDialog contact={editing === 'new' ? null : editing} fields={fields} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </>
  );
}
