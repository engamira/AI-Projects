import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { SAMPLE_RECIPIENTS, campaignStatus, type CampaignDto, type CampaignEmails, type ContactField, type DerivedResponse, type EmailDraftDto, type EmailRevisionDetail, type EmailRevisionSummary, type PreviewResponse, type QaSubmissionResult, type TestAudienceDto, type EmailContent } from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';
import { AudienceCtx, DESKTOP_WIDTHS, DeviceFrame, EditorGrid, EditorPage, PHONE_WIDTHS, useAutosave } from './EditorPage';
import { diffRevisions } from './revisionDiff';
import { CheckTab, QaTab } from './QaTabs';
import { flushSave, useEditor } from './store';

// An email made with the language model: Segments (languages and their emails) and Emails (the editor of one language email).
// Audiences, Preview, Versions, QA and Builder to Check arrive in the next phases.

type TabId = 'segments' | 'emails' | 'audiences' | 'preview' | 'versions' | 'qa' | 'check';
const TABS: { id: TabId; label: string; ready: boolean }[] = [
  { id: 'segments', label: 'Segments', ready: true },
  { id: 'emails', label: 'Emails', ready: true },
  { id: 'audiences', label: 'Audiences', ready: true },
  { id: 'preview', label: 'Preview', ready: true },
  { id: 'versions', label: 'Versions', ready: true },
  { id: 'qa', label: 'QA', ready: true },
  { id: 'check', label: 'Builder to Check', ready: true },
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
  // leaving the editor saves first, so the segments and audiences the rules make are up to date when the next tab opens
  const go = (t: TabId, l?: string, extra: Record<string, string> = {}) => {
    const keepLang = t === 'emails' || t === 'preview' || t === 'versions' || !!l;
    void flushSave().finally(() => setParams({ tab: t, ...(keepLang ? { lang: l ?? lang } : {}), ...extra }, { replace: false }));
  };

  async function rename() {
    const n = name.trim();
    if (!n || n === campaign.name) { setName(campaign.name); return; }
    try { await api('PATCH', `/api/campaigns/${campaign.id}`, { name: n }); } catch (e) { setError(errorText(e)); }
  }

  return (
    <AudienceCtx.Provider value={{ segmentFields: [], conditionFields: fields, perLanguage: true, multi: true }}>
      <div className="editor">
        <div className="editor-top">
          <Link to="/" className="back">← Emails</Link>
          <input className="name-input" aria-label="Email name" value={name} readOnly={!can('campaign.edit')} maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={() => can('campaign.edit') && void rename()} />
          <span className={`badge status-${campaignStatus(campaign.status).tone}`} title={campaignStatus(campaign.status).hint}>{campaignStatus(campaign.status).label}</span>
          <div role="tablist" className="tabs">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} disabled={!t.ready} title={t.ready ? undefined : 'Coming in a later phase'} className={tab === t.id ? 'active' : ''} onClick={() => go(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="error" role="alert" style={{ margin: '8px 16px' }}>{error}</p>}
        {tab === 'segments' && emails && <div className="tab-body"><SegmentsTab campaignId={campaign.id} emails={emails} canEdit={canEdit} refresh={refresh} onOpen={(l) => go('emails', l)} /></div>}
        {tab === 'preview' && emails && <div className="tab-body"><PreviewTab campaignId={campaign.id} emails={emails} lang={lang} aud={params.get('aud')} rev={params.get('rev')} go={go} /></div>}
        {tab === 'versions' && emails && <div className="tab-body"><VersionsTab emails={emails} lang={lang} canEdit={canEdit} canSubmit={can('campaign.submit') && campaign.status === 'draft'} refresh={refresh} go={go} /></div>}
        {tab === 'qa' && emails && <div className="tab-body"><QaTab campaignId={campaign.id} emails={emails} lang={lang} go={go} /></div>}
        {tab === 'check' && emails && <div className="tab-body"><CheckTab campaignId={campaign.id} emails={emails} go={go} /></div>}
        {tab === 'audiences' && emails && <div className="tab-body"><AudiencesTab campaignId={campaign.id} emails={emails} fields={fields} onEmails={() => go('emails')} onNext={() => go('preview')} /></div>}
        {tab === 'emails' && emails && <EmailsTab emails={emails} lang={lang} canEdit={canEdit} refresh={refresh} onPick={(l) => go('emails', l)} onSegments={() => go('segments')} onNext={() => go('audiences')} selectBlock={params.get('block')} />}
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

      <DerivedSegments campaignId={campaignId} languages={emails.languages.map((l) => ({ id: l.id, name: l.name }))} />

      <div className="seg-next"><button type="button" className="primary" data-testid="segments-next" disabled={created.length === 0} onClick={() => onOpen(created[0]?.id ?? 'en')}>Next →</button></div>
    </div>
  );
}

// ---------------- Emails ----------------

function EmailsTab({ emails, lang, canEdit, refresh, onPick, onSegments, onNext, selectBlock }: {
  emails: CampaignEmails; lang: string; canEdit: boolean; refresh: () => Promise<void>; onPick: (l: string) => void; onSegments: () => void; onNext: () => void; selectBlock: string | null;
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
        : <VariantEditor key={selected.variant.id} variantId={selected.variant.id} title={selected.emailName} canEdit={canEdit} canAny={canEdit || can('html.custom')} onSaved={refresh} onNext={onNext} selectBlock={selectBlock} />}
    </>
  );
}

function VariantEditor({ variantId, title, canEdit, canAny, onSaved, onNext, selectBlock }: { onNext: () => void; selectBlock: string | null; variantId: string; title: string; canEdit: boolean; canAny: boolean; onSaved: () => Promise<void> }) {
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
      if (selectBlock) useEditor.getState().select(selectBlock); // arrived from a QA finding: the block is selected
      setLoadError('');
    } catch (e) { setLoadError(errorText(e)); }
  }, [variantId, selectBlock]);
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
        <button type="button" className="primary" data-testid="next-tab" style={{ marginLeft: 'auto' }} onClick={onNext}>Next →</button>
      </div>
      <EditorGrid live={live} previewBase={`/api/emails/${variantId}/preview`} />
    </>
  );
}

// ---------------- Derived segments (Segments tab) ----------------

function useDerived(campaignId: string) {
  const [data, setData] = useState<DerivedResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<DerivedResponse>('GET', `/api/campaigns/${campaignId}/derived`).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [campaignId]);
  return { data, error };
}

function DerivedSegments({ campaignId, languages }: { campaignId: string; languages: { id: string; name: string }[] }) {
  const { data, error } = useDerived(campaignId);
  return (
    <section className="seg-panel tint-map" aria-labelledby="derived-title" data-testid="derived-segments">
      <h2 id="derived-title">Derived segments</h2>
      <p className="muted small">Made from the show/hide rules in your emails. Read only: change a rule in the Emails tab and this list follows.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && data.segments.length === 0 && <p className="muted">No segments yet. Add a rule to a block, for example “Show when Country is UAE”, and the segments it creates appear here.</p>}
      {data && data.segments.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Segment</th><th>Language</th><th>Kind</th><th>Rules</th></tr></thead>
            <tbody>
              {data.segments.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong></td>
                  <td>{languages.find((l) => l.id === s.languageId)?.name ?? s.languageId}</td>
                  <td><span className={`pol ${s.polarity}`}>{s.polarity === 'positive' ? 'Meets a rule' : 'Does not meet it'}</span></td>
                  <td>{s.ruleIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.warnings.map((w, i) => <p key={i} className="error small" role="alert">{languages.find((l) => l.id === w.languageId)?.name}: {w.message}</p>)}
    </section>
  );
}

// ---------------- Audiences ----------------

const showValue = (v: unknown): string => (v === null || v === undefined || v === '' ? 'blank' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

function AudiencesTab({ campaignId, emails, fields, onEmails, onNext }: { campaignId: string; emails: CampaignEmails; fields: ContactField[]; onEmails: () => void; onNext: () => void }) {
  const { data, error } = useDerived(campaignId);
  const label = (k: string) => (fields.find((f) => f.key === k)?.label ?? k).replace(/ \(.*\)$/, '');
  const hidden = ['first_name', 'last_name', 'company', 'email', 'language'];
  const card = (a: TestAudienceDto) => {
    const attrs = Object.entries(a.attributes).filter(([k]) => !hidden.includes(k));
    return (
      <article key={a.id} className="aud-card" data-testid="audience-card">
        <h4>{a.name} <span className={`pol ${a.polarity}`}>{a.polarity === 'baseline' ? 'Baseline' : a.polarity === 'positive' ? 'Shows' : 'Hides'}</span></h4>
        <dl>
          <dt>Values</dt><dd>{attrs.length ? attrs.map(([k, v]) => `${label(k)}: ${showValue(v)}`).join(', ') : 'Language only'}</dd>
          <dt>Blocks</dt><dd>{a.expected.visible.length} shown · {a.expected.hidden.length} hidden</dd>
          <dt>Address</dt><dd className="muted small">{a.email}</dd>
        </dl>
      </article>
    );
  };
  return (
    <div className="audience-pane">
      <section className="seg-panel tint-test" aria-labelledby="aud-title">
        <h2 id="aud-title">Test audiences</h2>
        <p className="muted small">Made-up contacts for trying each email. One baseline per language, plus for every rule one audience that meets it and one that does not, so both the shown and the hidden outcome are tested. They follow the rules automatically, are never real contacts and are never emailed.</p>
        {error && <p className="error" role="alert">{error}</p>}
        {!data && !error && <p>Loading…</p>}
      </section>
      {data && emails.languages.map((l) => {
        const list = data.audiences.filter((a) => a.languageId === l.id);
        return (
          <section key={l.id} className="seg-panel tint-who" aria-label={`${l.name} audiences`} data-testid="language-audiences">
            <h2>{l.name} <span className="muted small">{l.variant ? l.emailName : 'email not created yet'}</span></h2>
            {list.length === 0 ? <p className="muted">No audiences yet.</p> : <div className="audience-grid">{list.map(card)}</div>}
            {!l.variant && <p className="muted small">The baseline audience exists already. Create the email in Segments to get audiences for its rules.</p>}
          </section>
        );
      })}
      <div className="seg-next"><button type="button" onClick={onEmails}>← Back to Emails</button> <button type="button" className="primary" data-testid="next-tab" onClick={onNext}>Next →</button></div>
    </div>
  );
}

// ---------------- Preview ----------------

type Go = (t: TabId, l?: string, extra?: Record<string, string>) => void;

function PreviewTab({ campaignId, emails, lang, aud, rev, go }: { campaignId: string; emails: CampaignEmails; lang: string; aud: string | null; rev: string | null; go: Go }) {
  const { data: derived } = useDerived(campaignId);
  const withEmail = emails.languages.filter((l) => l.variant);
  const current = withEmail.find((l) => l.id === lang) ?? withEmail[0];
  const [revisions, setRevisions] = useState<EmailRevisionSummary[]>([]);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState('');
  const audiences = (derived?.audiences ?? []).filter((a) => a.languageId === current?.id);
  const audienceId = aud ?? (audiences[0] ? `audience:${audiences[0].id}` : 'sample');
  const variantId = current?.variant?.id;
  const desktopStart = Math.max(560, Math.min(980, Math.round(window.innerWidth - 375 - 24 - 72 - 40)));

  useEffect(() => {
    if (!variantId) return;
    api<EmailRevisionSummary[]>('GET', `/api/emails/${variantId}/revisions`).then(setRevisions).catch(() => undefined);
  }, [variantId]);

  useEffect(() => {
    if (!variantId || (derived === null && !aud)) return;
    let live = true;
    (async () => {
      try {
        if (!rev) await flushSave();
        const r = await api<PreviewResponse>('GET', `/api/emails/${variantId}/preview?as=${encodeURIComponent(audienceId)}${rev ? `&revision=${rev}` : ''}`);
        if (live) { setResult(r); setError(''); }
      } catch (e) { if (live) setError(errorText(e)); }
    })();
    return () => { live = false; };
  }, [variantId, audienceId, rev, derived, aud]);

  if (withEmail.length === 0) return <p className="muted">No email has been created yet. Create the English email in Segments first.</p>;
  const set = (patch: { lang?: string; aud?: string | null; rev?: string | null }) => {
    const extra: Record<string, string> = {};
    const nextAud = 'aud' in patch ? patch.aud : patch.lang ? null : aud;
    const nextRev = 'rev' in patch ? patch.rev : patch.lang ? null : rev;
    if (nextAud) extra.aud = nextAud;
    if (nextRev) extra.rev = nextRev;
    go('preview', patch.lang ?? current?.id, extra);
  };
  return (
    <div className="preview-pane">
      <div className="preview-bar">
        <label className="small">Email version{' '}
          <select value={current?.id ?? ''} onChange={(e) => set({ lang: e.target.value, aud: null, rev: null })}>
            {withEmail.map((l) => <option key={l.id} value={l.id}>{l.emailName}</option>)}
          </select>
        </label>
        <label className="small">Test audience{' '}
          <select value={audienceId} onChange={(e) => set({ aud: e.target.value })}>
            <optgroup label={`${current?.name ?? ''} audiences`}>
              {audiences.map((a) => <option key={a.id} value={`audience:${a.id}`}>{a.name}</option>)}
            </optgroup>
            <optgroup label="Built-in examples">{SAMPLE_RECIPIENTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</optgroup>
          </select>
        </label>
        <label className="small">Revision{' '}
          <select value={rev ?? ''} onChange={(e) => set({ rev: e.target.value || null })}>
            <option value="">Current draft</option>
            {revisions.map((r) => <option key={r.id} value={r.id}>Revision {r.number}{r.label ? ` – ${r.label}` : ''}</option>)}
          </select>
        </label>
        <button type="button" className="primary" data-testid="next-tab" style={{ marginLeft: 'auto' }} onClick={() => go('versions', current?.id)}>Next →</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {result && <p className="small" data-testid="previewing-as">Previewing <strong data-testid="shown-version">{result.versionLabel}</strong>{result.recipientLabel ? <> as <strong>{result.recipientLabel}</strong></> : null}</p>}
      <p className="muted small">Browser preview. It is not an Outlook or Gmail simulation: real email apps can render differently.</p>
      {result && result.placeholderIssues.length > 0 && (
        <div className="error" role="alert"><strong>{result.placeholderIssues.length} personalization problem{result.placeholderIssues.length > 1 ? 's' : ''}:</strong>
          <ul>{result.placeholderIssues.map((i, k) => <li key={k}><code>{i.text}</code>: {i.message}</li>)}</ul></div>
      )}
      <div className="preview-devices">
        <DeviceFrame kind="phone" html={result?.html ?? ''} widths={PHONE_WIDTHS} initial={375} />
        <DeviceFrame kind="desktop" html={result?.html ?? ''} widths={DESKTOP_WIDTHS} initial={desktopStart} />
      </div>
      {result?.blocks && (
        <section className="seg-panel tint-map" aria-labelledby="why-title" data-testid="why-panel">
          <h2 id="why-title">Why each block is shown or hidden</h2>
          <div className="table-scroll">
            <table>
              <thead><tr><th>#</th><th>Block</th><th>Result</th><th>Reason</th></tr></thead>
              <tbody>
                {result.blocks.map((b, i) => (
                  <tr key={b.id} data-testid="why-row">
                    <td>{i + 1}</td>
                    <td>{b.label}</td>
                    <td><span className={`pol ${b.visible ? 'positive' : 'negative'}`}>{b.visible ? 'Shown' : 'Hidden'}</span></td>
                    <td>{b.summary}{b.reasons.length > 1 && <div className="muted small">{b.reasons.map((r) => `${r.text}: ${r.met ? 'met' : 'not met'}`).join(' · ')}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------- Versions ----------------

const QA_LABEL: Record<string, string> = { started: 'Started', sent_for_corrections: 'Sent for Corrections', retest: 'Retest', approved: 'Approved', withdrawn: 'Withdrawn' };
const when = (iso: string): string => new Date(iso).toLocaleString();

function VersionsTab({ emails, lang, canEdit, canSubmit, refresh, go }: { emails: CampaignEmails; lang: string; canEdit: boolean; canSubmit: boolean; refresh: () => Promise<void>; go: Go }) {
  const withEmail = emails.languages.filter((l) => l.variant);
  const current = withEmail.find((l) => l.id === lang) ?? withEmail[0];
  const variantId = current?.variant?.id;
  const [revisions, setRevisions] = useState<EmailRevisionSummary[]>([]);
  const [qaRev, setQaRev] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<ReturnType<typeof diffRevisions> | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!variantId) return;
    setRevisions(await api<EmailRevisionSummary[]>('GET', `/api/emails/${variantId}/revisions`));
  }, [variantId]);
  useEffect(() => { setQaRev(''); setDiff(null); setMessage(''); setError(''); load().catch((e) => setError(errorText(e))); }, [load]);
  useEffect(() => { setTo(revisions[0]?.id ?? ''); setFrom(revisions[1]?.id ?? revisions[0]?.id ?? ''); }, [revisions]);

  if (withEmail.length === 0 || !current || !variantId) return <p className="muted">No email has been created yet. Create the English email in Segments first.</p>;
  const latest = revisions[0];
  const chosen = revisions.find((r) => r.id === qaRev) ?? latest;
  const unsaved = current.variant!.unsavedChanges;

  async function send() {
    setError(''); setMessage(''); setBusy(true);
    try {
      const r = await api<QaSubmissionResult>('POST', `/api/emails/${variantId}/qa-submissions`, { ...(qaRev ? { revisionId: qaRev } : {}), requestId: crypto.randomUUID() });
      setMessage(`Revision ${r.revisionNumber} of ${current!.emailName} was sent to QA.`);
      await load(); await refresh();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function saveRevision() {
    setError(''); setBusy(true);
    try { const r = await api<{ number: number }>('POST', `/api/emails/${variantId}/revisions`, {}); setMessage(`Saved as revision ${r.number}.`); await load(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function restore(r: EmailRevisionSummary) {
    if (!window.confirm(`Restore revision ${r.number}? Your current draft is kept in the history and the restore is saved as a new revision.`)) return;
    setError(''); setBusy(true);
    try { await api('POST', `/api/emails/${variantId}/revisions/${r.id}/restore`); setMessage(`Revision ${r.number} restored as a new revision.`); await load(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function compare() {
    setError(''); setDiff(null);
    try {
      const [a, b] = await Promise.all([from, to].map((id) => api<EmailRevisionDetail>('GET', `/api/emails/${variantId}/revisions/${id}`)));
      setDiff(diffRevisions(a!.content as EmailContent, b!.content as EmailContent));
    } catch (e) { setError(errorText(e)); }
  }
  const num = (id: string) => revisions.find((r) => r.id === id)?.number;

  return (
    <div className="audience-pane">
      <div className="lang-bar" role="group" aria-label="Language" style={{ margin: '0 -16px 12px' }}>
        {withEmail.map((l) => (
          <button key={l.id} type="button" className="lang-chip" aria-pressed={current.id === l.id} onClick={() => go('versions', l.id)}>{l.name}</button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="ok" role="status" data-testid="versions-message">{message}</p>}

      <section className="seg-panel tint-who" aria-labelledby="rev-title" data-testid="revision-list">
        <h2 id="rev-title">{current.emailName}</h2>
        <p className="muted small">Each language has its own saved revisions. Your work is saved automatically as a draft; save a revision to mark a point you may want to return to or send to QA.</p>
        {canEdit && <p><button type="button" disabled={busy} onClick={() => void saveRevision()}>Save a revision now</button></p>}
        <div className="table-scroll">
          <table>
            <thead><tr><th>Revision</th><th>Saved</th><th>By</th><th>What</th><th>QA status</th><th></th></tr></thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.id} data-testid="revision-row">
                  <td><strong>Revision {r.number}</strong>{r.id === latest?.id ? <span className="muted small"> — Latest</span> : null}</td>
                  <td>{when(r.createdAt)}</td>
                  <td>{r.createdByName ?? '—'}</td>
                  <td>{r.kind === 'created' ? 'Created' : r.kind === 'clone' ? 'Created from another email' : r.kind === 'restore' ? 'Restored' : r.kind === 'upgrade' ? 'Moved from the previous editor' : 'Saved'}{r.label ? <div className="muted small">{r.label}</div> : null}</td>
                  <td>{r.qaStatus ? <span className="badge">{QA_LABEL[r.qaStatus]}</span> : <span className="muted">Not sent</span>}</td>
                  <td>
                    <button type="button" className="link" aria-label={`Open revision ${r.number}`} onClick={() => go('preview', current.id, { rev: r.id })}>Open</button>
                    {canEdit && <button type="button" className="link" aria-label={`Restore revision ${r.number}`} disabled={busy} onClick={() => void restore(r)}>Restore</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="seg-panel tint-test" aria-labelledby="cmp-title" data-testid="compare-panel">
        <h2 id="cmp-title">Compare revisions</h2>
        {revisions.length < 2 ? <p className="muted">Save another revision to compare.</p> : (
          <>
            <div className="row">
              <div><label htmlFor="cmp-from">From</label><select id="cmp-from" value={from} onChange={(e) => setFrom(e.target.value)}>{revisions.map((r) => <option key={r.id} value={r.id}>Revision {r.number}</option>)}</select></div>
              <div><label htmlFor="cmp-to">To</label><select id="cmp-to" value={to} onChange={(e) => setTo(e.target.value)}>{revisions.map((r) => <option key={r.id} value={r.id}>Revision {r.number}</option>)}</select></div>
              <div style={{ flex: '0 0 auto' }}><button type="button" onClick={() => void compare()}>Compare</button></div>
            </div>
            {diff && (
              <div data-testid="diff">
                <h3>Revision {num(from)} → Revision {num(to)}</h3>
                {diff.same && <p className="muted">No differences.</p>}
                {diff.settings.length > 0 && <ul>{diff.settings.map((s) => <li key={s.key}><strong>{s.key}:</strong> {s.from} → {s.to}</li>)}</ul>}
                {diff.blocks.length > 0 && <ul>{diff.blocks.map((b) => <li key={b.id}><strong>{b.label}</strong> {b.change}{b.details.length ? <ul>{b.details.map((d, i) => <li key={i} className="small">{d}</li>)}</ul> : null}</li>)}</ul>}
              </div>
            )}
          </>
        )}
      </section>

      <section className="seg-panel tint-map" aria-labelledby="qa-title" data-testid="send-to-qa">
        <h2 id="qa-title">Send to QA</h2>
        {!canSubmit && <p className="muted small">Only a Builder can send a revision to QA.</p>}
        <div className="row">
          <div>
            <label htmlFor="qa-rev">Revision to send</label>
            <select id="qa-rev" disabled={!canSubmit || revisions.length === 0} value={qaRev} onChange={(e) => setQaRev(e.target.value)}>
              <option value="">Latest saved revision{latest ? ` (Revision ${latest.number})` : ''}</option>
              {revisions.map((r) => <option key={r.id} value={r.id}>Revision {r.number}{r.qaStatus ? ` – ${QA_LABEL[r.qaStatus]}` : ''}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 auto' }}><button type="button" className="primary" disabled={!canSubmit || busy || !chosen} onClick={() => void send()}>Send to QA</button></div>
        </div>
        {chosen && <p data-testid="qa-will-send"><strong>Revision {chosen.number}</strong> of {current.emailName} will be submitted{qaRev ? '' : ' (the latest saved revision)'}.</p>}
        {unsaved && <p className="error small" role="status" data-testid="unsaved-warning">This email has changes that are not saved in a revision. They will not be sent. {canEdit && <button type="button" className="link" onClick={() => void saveRevision()}>Save them as a new revision first</button>}</p>}
        <p className="muted small">QA reviews exactly this saved revision. Saving a newer revision later does not change what is under review.</p>
      </section>

      <div className="seg-next"><button type="button" className="primary" data-testid="next-tab" onClick={() => go('qa', current.id)}>Next →</button></div>
    </div>
  );
}
