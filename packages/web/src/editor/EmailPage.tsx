import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { campaignStatus, type CampaignDto, type CampaignEmails, type ContactField, type EmailDraftDto, type EmailRevisionSummary } from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';
import { AudienceCtx, EditorGrid, EditorPage, useAutosave } from './EditorPage';
import { flushSave, useEditor } from './store';

// An email made with the language model: Segments (languages and their emails) and Emails (the editor of one language email).
// Audiences, Preview, Versions, QA and Builder to Check arrive in the next phases.

type TabId = 'segments' | 'emails' | 'audiences' | 'preview' | 'versions' | 'qa' | 'check';
const TABS: { id: TabId; label: string; ready: boolean }[] = [
  { id: 'segments', label: 'Segments', ready: true },
  { id: 'emails', label: 'Emails', ready: true },
  { id: 'audiences', label: 'Audiences', ready: false },
  { id: 'preview', label: 'Preview', ready: false },
  { id: 'versions', label: 'Versions', ready: false },
  { id: 'qa', label: 'QA', ready: false },
  { id: 'check', label: 'Builder to Check', ready: false },
];

/** The route of an email: the language editor for emails made with it, the previous editor for older ones. */
export function EmailRoute() {
  const { id = '' } = useParams();
  const [dto, setDto] = useState<CampaignDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDto(null);
    api<CampaignDto>('GET', `/api/campaigns/${id}`).then(setDto).catch((e) => setError(errorText(e)));
  }, [id]);
  if (error) return <main className="page"><p className="error">{error}</p><Link to="/">Back to emails</Link></main>;
  if (!dto) return <main className="page"><p>Loading…</p></main>;
  return dto.model === 'v2' ? <EmailPage campaign={dto} /> : <EditorPage />;
}

function EmailPage({ campaign }: { campaign: CampaignDto }) {
  const { can } = useSession();
  const canEdit = can('campaign.edit') && campaign.status === 'draft';
  const [params, setParams] = useSearchParams();
  const [emails, setEmails] = useState<CampaignEmails | null>(null);
  const [name, setName] = useState(campaign.name);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<ContactField[]>([]);

  const refresh = useCallback(async () => setEmails(await api<CampaignEmails>('GET', `/api/campaigns/${campaign.id}/emails`)), [campaign.id]);
  useEffect(() => { refresh().catch((e) => setError(errorText(e))); }, [refresh]);
  useEffect(() => { api<{ available: ContactField[] }>('GET', `/api/campaigns/${campaign.id}/audience`).then((a) => setFields(a.available)).catch(() => undefined); }, [campaign.id]);

  const firstWithEmail = emails?.languages.find((l) => l.variant);
  const tab = (params.get('tab') as TabId | null) ?? (emails ? (firstWithEmail ? 'emails' : 'segments') : 'segments');
  const lang = params.get('lang') ?? firstWithEmail?.id ?? 'en';
  const go = (t: TabId, l?: string) => setParams({ tab: t, ...(l ? { lang: l } : {}) }, { replace: false });

  async function rename() {
    const n = name.trim();
    if (!n || n === campaign.name) { setName(campaign.name); return; }
    try { await api('PATCH', `/api/campaigns/${campaign.id}`, { name: n }); } catch (e) { setError(errorText(e)); }
  }

  return (
    <AudienceCtx.Provider value={{ segmentFields: [], conditionFields: fields, perLanguage: true }}>
      <div className="editor">
        <div className="editor-top">
          <Link to="/" className="back">← Emails</Link>
          <input className="name-input" aria-label="Email name" value={name} readOnly={!can('campaign.edit')} maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={() => can('campaign.edit') && void rename()} />
          <span className={`badge status-${campaignStatus(campaign.status).tone}`} title={campaignStatus(campaign.status).hint}>{campaignStatus(campaign.status).label}</span>
          <div role="tablist" className="tabs">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} disabled={!t.ready} title={t.ready ? undefined : 'Coming in a later phase'} className={tab === t.id ? 'active' : ''} onClick={() => go(t.id, t.id === 'emails' ? lang : undefined)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="error" role="alert" style={{ margin: '8px 16px' }}>{error}</p>}
        {tab === 'segments' && emails && <div className="tab-body"><SegmentsTab campaignId={campaign.id} emails={emails} canEdit={canEdit} refresh={refresh} onOpen={(l) => go('emails', l)} /></div>}
        {tab === 'emails' && emails && <EmailsTab emails={emails} lang={lang} canEdit={canEdit} refresh={refresh} onPick={(l) => go('emails', l)} onSegments={() => go('segments')} />}
        {!emails && <div className="tab-body"><p>Loading…</p></div>}
      </div>
    </AudienceCtx.Provider>
  );
}

// ---------------- Segments ----------------

function SegmentsTab({ campaignId, emails, canEdit, refresh, onOpen }: { campaignId: string; emails: CampaignEmails; canEdit: boolean; refresh: () => Promise<void>; onOpen: (languageId: string) => void }) {
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = emails.languages.map((l) => l.name).join(', ');

  async function apply() {
    setError(''); setMessage(''); setBusy(true);
    try {
      const r = await api<{ duplicates: string[] }>('PUT', `/api/campaigns/${campaignId}/languages`, { input });
      await refresh();
      setInput('');
      setMessage(r.duplicates.length ? `Languages updated. Listed more than once: ${r.duplicates.join(', ')}.` : 'Languages updated.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function create(languageId: string, from: string | null) {
    setError(''); setMessage(''); setBusy(true);
    try {
      await api('POST', `/api/campaigns/${campaignId}/emails`, { languageId, createFromId: from, requestId: crypto.randomUUID() });
      await refresh();
      onOpen(languageId);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function remove(languageName: string, variantId: string) {
    if (!window.confirm(`Delete ${languageName}-Email and all its saved revisions? This cannot be undone.`)) return;
    setError(''); setBusy(true);
    try { await api('DELETE', `/api/emails/${variantId}`); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const created = emails.languages.filter((l) => l.variant);
  return (
    <div className="audience-pane">
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="ok" role="status">{message}</p>}

      <section className="seg-panel tint-choice" aria-labelledby="lang-title">
        <h2 id="lang-title">Languages list</h2>
        <p className="muted small">Type the languages of this email separated by commas, or <strong>all languages</strong>. English is the master email and always comes first.</p>
        {canEdit && (
          <div className="row">
            <div>
              <label htmlFor="languages-input">Languages</label>
              <input id="languages-input" value={input} placeholder="English, Arabic, German   or   all languages" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) void apply(); }} />
            </div>
            <div style={{ flex: '0 0 auto' }}><button type="button" className="primary" disabled={busy || !input.trim()} onClick={() => void apply()}>Apply</button></div>
          </div>
        )}
        <div className="chips" aria-label="Selected languages" data-testid="language-chips">
          {emails.languages.map((l) => <span key={l.id} className={`chip${l.id === 'en' ? ' first' : ''}`}>{l.name}</span>)}
        </div>
        <p className="muted small">{emails.languages.length} selected. Applying a new list replaces this one; a language that already has an email cannot be removed until that email is deleted.</p>
        {current === '' && <p className="muted">No languages yet.</p>}
      </section>

      <section className="seg-panel tint-who" aria-labelledby="email-list-title" data-testid="email-list">
        <h2 id="email-list-title">Email list</h2>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Email</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {emails.languages.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.emailName}</strong></td>
                  <td>
                    {l.variant
                      ? <span className="ok">Saved · revision {l.variant.latestRevision}{l.variant.unsavedChanges ? <span className="muted small"> · unsaved changes</span> : null}</span>
                      : <span className="muted">Not created</span>}
                  </td>
                  <td>
                    {l.variant && <button type="button" className="link" aria-label={`${canEdit ? 'Edit' : 'View'} ${l.emailName}`} onClick={() => onOpen(l.id)}>{canEdit ? 'Edit' : 'View'}</button>}
                    {l.variant && canEdit && <button type="button" className="link danger" aria-label={`Delete ${l.emailName}`} disabled={busy} onClick={() => void remove(l.name, l.variant!.id)}>Delete</button>}
                    {!l.variant && canEdit && l.id === 'en' && <button type="button" className="primary" aria-label="Create English-Email" disabled={busy} onClick={() => void create('en', null)}>Create</button>}
                    {!l.variant && canEdit && l.id !== 'en' && (
                      <select aria-label={`Create ${l.emailName} from`} value="" disabled={busy || created.length === 0} onChange={(e) => { if (e.target.value) void create(l.id, e.target.value); }}>
                        <option value="">{created.length === 0 ? 'Create English-Email first' : 'Create from…'}</option>
                        {created.map((c) => <option key={c.id} value={c.variant!.id}>{c.emailName}{c.variant!.unsavedChanges ? ' (copies saved revision)' : ''}</option>)}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Creating from another email copies its latest <strong>saved</strong> revision: blocks, styling and rules (with new ids). After that the two are independent, so edits to one never change the other.</p>
      </section>

      <section className="seg-panel tint-map" aria-labelledby="derived-title" data-testid="derived-segments">
        <h2 id="derived-title">Derived segments</h2>
        <p className="muted">Segments made by the show/hide rules in your emails will be listed here, read only. This arrives with the next phase (rules engine and test audiences).</p>
      </section>

      <div className="seg-next"><button type="button" className="primary" data-testid="segments-next" disabled={created.length === 0} onClick={() => onOpen(created[0]?.id ?? 'en')}>Next →</button></div>
    </div>
  );
}

// ---------------- Emails ----------------

function EmailsTab({ emails, lang, canEdit, refresh, onPick, onSegments }: {
  emails: CampaignEmails; lang: string; canEdit: boolean; refresh: () => Promise<void>; onPick: (l: string) => void; onSegments: () => void;
}) {
  const { can } = useSession();
  const selected = emails.languages.find((l) => l.id === lang && l.variant) ?? emails.languages.find((l) => l.variant);
  return (
    <>
      <div className="lang-bar" role="group" aria-label="Language">
        {emails.languages.map((l) => (
          <button key={l.id} type="button" className="lang-chip" aria-pressed={selected?.id === l.id} disabled={!l.variant} title={l.variant ? l.emailName : `${l.emailName} is not created yet: create it in Segments`} onClick={() => onPick(l.id)}>
            {l.name}
          </button>
        ))}
      </div>
      {!selected?.variant
        ? <div className="tab-body"><p className="muted">No email has been created yet. <button type="button" className="link" onClick={onSegments}>Create the English email in Segments</button>.</p></div>
        : <VariantEditor key={selected.variant.id} variantId={selected.variant.id} title={selected.emailName} canEdit={canEdit} canAny={canEdit || can('html.custom')} onSaved={refresh} />}
    </>
  );
}

function VariantEditor({ variantId, title, canEdit, canAny, onSaved }: { variantId: string; title: string; canEdit: boolean; canAny: boolean; onSaved: () => Promise<void> }) {
  const s = useEditor();
  const [live, setLive] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [revisions, setRevisions] = useState<EmailRevisionSummary[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const loadVariant = useCallback(async () => {
    try {
      const v = await api<EmailDraftDto>('GET', `/api/emails/${variantId}`);
      useEditor.getState().load({ id: v.id, name: v.name, status: v.status, model: 'v2', draft: v.draft as CampaignDto['draft'] }, `/api/emails/${variantId}/draft`);
      setRevisions(await api<EmailRevisionSummary[]>('GET', `/api/emails/${variantId}/revisions`));
      setLoadError('');
    } catch (e) { setLoadError(errorText(e)); }
  }, [variantId]);
  useEffect(() => { void loadVariant(); }, [loadVariant]);
  useAutosave(variantId, canAny, canEdit);

  const latest = revisions[0];
  const saveStateText = useMemo(() => ({
    saved: 'All changes saved', dirty: 'Unsaved changes…', saving: 'Saving…', error: s.message, invalid: `Not saved: ${s.message}`, conflict: s.message,
  } as Record<string, string>)[s.saveState] ?? '', [s.saveState, s.message]);

  async function saveRevision() {
    setNote(''); setSaving(true);
    try {
      if (!(await flushSave())) throw new Error('Fix the problem shown at the top before saving a revision.');
      const r = await api<{ number: number }>('POST', `/api/emails/${variantId}/revisions`, {});
      setRevisions(await api<EmailRevisionSummary[]>('GET', `/api/emails/${variantId}/revisions`));
      setNote(`Saved as revision ${r.number}.`);
      await onSaved();
    } catch (e) { setNote(errorText(e)); } finally { setSaving(false); }
  }

  if (loadError) return <div className="tab-body"><p className="error">{loadError}</p></div>;
  if (s.campaignId !== variantId) return <div className="tab-body"><p>Loading…</p></div>;
  return (
    <>
      <div className="email-head">
        <h1 data-testid="email-title">{title}</h1>
        <span className={`save-state ${s.saveState}`} role="status" aria-live="polite">{saveStateText}</span>
        {s.saveState === 'conflict' && <button className="primary" onClick={() => void loadVariant()}>Reload latest</button>}
        {canAny && (
          <>
            <button type="button" onClick={s.undo} disabled={s.past.length === 0} aria-label="Undo">↶ Undo</button>
            <button type="button" onClick={s.redo} disabled={s.future.length === 0} aria-label="Redo">↷ Redo</button>
          </>
        )}
        {canEdit && <button type="button" className="primary" disabled={saving} onClick={() => void saveRevision()}>Save revision</button>}
        <span className="muted small" data-testid="revision-note">{note || (latest ? `Latest saved: revision ${latest.number}` : '')}</span>
        <label className={`switch switch-small${live ? ' on' : ''}`} title="Show the real email next to the editor while you work">
          <input type="checkbox" role="switch" checked={live} onChange={(e) => setLive(e.target.checked)} />
          <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
          <span className="switch-text"><strong>Live preview</strong></span>
        </label>
      </div>
      <EditorGrid live={live} previewBase={`/api/emails/${variantId}/preview`} />
    </>
  );
}
