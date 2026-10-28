import { useCallback, useEffect, useState } from 'react';
import type { LanguageDto, SuppressionRuleDto } from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';

// App Settings: the rules that hide findings in QA (reviewable, reversible, recorded) and the language registry.

export function SettingsPage() {
  const { can } = useSession();
  const [rules, setRules] = useState<SuppressionRuleDto[] | null>(null);
  const [languages, setLanguages] = useState<LanguageDto[]>([]);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const canSee = can('qa.review') || can('rules.manage');

  const load = useCallback(async () => {
    if (canSee) setRules(await api<SuppressionRuleDto[]>('GET', '/api/suppression-rules'));
    setLanguages(await api<LanguageDto[]>('GET', '/api/languages'));
  }, [canSee]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  async function revoke(r: SuppressionRuleDto) {
    setError('');
    try { setRules(await api<SuppressionRuleDto[]>('POST', `/api/suppression-rules/${r.id}/revoke`, { reason: reasons[r.id] ?? '' })); } catch (e) { setError(errorText(e)); }
  }
  const mayRevoke = (r: SuppressionRuleDto) => !r.revokedAt && (r.scope === 'global' ? can('qa.suppress_global') || can('rules.manage') : can('qa.review') || can('rules.manage'));

  return (
    <>
      <h1>App Settings</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {canSee && (
        <section className="seg-panel tint-test" aria-labelledby="supp-title" data-testid="suppression-rules">
          <h2 id="supp-title">Hidden QA findings</h2>
          <p className="muted small">When a QA reviewer ignores a finding for good, a rule is made. Each rule hides one exact finding, or one kind of finding, and nothing else. Rules are never deleted: revoke one and the findings it hid come back. Every change is in the activity history.</p>
          {rules && rules.length === 0 && <p className="muted">No rules yet.</p>}
          {rules && rules.length > 0 && (
            <div className="table-scroll"><table>
              <thead><tr><th>Rule</th><th>Applies to</th><th>Reason</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} data-testid="suppression-row" className={r.revokedAt ? 'muted' : undefined}>
                    <td>{r.description}<div className="muted small">{r.checkId}</div></td>
                    <td>{r.scope === 'global' ? 'Every email' : `Email “${r.campaignName ?? ''}”`}</td>
                    <td>{r.reason}</td>
                    <td>{r.createdByName ?? '—'}<div className="muted small">{new Date(r.createdAt).toLocaleString()}</div></td>
                    <td>
                      {r.revokedAt
                        ? <span>Revoked by {r.revokedByName ?? '—'}<div className="muted small">{r.revokeReason}</div></span>
                        : mayRevoke(r) && (
                          <span className="row" style={{ gap: 6 }}>
                            <input aria-label={`Reason to revoke ${r.description}`} placeholder="Why revoke?" value={reasons[r.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })} />
                            <button type="button" disabled={(reasons[r.id] ?? '').trim().length < 3} onClick={() => void revoke(r)}>Revoke</button>
                          </span>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      )}
      <section className="seg-panel tint-who" aria-labelledby="lang-reg-title">
        <h2 id="lang-reg-title">Languages</h2>
        <p className="muted small">The languages an email can be written in. {languages.length} languages; English is the master email.</p>
        <div className="table-scroll"><table>
          <thead><tr><th>Language</th><th>Locale</th><th>Writing direction</th></tr></thead>
          <tbody>{languages.map((l) => <tr key={l.id}><td><strong>{l.name}</strong> <span className="muted small">{l.nativeName}</span></td><td>{l.locale}</td><td>{l.direction === 'rtl' ? 'Right to left' : 'Left to right'}</td></tr>)}</tbody>
        </table></div>
      </section>
    </>
  );
}
