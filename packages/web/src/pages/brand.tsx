import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BRAND_FOOTER_FIELDS,
  BRAND_HEADER_FIELDS,
  PALETTES,
  PALETTE_IDS,
  paletteOf,
  type BlockInstance,
  type BrandProfileDto,
  type BrandResponse,
  type BrandVersionDto,
  type EmailSettings,
  type PaletteId,
  type Props,
  type PropValue,
  defaultSettings,
} from '@cl/shared';
import { api, errorText } from '../api';
import { BlockView } from '../editor/BlockView';
import { FieldForm } from '../editor/Fields';
import { AssetLibrary } from '../editor/AssetPicker';
import { refreshBrand } from '../editor/useBrand';

export function BrandPage() {
  const [profiles, setProfiles] = useState<Record<PaletteId, BrandProfileDto> | null>(null);
  const [palette, setPalette] = useState<PaletteId>('travel');
  const [header, setHeader] = useState<Props>({});
  const [footer, setFooter] = useState<Props>({});
  const [versions, setVersions] = useState<BrandVersionDto[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (target: PaletteId) => {
    const r = await api<BrandResponse>('GET', '/api/brand');
    setProfiles(r.profiles);
    setHeader(r.profiles[target].header);
    setFooter(r.profiles[target].footer);
    setVersions(await api<BrandVersionDto[]>('GET', `/api/brand/${target}/versions`));
  }, []);
  useEffect(() => { load(palette).catch((e) => setMsg({ ok: false, text: errorText(e) })); }, [load, palette]);

  const profile = profiles?.[palette];
  const dirty = useMemo(() => !!profile && JSON.stringify([profile.header, profile.footer]) !== JSON.stringify([header, footer]), [profile, header, footer]);
  const settings: EmailSettings = { ...defaultSettings(palette) };
  const c = paletteOf(palette);

  async function save() {
    if (!profile) return;
    setSaving(true);
    setMsg(null);
    try {
      await api('PUT', `/api/brand/${palette}`, { header, footer, baseVersion: profile.version });
      await load(palette);
      await refreshBrand();
      setMsg({ ok: true, text: 'Saved as a new version. Draft emails of this template now use it.' });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  function switchTo(next: PaletteId) {
    if (dirty && !confirm('You have unsaved changes to this header and footer. Discard them?')) return;
    setMsg(null);
    // Show the chosen template's values straight away, so the form never shows (or saves) another template's text.
    if (profiles) {
      setHeader(profiles[next].header);
      setFooter(profiles[next].footer);
    }
    setPalette(next);
  }

  const fake = (type: 'header' | 'footer', props: Props) => ({ id: `brand-${type}`, type, sourceVersion: 0, props }) as unknown as BlockInstance;

  return (
    <>
      <h1>Brand settings</h1>
      <p className="muted">Each template has its own shared header and footer. Every email of that template shows them automatically, and Builders cannot change them inside an email. Colors come from the template.</p>

      <div role="tablist" className="tabs brand-tabs" aria-label="Template">
        {PALETTE_IDS.map((id) => (
          <button key={id} role="tab" aria-selected={palette === id} className={palette === id ? 'active' : ''} onClick={() => switchTo(id)}>{PALETTES[id].label}</button>
        ))}
      </div>

      {profile && (
        <div className="brand-grid">
          <div>
            <h2>Header</h2>
            <FieldForm fields={BRAND_HEADER_FIELDS} values={header as Record<string, PropValue>} onChange={(k, v) => setHeader({ ...header, [k]: v })} />
            <h2>Footer</h2>
            <FieldForm fields={BRAND_FOOTER_FIELDS} values={footer as Record<string, PropValue>} onChange={(k, v) => setFooter({ ...footer, [k]: v })} />
            <p>
              <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save as a new version'}</button>{' '}
              <button disabled={!dirty || saving} onClick={() => { setHeader(profile.header); setFooter(profile.footer); setMsg(null); }}>Discard changes</button>
            </p>
            {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
          </div>

          <div>
            <h2>How it looks</h2>
            <p className="muted small">Template colors: <strong>{c.label}</strong>. This is the header and footer every {c.label} email shows.</p>
            <div className="brand-preview" style={{ background: c.page, padding: 12 }}>
              <div style={{ maxWidth: 600, margin: '0 auto', background: c.surface }}>
                <BlockView block={fake('header', header)} settings={settings} />
                <div style={{ padding: '28px 24px', color: c.muted, textAlign: 'center', fontSize: 14 }}>…the content of each email goes here…</div>
                <BlockView block={fake('footer', footer)} settings={settings} />
              </div>
            </div>
            <h2>Version history</h2>
            <ul className="plain">
              {versions.map((v) => <li key={v.version}>Version {v.version}: {new Date(v.updatedAt).toLocaleString()} {v.updatedByName ? `by ${v.updatedByName}` : '(starting version)'}</li>)}
            </ul>
            <p className="muted small">To set the logo, press “Choose or upload a picture” in the header. All uploaded pictures are on the Pictures page.</p>
          </div>
        </div>
      )}
    </>
  );
}

export function AssetsPage() {
  return (
    <>
      <h1>Pictures</h1>
      <p className="muted">The asset library. Pictures uploaded here can be used in any email and in the shared headers. The same picture is only stored once.</p>
      <AssetLibrary />
    </>
  );
}
