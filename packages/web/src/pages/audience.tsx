import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  CONTACT_FIELDS, EXCLUSION_LABELS, IMPORT_MAX_BYTES, MAX_CONTACTS,
  type ContactDto, type ContactsResponse, type ImportPreview, type ImportResult,
} from '@cl/shared';
import { api, errorText } from '../api';

const SAMPLE_CSV = [
  'Email,First Name,Last Name,Company,Country,City,Language,Customer Since,Orders,VIP,Marketing Permission',
  'amira.test+01@example.com,Amira,Ali,Example Travel,UAE,Dubai,en,2023-03-14,12,yes,yes',
  'omar.test+02@example.com,Omar,Khalid,Example Travel,UAE,Abu Dhabi,ar,2022-11-02,5,no,yes',
  'sofia.test+03@example.com,Sofia,Marin,Demo Studio,Portugal,Lisbon,pt,2024-01-20,0,no,yes',
  'daniel.test+04@example.com,Daniel,Okafor,Sample Group,Nigeria,Lagos,en,2021-07-09,31,yes,yes',
  'mei.test+05@example.com,Mei,Tanaka,Example Labs,Japan,Tokyo,ja,2024-06-30,2,no,yes',
  'arjun.test+06@example.com,Arjun,Rao,Demo Institute,India,Mumbai,en,2020-12-01,18,yes,yes',
  'lena.test+07@example.com,,Fischer,Sample Media,Germany,Berlin,de,2023-09-09,1,no,yes',
  'nour.test+08@example.com,Nour,Haddad,Example Co,Jordan,Amman,ar,2022-05-17,7,no,no',
  'carlos.test+09@example.com,Carlos,Vega,Demo Studio,Spain,Madrid,es,2024-02-11,3,no,yes',
  'priya.test+10@example.com,Priya,Nair,Example Travel,UAE,Sharjah,en,2023-08-25,9,yes,yes',
].join('\n');

const STATUS_LABEL: Record<ImportPreview['sample'][number]['status'], string> = {
  add: 'Will be added', update: 'Will be updated', skip_existing: 'Already stored: skipped', over_limit: 'Not saved: limit full', duplicate: 'Repeated in file: skipped', invalid: 'Problem: skipped',
};

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

function Importer({ stored, onDone }: { stored: number; onDone: (r: ImportResult) => void }) {
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [mapping, setMapping] = useState<Record<string, string> | undefined>(undefined);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (text: string, map: Record<string, string> | undefined, upd: boolean) => {
    setError('');
    try {
      const p = await api<ImportPreview>('POST', '/api/contacts/import/preview', { csv: text, mapping: map, updateExisting: upd });
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
    await run(text, undefined, updateExisting);
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const r = await api<ImportResult>('POST', '/api/contacts/import', { csv, mapping, updateExisting, filename });
      setCsv(''); setPreview(null); setFilename('');
      onDone(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const nothingToSave = preview && preview.willAdd === 0 && preview.willUpdate === 0;

  return (
    <div className="card wide">
      <h2 style={{ marginTop: 0 }}>Import contacts from a CSV file</h2>
      <p className="muted small">You can store at most {MAX_CONTACTS} contacts ({stored} stored now). Use real email addresses of people who agreed to hear from you. Nothing is saved until you press Import.</p>
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
            {CONTACT_FIELDS.map((f) => (
              <label key={f.key}>{f.label}{f.required ? ' *' : ''}
                <select
                  aria-label={`Column for ${f.label}`}
                  value={mapping?.[f.key] ?? ''}
                  onChange={(e) => { const next = { ...(mapping ?? {}), [f.key]: e.target.value }; setMapping(next); void run(csv, next, updateExisting); }}
                >
                  <option value="">{f.required ? '— choose a column —' : '— not in my file —'}</option>
                  {preview.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div style={{ margin: '12px 0' }}>
            <Switch on={updateExisting} onChange={(v) => { setUpdateExisting(v); void run(csv, mapping, v); }} label="Update contacts I already have" hint={updateExisting ? 'On: matching emails get the new details (blank cells change nothing)' : 'Off: contacts already stored are left as they are'} />
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
            <button type="button" onClick={() => { setPreview(null); setCsv(''); setFilename(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const FIELD_KEYS = CONTACT_FIELDS.filter((f) => f.key !== 'marketing_permission');

function ContactDialog({ contact, onClose, onSaved }: { contact: ContactDto | null; onClose: () => void; onSaved: () => void }) {
  const initial: Record<string, string> = contact
    ? {
        email: contact.email, first_name: contact.firstName ?? '', last_name: contact.lastName ?? '', company: contact.company ?? '', country: contact.country ?? '', city: contact.city ?? '', language: contact.language ?? '',
        customer_since: contact.customerSince ?? '', orders: contact.orders === null ? '' : String(contact.orders), vip: contact.vip === null ? '' : contact.vip ? 'yes' : 'no', marketing_permission: contact.marketingActive ? 'yes' : 'no',
      }
    : { marketing_permission: 'yes' };
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
          {FIELD_KEYS.map((f) => (
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

export function AudiencePage() {
  const [data, setData] = useState<ContactsResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<ContactDto | 'new' | null>(null);

  const load = useCallback(async () => setData(await api<ContactsResponse>('GET', '/api/contacts')), []);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  const guarded = async (fn: () => Promise<void>) => {
    setError('');
    try { await fn(); await load(); } catch (e) { setError(errorText(e)); }
  };
  const contacts = data?.contacts ?? [];
  const eligible = contacts.filter((c) => !c.excludedReason).length;
  const full = contacts.length >= MAX_CONTACTS;

  return (
    <>
      <h1>Audience</h1>
      <p className="muted">Your contact list: up to {MAX_CONTACTS} people. Filters and saved audiences come next; for now you can import, add and manage contacts.</p>

      <div className="capacity" role="status" aria-label="Contacts stored">
        <div className="capacity-bar" aria-hidden="true"><i style={{ width: `${(contacts.length / MAX_CONTACTS) * 100}%` }} /></div>
        <strong>{contacts.length} of {MAX_CONTACTS} contacts stored</strong>
        <span className="muted small"> · {eligible} eligible to receive marketing email</span>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok" role="status">{notice}</p>}

      <Importer stored={contacts.length} onDone={(r) => { setNotice(`Imported: ${r.added} added, ${r.updated} updated, ${r.overLimit} not saved (limit), ${r.invalid} with problems, ${r.duplicatesInFile} repeated.`); void load(); }} />

      <div className="row" style={{ alignItems: 'center', margin: '16px 0 8px' }}>
        <h2 style={{ margin: 0 }}>Contacts</h2>
        <div style={{ flex: '0 0 auto' }}><button type="button" disabled={full} title={full ? `The limit of ${MAX_CONTACTS} contacts is full` : undefined} onClick={() => setEditing('new')}>Add a contact</button></div>
      </div>
      {contacts.length === 0 && data && <p className="muted">No contacts yet. Import a file above, or add one by hand.</p>}
      {contacts.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Email</th><th>Name</th><th>Company</th><th>Country</th><th>Orders</th><th>VIP</th><th>Can receive?</th><th>Actions</th></tr></thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.email}</td>
                  <td>{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td>{c.company ?? '—'}</td>
                  <td>{c.country ?? '—'}</td>
                  <td>{c.orders ?? '—'}</td>
                  <td>{c.vip === null ? '—' : c.vip ? 'Yes' : 'No'}</td>
                  <td>{c.excludedReason ? <span className="badge status-warn" title="This contact is left out of every send">{EXCLUSION_LABELS[c.excludedReason].split(' (')[0]}</span> : <span className="badge status-good">Eligible</span>}</td>
                  <td className="row-actions">
                    <button className="link" aria-label={`Edit ${c.email}`} onClick={() => setEditing(c)}>Edit</button>
                    {!c.unsubscribedAt && <button className="link" aria-label={`Mark ${c.email} as unsubscribed`} onClick={() => { if (window.confirm(`Record that ${c.email} unsubscribed? They will never be sent marketing email. This cannot be undone here.`)) void guarded(async () => { await api('POST', `/api/contacts/${c.id}/mark/unsubscribed`); }); }}>Unsubscribed</button>}
                    {!c.suppressedReason && <button className="link" aria-label={`Suppress ${c.email}`} onClick={() => { if (window.confirm(`Suppress ${c.email}? They will never be sent email (as after a bounce or complaint). This cannot be undone here.`)) void guarded(async () => { await api('POST', `/api/contacts/${c.id}/mark/suppressed`); }); }}>Suppress</button>}
                    <button className="link danger" aria-label={`Delete ${c.email}`} onClick={() => { if (window.confirm(`Delete ${c.email}? This frees one place in the ${MAX_CONTACTS}-contact limit.`)) void guarded(async () => { await api('DELETE', `/api/contacts/${c.id}`); }); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ContactDialog contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </>
  );
}
