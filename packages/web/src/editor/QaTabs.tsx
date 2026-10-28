import { useCallback, useEffect, useState } from 'react';
import {
  QA_STATUS_LABELS, SEVERITY_LABELS, isBlocking,
  type CampaignEmails, type CorrectionDto, type QaIssueDto, type QaSubmissionDto, type QaVariantOverview,
} from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';

// The QA tab (reviewer) and the Builder to Check tab (builder) of one email.

type Go = (t: 'segments' | 'emails' | 'audiences' | 'preview' | 'versions' | 'qa' | 'check', l?: string, extra?: Record<string, string>) => void;
type Sub = { submission: QaSubmissionDto; issues: QaIssueDto[] };

const STATUS_CLASS: Record<string, string> = { approved: 'positive', sent_for_corrections: 'negative', retest: 'baseline', started: 'baseline', not_submitted: 'baseline' };
export const StatusBadge = ({ status }: { status: QaVariantOverview['status'] }) => <span className={`pol ${STATUS_CLASS[status]}`} data-testid="qa-status">{QA_STATUS_LABELS[status]}</span>;
const ISSUE_STATUS: Record<string, string> = { open: 'Open', sent_for_correction: 'Sent for correction', retest: 'Waiting for retest', resolved: 'Resolved', ignored: 'Ignored' };
const SOURCE: Record<string, string> = { deterministic: 'Automatic check', ai: 'AI suggestion' };

// ---------------- QA ----------------

export function QaTab({ campaignId, emails, lang, go }: { campaignId: string; emails: CampaignEmails; lang: string; go: Go }) {
  const { can } = useSession();
  const [rows, setRows] = useState<QaVariantOverview[] | null>(null);
  const [detail, setDetail] = useState<Sub | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const current = rows?.find((r) => r.languageId === lang && r.submission) ?? rows?.find((r) => r.submission);

  const load = useCallback(async () => {
    const list = await api<QaVariantOverview[]>('GET', `/api/campaigns/${campaignId}/qa`);
    setRows(list);
    return list;
  }, [campaignId]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);
  const submissionId = current?.submission?.id;
  useEffect(() => {
    if (!submissionId) { setDetail(null); return; }
    api<Sub>('GET', `/api/qa-submissions/${submissionId}`).then(setDetail).catch((e) => setError(errorText(e)));
  }, [submissionId]);

  async function act(fn: () => Promise<Sub | QaIssueDto | unknown>, ok?: string) {
    setError(''); setMessage(''); setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'submission' in r) setDetail(r as Sub);
      else if (submissionId) setDetail(await api<Sub>('GET', `/api/qa-submissions/${submissionId}`));
      await load();
      if (ok) setMessage(ok);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  if (!rows) return <p>{error || 'Loading…'}</p>;
  const sub = detail?.submission;
  const issues = detail?.issues ?? [];
  const blocking = issues.filter(isBlocking);
  const approved = !!sub?.approval;
  return (
    <div className="audience-pane">
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="ok" role="status" data-testid="qa-message">{message}</p>}
      <section className="seg-panel tint-who" aria-labelledby="qa-all-title">
        <h2 id="qa-all-title">Emails in QA</h2>
        <p className="muted small">Every language email with the state of its newest submission. The state is worked out from its findings and approval.</p>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Email</th><th>Revision under review</th><th>Status</th><th>Open findings</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.variantId} data-testid="qa-row">
                  <td><strong>{r.emailName}</strong></td>
                  <td>{r.submission ? <>Revision {r.submission.revisionNumber}{r.newerRevisionExists ? <div className="muted small">Revision {r.latestRevision} exists, not under review</div> : null}</> : <span className="muted">Not sent to QA</span>}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.submission ? `${r.openIssues} (${r.blockingIssues} blocking)` : '—'}</td>
                  <td>{r.submission && <button type="button" className="link" aria-label={`Review ${r.emailName}`} onClick={() => go('qa', r.languageId)}>Review</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.every((r) => !r.submission) && <p className="muted">Nothing has been sent to QA yet. A Builder sends a saved revision from the Versions tab.</p>}
      </section>

      {current && sub && (
        <section className="seg-panel tint-map" aria-labelledby="qa-review-title" data-testid="qa-review">
          <h2 id="qa-review-title">{current.emailName} · Revision {sub.revisionNumber} <StatusBadge status={current.status} /></h2>
          <p className="muted small">Sent by {sub.submittedByName ?? '—'} on {new Date(sub.createdAt).toLocaleString()}. QA reviews exactly this saved revision{current.newerRevisionExists ? `; revision ${current.latestRevision} was saved since and is not part of this review` : ''}.</p>
          {sub.approval && <p className="ok" role="status">Approved by {sub.approval.reviewerName ?? '—'} on {new Date(sub.approval.approvedAt).toLocaleString()}. This approval applies to revision {sub.revisionNumber} only.</p>}
          <div className="row">
            {can('qa.review') && <div style={{ flex: '0 0 auto' }}><button type="button" className="primary" disabled={busy || approved} onClick={() => void act(() => api('POST', `/api/qa-submissions/${sub.id}/runs`, {}), 'QA checks finished.')}>Run QA checks</button></div>}
            {can('qa.approve') && <div style={{ flex: '0 0 auto' }}><button type="button" disabled={busy || approved || sub.runs.length === 0 || blocking.length > 0} title={sub.runs.length === 0 ? 'Run the QA checks first' : blocking.length ? 'Resolve or ignore the high and critical findings first' : undefined} onClick={() => void act(() => api('POST', `/api/qa-submissions/${sub.id}/approve`, {}), `Revision ${sub.revisionNumber} approved.`)}>Approve revision {sub.revisionNumber}</button></div>}
          </div>
          {!can('qa.review') && <p className="muted small">Only a QA reviewer can run the checks and review findings.</p>}
          {sub.runs[0] && (
            <details>
              <summary>What the checks covered ({sub.runs.length} run{sub.runs.length === 1 ? '' : 's'})</summary>
              <p className="small"><strong>Checked:</strong> {sub.runs[0].coverage.ran.join(', ')}.</p>
              <p className="small"><strong>Not covered:</strong></p>
              <ul className="small">{sub.runs[0].coverage.notRun.map((n) => <li key={n}>{n}</li>)}</ul>
              <p className="muted small">Automatic checks find many problems but not all of them. A review by a person is still needed.</p>
            </details>
          )}
          {sub.runs.length === 0 && <p className="muted">No checks have been run on this revision yet.</p>}
          {blocking.length > 0 && <p className="error small" role="status">{blocking.length} high or critical finding{blocking.length === 1 ? '' : 's'} must be resolved or ignored before approval.</p>}
          {issues.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead><tr><th>ID</th><th>Severity</th><th>Finding</th><th>Status</th><th>Review</th></tr></thead>
                <tbody>{issues.map((i) => <IssueRow key={i.id} issue={i} busy={busy} locked={approved} act={act} go={go} lang={current.languageId} />)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {!current && rows.some((r) => r.submission) === false && emails.languages.length > 0 && null}
    </div>
  );
}

function IssueRow({ issue, busy, locked, act, go, lang }: { issue: QaIssueDto; busy: boolean; locked: boolean; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; go: Go; lang: string }) {
  const { can } = useSession();
  const [comment, setComment] = useState(issue.reviewerComment ?? '');
  const [ignoring, setIgnoring] = useState(false);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'once' | 'project' | 'global'>('once');
  const [whole, setWhole] = useState(false);
  const done = issue.status === 'resolved' || issue.status === 'ignored';
  const review = can('qa.review') && !locked;
  const evidence = Object.entries(issue.evidence).filter(([, v]) => v !== '' && v !== null).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
  return (
    <tr data-testid="issue-row" data-check={issue.checkId}>
      <td><strong>{issue.label}</strong><div className="muted small">{issue.revisionNumber ? `${issue.languageName} · rev ${issue.revisionNumber}` : ''}</div></td>
      <td><span className={`pol ${issue.severity === 'low' ? 'baseline' : issue.severity === 'medium' ? 'baseline' : 'negative'}`}>{SEVERITY_LABELS[issue.severity]}</span><div className="muted small">{issue.category}</div></td>
      <td>
        <strong>{issue.title}</strong> <span className="badge">{SOURCE[issue.source]}</span>
        <div className="small">{issue.description}</div>
        {evidence && <div className="muted small">Evidence — {evidence}</div>}
        {issue.blockId && <button type="button" className="link" onClick={() => go('emails', lang, { block: issue.blockId! })}>Open the block</button>}
        {issue.reviewerComment && !review && <div className="small">QA: {issue.reviewerComment}</div>}
        {issue.ignoredReason && <div className="muted small">Ignored: {issue.ignoredReason}</div>}
      </td>
      <td>{ISSUE_STATUS[issue.status]}</td>
      <td>
        {review && !done && (
          <>
            <textarea aria-label={`Comment for ${issue.label}`} rows={2} value={comment} placeholder="Optional comment for the builder" onChange={(e) => setComment(e.target.value)} />
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="link" disabled={busy} onClick={() => void act(() => api('PATCH', `/api/qa-issues/${issue.id}`, { comment }))}>Save comment</button>
              <button type="button" disabled={busy} onClick={() => void act(() => api('POST', `/api/qa-issues/${issue.id}/send-for-correction`, { comment }), `${issue.label} sent for correction.`)}>Send for Correction</button>
              <button type="button" className="link" disabled={busy} onClick={() => setIgnoring((v) => !v)}>Ignore…</button>
            </div>
            {ignoring && (
              <div className="ignore-box">
                <label>Why ignore it?<input aria-label={`Reason to ignore ${issue.label}`} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                <label>For<select aria-label={`Ignore scope for ${issue.label}`} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                  <option value="once">This finding only</option>
                  <option value="project">This email, every time it appears</option>
                  {can('qa.suppress_global') && <option value="global">Every email (creates a rule in App Settings)</option>}
                </select></label>
                {scope !== 'once' && <label className="check"><input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /><span>Hide this whole kind of finding ({issue.checkId}), not only this exact one</span></label>}
                <button type="button" className="primary" disabled={busy || reason.trim().length < 3} onClick={() => void act(() => api('POST', `/api/qa-issues/${issue.id}/ignore`, { reason, scope, wholeCheck: scope !== 'once' && whole }), `${issue.label} ignored.`)}>Ignore</button>
              </div>
            )}
          </>
        )}
        {(done || !review) && issue.reviewerComment && review && <div className="small">QA: {issue.reviewerComment}</div>}
      </td>
    </tr>
  );
}

// ---------------- Builder to Check ----------------

export function CheckTab({ campaignId, go }: { campaignId: string; emails: CampaignEmails; go: Go }) {
  const { can } = useSession();
  const [items, setItems] = useState<CorrectionDto[] | null>(null);
  const [rows, setRows] = useState<QaVariantOverview[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setItems(await api<CorrectionDto[]>('GET', `/api/campaigns/${campaignId}/corrections`));
    setRows(await api<QaVariantOverview[]>('GET', `/api/campaigns/${campaignId}/qa`));
  }, [campaignId]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  async function retest(variantId: string, emailName: string) {
    setError(''); setMessage(''); setBusy(true);
    try {
      const r = await api<{ revisionNumber: number; items: number }>('POST', `/api/emails/${variantId}/retest`, {});
      setMessage(`${emailName} revision ${r.revisionNumber} was sent back to QA for a retest (${r.items} correction${r.items === 1 ? '' : 's'}). It is not approved until QA approves it.`);
      await load();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (!items) return <p>{error || 'Loading…'}</p>;
  return (
    <div className="audience-pane">
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="ok" role="status" data-testid="check-message">{message}</p>}
      <section className="seg-panel tint-test" aria-labelledby="check-title">
        <h2 id="check-title">Waiting for you</h2>
        <p className="muted small">Findings QA sent back. Fix them in the Emails tab, save a new revision, then ask for a retest. A retest sends the new revision back to QA; it is never approved automatically.</p>
        {items.length === 0 && <p className="muted" data-testid="check-empty">Nothing is waiting for you.</p>}
        {items.map((c) => (
          <article key={c.id} className="aud-card" data-testid="correction" style={{ marginBottom: 10 }}>
            <h4>{c.issue.label} · {c.emailName} · revision {c.originalRevisionNumber} <span className={`pol ${c.issue.severity === 'low' || c.issue.severity === 'medium' ? 'baseline' : 'negative'}`}>{SEVERITY_LABELS[c.issue.severity]}</span> <span className="badge">{c.status === 'pending' ? 'To fix' : 'Retest requested'}</span></h4>
            <p style={{ margin: '4px 0' }}><strong>{c.issue.title}</strong></p>
            <p className="small" style={{ margin: '4px 0' }}>{c.originalDescription}</p>
            {c.qaNote && <p className="small" style={{ margin: '4px 0' }}><strong>QA says:</strong> {c.qaNote}</p>}
            <div className="row" style={{ gap: 8 }}>
              {c.issue.blockId && <button type="button" className="link" onClick={() => go('emails', c.issue.languageId, { block: c.issue.blockId! })}>Open the block</button>}
              <button type="button" disabled title="Only a QA reviewer can ignore a finding" aria-label={`Ignore ${c.issue.label}`}>Ignore</button>
              {can('campaign.submit') && c.status === 'pending' && <button type="button" className="primary" disabled={busy} aria-label={`Retest ${c.issue.label}`} onClick={() => void retest(c.variantId, c.emailName)}>Retest</button>}
            </div>
          </article>
        ))}
      </section>
      <section className="seg-panel tint-map" aria-labelledby="check-status-title">
        <h2 id="check-status-title">Where each email stands</h2>
        <div className="table-scroll"><table>
          <thead><tr><th>Email</th><th>Revision</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.variantId}><td><strong>{r.emailName}</strong></td><td>{r.submission ? `Revision ${r.submission.revisionNumber}` : '—'}</td><td><StatusBadge status={r.status} /></td></tr>)}</tbody>
        </table></div>
      </section>
    </div>
  );
}
