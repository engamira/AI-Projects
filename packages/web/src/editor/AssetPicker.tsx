import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ASSET_FOLDER_NAME_MAX, ASSET_MAX_BYTES, type AssetDto, type AssetFolderDto } from '@cl/shared';
import { api, errorText, upload } from '../api';

const ALL = 'all';
const NONE = 'none';

/** The asset library: folders, upload, move and choose. Used by the picture fields and the Pictures page. */
export function AssetLibrary({ onPick, pickLabel = 'Use this picture' }: { onPick?: (asset: AssetDto) => void; pickLabel?: string }) {
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [folders, setFolders] = useState<AssetFolderDto[]>([]);
  const [view, setView] = useState<string>(ALL); // ALL, NONE or a folder id
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState<string | null>(null); // null = the "new folder" box is closed
  const [renaming, setRenaming] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [a, f] = await Promise.all([api<AssetDto[]>('GET', '/api/assets'), api<AssetFolderDto[]>('GET', '/api/asset-folders')]);
    setAssets(a);
    setFolders(f);
    setView((v) => (v === ALL || v === NONE || f.some((x) => x.id === v) ? v : ALL)); // the open folder may have been deleted
  }, []);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  const current = folders.find((f) => f.id === view);
  const shown = (assets ?? []).filter((a) => view === ALL || (view === NONE ? a.folderId === null : a.folderId === view));
  const noFolderCount = (assets ?? []).filter((a) => a.folderId === null).length;

  async function guarded(fn: () => Promise<void>) {
    setError('');
    try { await fn(); } catch (err) { setError(errorText(err)); }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (file.size > ASSET_MAX_BYTES) return setError(`That picture is larger than ${ASSET_MAX_BYTES / 1048576} MB. Please reduce its size.`);
    setBusy(true);
    try {
      const asset = await upload<AssetDto>(`/api/assets${current ? `?folder=${current.id}` : ''}`, file);
      await load();
      onPick?.(asset);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const createFolder = (e: FormEvent) => {
    e.preventDefault();
    void guarded(async () => {
      const f = await api<AssetFolderDto>('POST', '/api/asset-folders', { name: newName ?? '' });
      setNewName(null);
      await load();
      setView(f.id);
    });
  };
  const rename = (e: FormEvent) => {
    e.preventDefault();
    void guarded(async () => {
      await api('PATCH', `/api/asset-folders/${current!.id}`, { name: renaming ?? '' });
      setRenaming(null);
      await load();
    });
  };
  const removeFolder = () => {
    if (!current) return;
    const n = current.count;
    if (!window.confirm(`Delete the folder "${current.name}"? ${n > 0 ? `Its ${n} picture${n > 1 ? 's' : ''} will not be deleted; they move to "No folder".` : 'It is empty.'}`)) return;
    void guarded(async () => {
      await api('DELETE', `/api/asset-folders/${current.id}`);
      setView(ALL);
      await load();
    });
  };
  const move = (a: AssetDto, to: string) =>
    guarded(async () => {
      await api('PATCH', `/api/assets/${a.id}/folder`, { folderId: to === NONE ? null : to });
      await load();
    });

  return (
    <div className="asset-lib">
      <div className="folder-bar" role="tablist" aria-label="Folders">
        <button type="button" role="tab" aria-selected={view === ALL} className={`folder-chip${view === ALL ? ' active' : ''}`} onClick={() => setView(ALL)}>All pictures <span className="count">{assets?.length ?? 0}</span></button>
        <button type="button" role="tab" aria-selected={view === NONE} className={`folder-chip${view === NONE ? ' active' : ''}`} onClick={() => setView(NONE)}>No folder <span className="count">{noFolderCount}</span></button>
        {folders.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={view === f.id} className={`folder-chip${view === f.id ? ' active' : ''}`} onClick={() => setView(f.id)}>📁 {f.name} <span className="count">{f.count}</span></button>
        ))}
        {newName === null ? (
          <button type="button" className="folder-chip folder-new" onClick={() => setNewName('')}>＋ New folder</button>
        ) : (
          <form className="folder-form" onSubmit={createFolder}>
            <input autoFocus aria-label="New folder name" maxLength={ASSET_FOLDER_NAME_MAX} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Folder name" />
            <button className="primary" disabled={!newName.trim()}>Create</button>
            <button type="button" onClick={() => setNewName(null)}>Cancel</button>
          </form>
        )}
      </div>
      {current && (
        <div className="folder-actions">
          {renaming === null ? (
            <>
              <strong>{current.name}</strong>
              <button type="button" className="link" onClick={() => setRenaming(current.name)}>Rename</button>
              <button type="button" className="link danger" onClick={removeFolder}>Delete folder</button>
            </>
          ) : (
            <form className="folder-form" onSubmit={rename}>
              <input autoFocus aria-label="Folder name" maxLength={ASSET_FOLDER_NAME_MAX} value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              <button className="primary" disabled={!renaming.trim()}>Save</button>
              <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          )}
        </div>
      )}
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ flex: '0 0 auto' }}>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={onFile} hidden aria-label="Choose a picture file" />
          <button type="button" className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Uploading…' : current ? `Upload to ${current.name}` : 'Upload a picture'}</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>PNG, JPG, GIF or WebP, up to {ASSET_MAX_BYTES / 1048576} MB. For logos, crop tightly around the artwork.</p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {assets && shown.length === 0 && <p className="muted">{assets.length === 0 ? 'No pictures yet. Upload your first one.' : view === ALL ? 'No pictures.' : 'No pictures here yet. Upload one, or use the Folder menu on a picture elsewhere.'}</p>}
      <ul className="asset-grid">
        {shown.map((a) => (
          <li key={a.id}>
            <div className="asset-thumb"><img src={`/media/${a.id}`} alt={a.filename} loading="lazy" /></div>
            <div className="asset-name" title={a.filename}>{a.filename}</div>
            <div className="muted small">{a.width}×{a.height} · {Math.max(1, Math.round(a.sizeBytes / 1024))} KB</div>
            <label className="asset-move small">Folder
              <select aria-label={`Folder for ${a.filename}`} value={a.folderId ?? NONE} onChange={(e) => void move(a, e.target.value)}>
                <option value={NONE}>No folder</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            {onPick && <button type="button" onClick={() => onPick(a)}>{pickLabel}</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AssetPickerDialog({ onClose, onPick }: { onClose: () => void; onPick: (ref: string) => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Choose a picture">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Choose a picture</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <AssetLibrary onPick={(a) => { onPick(`asset:${a.id}`); onClose(); }} />
      </div>
    </div>
  );
}
