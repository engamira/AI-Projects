import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ASSET_MAX_BYTES, type AssetDto } from '@cl/shared';
import { api, errorText, upload } from '../api';

/** The asset library: upload pictures and choose one. Used by the picture fields and the Assets page. */
export function AssetLibrary({ onPick, pickLabel = 'Use this picture' }: { onPick?: (asset: AssetDto) => void; pickLabel?: string }) {
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => setAssets(await api<AssetDto[]>('GET', '/api/assets')), []);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (file.size > ASSET_MAX_BYTES) return setError(`That picture is larger than ${ASSET_MAX_BYTES / 1048576} MB. Please reduce its size.`);
    setBusy(true);
    try {
      const asset = await upload<AssetDto>('/api/assets', file);
      await load();
      onPick?.(asset);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="asset-lib">
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ flex: '0 0 auto' }}>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={onFile} hidden aria-label="Choose a picture file" />
          <button type="button" className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Uploading…' : 'Upload a picture'}</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>PNG, JPG, GIF or WebP, up to {ASSET_MAX_BYTES / 1048576} MB. For logos, crop tightly around the artwork.</p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {assets && assets.length === 0 && <p className="muted">No pictures yet. Upload your first one.</p>}
      <ul className="asset-grid">
        {assets?.map((a) => (
          <li key={a.id}>
            <div className="asset-thumb"><img src={`/media/${a.id}`} alt={a.filename} loading="lazy" /></div>
            <div className="asset-name" title={a.filename}>{a.filename}</div>
            <div className="muted small">{a.width}×{a.height} · {Math.max(1, Math.round(a.sizeBytes / 1024))} KB</div>
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
