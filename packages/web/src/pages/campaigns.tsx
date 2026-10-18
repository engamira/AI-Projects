import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PALETTES, PALETTE_IDS, type CampaignDto, type CampaignSummary, type PaletteId } from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';

export function CampaignsPage() {
  const { can, me } = useSession();
  const nav = useNavigate();
  const [list, setList] = useState<CampaignSummary[] | null>(null);
  const [name, setName] = useState('');
  const [palette, setPalette] = useState<PaletteId>('travel');
  const [error, setError] = useState('');

  const load = useCallback(async () => setList(await api<CampaignSummary[]>('GET', '/api/campaigns')), []);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const c = await api<CampaignDto>('POST', '/api/campaigns', { name, palette });
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
          <p className="muted small" style={{ marginBottom: 0 }}>Colors are set by the template you choose and cannot be changed later. Ready-made starter layouts for each template arrive in the next milestone.</p>
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
                  <td><span className="badge">{c.status}</span></td>
                  <td>{c.revisionCount}</td>
                  <td>{c.createdByName ?? '—'}</td>
                  <td>{new Date(c.updatedAt).toLocaleString()}</td>
                  <td>
                    <Link to={`/campaigns/${c.id}`}>{can('campaign.edit') ? 'Open' : 'View'}</Link>
                    {can('campaign.edit') && <button className="link" onClick={() => void duplicate(c.id)}>Duplicate</button>}
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
