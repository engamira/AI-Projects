import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PALETTES, PALETTE_IDS, campaignStatus, type CampaignDto, type CampaignSummary, type PaletteId } from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';

export function CampaignsPage() {
  const { can, me } = useSession();
  const nav = useNavigate();
  const [list, setList] = useState<CampaignSummary[] | null>(null);
  const [name, setName] = useState('');
  const [palette, setPalette] = useState<PaletteId>('travel');
  const [starter, setStarter] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => setList(await api<CampaignSummary[]>('GET', '/api/campaigns')), []);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const c = await api<CampaignDto>('POST', '/api/campaigns', { name, palette, starter });
      nav(`/campaigns/${c.id}`);
    } catch (err) { setError(errorText(err)); }
  }
  async function duplicate(id: string) {
    setError('');
    try {
      const c = await api<CampaignDto>('POST', `/api/campaigns/${id}/duplicate`);
      nav(`/campaigns/${c.id}`);
    } catch (err) { setError(errorText(err)); }
  }

  async function remove(c: CampaignSummary) {
    if (!window.confirm(`Delete "${c.name}" and its ${c.revisionCount} saved version(s)? This cannot be undone.`)) return;
    setError('');
    try {
      await api('DELETE', `/api/campaigns/${c.id}`);
      await load();
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <>
      <h1>Campaigns</h1>
      <p className="muted">Signed in as {me?.user?.name}.</p>
      {can('campaign.edit') && (
        <div className="card wide">
          <h2 style={{ marginTop: 0 }}>New campaign</h2>
          <form onSubmit={create} className="row">
            <div><label htmlFor="cname">Campaign name</label><input id="cname" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Summer fares newsletter" /></div>
            <div>
              <label htmlFor="cpalette">Template colors</label>
              <select id="cpalette" value={palette} onChange={(e) => setPalette(e.target.value as PaletteId)}>
                {PALETTE_IDS.map((id) => <option key={id} value={id}>{PALETTES[id].label}</option>)}
              </select>
            </div>
            <div style={{ flex: '0 0 auto' }}><button className="primary">Create and open</button></div>
          </form>
          <label className="check-inline"><input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} /> Start from the ready-made {PALETTES[palette].label} layout</label>
          <p className="muted small" style={{ marginBottom: 0 }}>Colors are set by the template you choose and cannot be changed later. Every block in a starter layout is your own copy to edit, replace or delete.</p>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <h2>All campaigns</h2>
      {list && list.length === 0 && <p className="muted">No campaigns yet.</p>}
      {list && list.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Versions</th><th>Created by</th><th>Last changed</th><th>Actions</th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/campaigns/${c.id}`}>{c.name}</Link></td>
                  <td><span className={`badge status-${campaignStatus(c.status).tone}`} title={campaignStatus(c.status).hint}>{campaignStatus(c.status).label}</span></td>
                  <td>{c.revisionCount}</td>
                  <td>{c.createdByName ?? '—'}</td>
                  <td>{new Date(c.updatedAt).toLocaleString()}</td>
                  <td>
                    <Link to={`/campaigns/${c.id}`}>{can('campaign.edit') ? 'Open' : 'View'}</Link>
                    {can('campaign.edit') && <button className="link" onClick={() => void duplicate(c.id)}>Duplicate</button>}
                    {can('campaign.delete') && campaignStatus(c.status).deletable && <button className="link danger" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
