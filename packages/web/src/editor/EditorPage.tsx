import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  SETTINGS_FIELDS,
  blockDefinition,
  paletteOf,
  type BlockDefinition,
  type BlockInstance,
  type BrandProfileDto,
  type CampaignDto,
  type EmailSettings,
  type LibraryResponse,
  type PreviewResponse,
  type PropValue,
  type RevisionDto,
} from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';
import { BlockView } from './BlockView';
import { FieldForm } from './Fields';
import { flushSave, useEditor } from './store';
import { useBrand } from './useBrand';

let libraryCache: BlockDefinition[] | null = null;
function useLibrary(): BlockDefinition[] {
  const [defs, setDefs] = useState<BlockDefinition[]>(libraryCache ?? []);
  useEffect(() => {
    if (libraryCache) return;
    api<LibraryResponse>('GET', '/api/library/blocks').then((r) => {
      libraryCache = r.blocks;
      setDefs(r.blocks);
    });
  }, []);
  return defs;
}

// ---------- Library (originals) ----------
function LibraryItem({ def, canEdit }: { def: BlockDefinition; canEdit: boolean }) {
  const addBlock = useEditor((s) => s.addBlock);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `lib:${def.type}`, disabled: !canEdit });
  return (
    <li ref={setNodeRef} className={`lib-item ${isDragging ? 'dragging' : ''}`}>
      <button className="handle" type="button" aria-label={`Drag ${def.label} into the email`} disabled={!canEdit} {...attributes} {...listeners}>⠿</button>
      <div className="lib-text">
        <strong>{def.label}</strong>
        <div className="muted small">{def.description}</div>
      </div>
      <button type="button" disabled={!canEdit} aria-label={`Add ${def.label} to the end of the email`} onClick={() => addBlock(def)}>Add</button>
    </li>
  );
}

// ---------- Canvas ----------
function SortableBlock({ block, index, total, canEdit }: { block: BlockInstance; index: number; total: number; canEdit: boolean }) {
  const { content, selectedId, select, moveBlock, duplicateBlock, deleteBlock } = useEditor();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: !canEdit });
  const def = blockDefinition(block.type);
  const selected = selectedId === block.id;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className={`canvas-block ${selected ? 'selected' : ''}`}
      data-block-type={block.type}
      onClick={(e) => { e.stopPropagation(); select(block.id); }}
    >
      <div className="block-bar" onClick={(e) => e.stopPropagation()}>
        <span className="block-label">{def?.label ?? block.type}</span>
        {canEdit && (
          <span className="block-tools">
            <button type="button" className="handle" aria-label={`Drag ${def?.label} to reorder`} {...attributes} {...listeners}>⠿</button>
            <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => moveBlock(index, index - 1)}>↑</button>
            <button type="button" aria-label="Move down" disabled={index === total - 1} onClick={() => moveBlock(index, index + 1)}>↓</button>
            <button type="button" aria-label="Duplicate block" onClick={() => duplicateBlock(block.id)}>⧉</button>
            <button type="button" aria-label="Delete block" className="danger" onClick={() => deleteBlock(block.id)}>🗑</button>
          </span>
        )}
      </div>
      <div className="block-body"><BlockView block={block} settings={content.settings} /></div>
    </div>
  );
}

function Canvas({ canEdit }: { canEdit: boolean }) {
  const { content, select } = useEditor();
  const { setNodeRef, isOver } = useDroppable({ id: 'canvas-end' });
  const st = content.settings;
  const pal = paletteOf(st.palette);
  const brand = useBrand();
  const profile = brand?.[st.palette];
  return (
    <div className="canvas-scroll" onClick={() => select(null)}>
      <div className="canvas-page" style={{ background: pal.page, padding: 16 }}>
        <div style={{ maxWidth: st.contentWidth, margin: '0 auto', background: pal.surface, fontFamily: st.fontFamily }} data-testid="canvas">
          {profile && <BrandBlock kind="header" profile={profile} settings={st} />}
          <SortableContext items={content.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {content.blocks.map((b, i) => <SortableBlock key={b.id} block={b} index={i} total={content.blocks.length} canEdit={canEdit} />)}
          </SortableContext>
          <div ref={setNodeRef} className={`drop-end ${isOver ? 'over' : ''}`}>
            {content.blocks.length === 0 ? (canEdit ? 'Drag a block here, or press “Add” on a block in the list.' : 'This email has no blocks yet.') : canEdit ? 'Drop here to add at the end' : ''}
          </div>
          {profile && <BrandBlock kind="footer" profile={profile} settings={st} />}
        </div>
      </div>
    </div>
  );
}

/** The shared header or footer of the template: shown in place, but locked inside a campaign. */
function BrandBlock({ kind, profile, settings }: { kind: 'header' | 'footer'; profile: BrandProfileDto; settings: EmailSettings }) {
  const { can } = useSession();
  const block = { id: `brand-${kind}`, type: kind, sourceVersion: profile.version, props: profile[kind] } as unknown as BlockInstance;
  return (
    <div className="canvas-block brand-block" data-brand={kind} onClick={(e) => e.stopPropagation()}>
      <div className="block-bar" style={{ display: 'flex' }}>
        <span className="block-label">Shared {kind} of the {paletteOf(settings.palette).label} template (locked)</span>
        {can('brand.manage') && <Link to="/admin/brand" style={{ color: 'inherit' }}>Edit in Brand settings</Link>}
      </div>
      <div className="block-body"><BlockView block={block} settings={settings} /></div>
    </div>
  );
}

// ---------- Properties ----------
function Properties({ canEdit }: { canEdit: boolean }) {
  const { content, selectedId, setProp, setSetting } = useEditor();
  const block = content.blocks.find((b) => b.id === selectedId);
  const def = block ? blockDefinition(block.type) : undefined;
  if (block && def) {
    return (
      <>
        <h2>{def.label}</h2>
        <p className="muted small">Changes here affect only this block in this email.</p>
        <FieldForm fields={def.fields} values={block.props} disabled={!canEdit} onChange={(k, v: PropValue) => setProp(block.id, k, v)} />
      </>
    );
  }
  return (
    <>
      <h2>Email settings</h2>
      <p className="muted small">Select a block to edit it.</p>
      <p className="palette-note" data-testid="palette-note">
        <span className="swatches" aria-hidden="true">
          {[paletteOf(content.settings.palette).primary, paletteOf(content.settings.palette).dark, paletteOf(content.settings.palette).accent].map((c, i) => <i key={i} style={{ background: c }} />)}
        </span>
        Template colors: <strong>{paletteOf(content.settings.palette).label}</strong> (fixed for this email)
      </p>
      <FieldForm
        fields={SETTINGS_FIELDS}
        values={content.settings as unknown as Record<string, PropValue>}
        disabled={!canEdit}
        onChange={(k, v) => setSetting(k as keyof typeof content.settings, v as never)}
      />
    </>
  );
}

// ---------- Preview ----------
const WIDTHS = [
  { w: 320, label: 'Small phone (320)' },
  { w: 375, label: 'Phone (375)' },
  { w: 414, label: 'Large phone (414)' },
  { w: 600, label: 'Email width (600)' },
  { w: 768, label: 'Tablet (768)' },
  { w: 1024, label: 'Desktop (1024)' },
];

function PreviewPane({ campaignId, revision, onClose }: { campaignId: string; revision?: RevisionDto; onClose?: () => void }) {
  const [html, setHtml] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(375);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (!revision && !(await flushSave())) throw new Error('Fix the problem shown at the top before previewing.');
        const r = await api<PreviewResponse>('GET', `/api/campaigns/${campaignId}/preview${revision ? `?revision=${revision.id}` : ''}`);
        if (live) { setHtml(r.html); setWarnings(r.warnings); setError(''); }
      } catch (e) {
        if (live) setError(errorText(e));
      }
    })();
    return () => { live = false; };
  }, [campaignId, revision]);

  return (
    <div className="preview-pane">
      <div className="preview-bar">
        <strong>{revision ? `Version ${revision.number}` : 'Current draft'}</strong>
        <label className="inline">Width
          <select value={WIDTHS.some((x) => x.w === width) ? width : 'custom'} onChange={(e) => e.target.value !== 'custom' && setWidth(Number(e.target.value))}>
            {WIDTHS.map((x) => <option key={x.w} value={x.w}>{x.label}</option>)}
            <option value="custom">Custom…</option>
          </select>
        </label>
        <label className="inline">px
          <input type="number" min={280} max={1400} value={width} onChange={(e) => setWidth(Math.max(280, Math.min(1400, Number(e.target.value) || 280)))} style={{ width: 80 }} />
        </label>
        {onClose && <button type="button" onClick={onClose}>Close preview</button>}
      </div>
      <p className="muted small">Browser preview at the chosen width. It is not an Outlook or Gmail simulation: real email apps can render differently.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {warnings.length > 0 && <details><summary>{warnings.length} rendering note(s)</summary><pre>{warnings.join('\n')}</pre></details>}
      <div className="preview-frame-wrap">
        <iframe title="Email preview" sandbox="" srcDoc={html} style={{ width, height: '70vh', border: '1px solid var(--border)', background: '#fff' }} />
      </div>
    </div>
  );
}

// ---------- Versions ----------
function VersionsPane({ campaignId, canEdit, onRestored }: { campaignId: string; canEdit: boolean; onRestored: () => void }) {
  const load = useEditor((s) => s.load);
  const [list, setList] = useState<RevisionDto[]>([]);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [previewing, setPreviewing] = useState<RevisionDto | null>(null);

  const refresh = useCallback(async () => setList(await api<RevisionDto[]>('GET', `/api/campaigns/${campaignId}/revisions`)), [campaignId]);
  useEffect(() => { refresh().catch((e) => setError(errorText(e))); }, [refresh]);

  async function saveVersion() {
    setError('');
    try {
      if (!(await flushSave())) throw new Error('Fix the problem shown at the top before saving a version.');
      await api('POST', `/api/campaigns/${campaignId}/revisions`, { label });
      setLabel('');
      await refresh();
    } catch (e) { setError(errorText(e)); }
  }
  async function restore(r: RevisionDto) {
    if (!confirm(`Restore version ${r.number}? Your current draft is kept in the history, and the restore is recorded as a new version.`)) return;
    setError('');
    try {
      if (!(await flushSave())) throw new Error('Fix the problem shown at the top before restoring.');
      const dto = await api<CampaignDto>('POST', `/api/campaigns/${campaignId}/revisions/${r.id}/restore`);
      load(dto);
      await refresh();
      onRestored();
    } catch (e) { setError(errorText(e)); }
  }

  if (previewing) return <PreviewPane campaignId={campaignId} revision={previewing} onClose={() => setPreviewing(null)} />;
  const KIND: Record<RevisionDto['kind'], string> = { created: 'Created', manual: 'Saved version', restore: 'Restored', duplicate: 'Copied' };
  return (
    <div className="versions">
      <h2>Versions</h2>
      <p className="muted small">Your work is saved automatically. Save a named version to mark a point you may want to return to.</p>
      {canEdit && (
        <div className="row">
          <div><label htmlFor="vlabel">Name (optional)</label><input id="vlabel" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} /></div>
          <div style={{ flex: '0 0 auto' }}><button className="primary" onClick={() => void saveVersion()}>Save a version</button></div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>#</th><th>What</th><th>Who</th><th>When</th><th>Actions</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>{r.number}</td>
                <td>{KIND[r.kind]}{r.restoredFromNumber ? ` (from version ${r.restoredFromNumber})` : ''}{r.label ? <div className="muted">{r.label}</div> : null}</td>
                <td>{r.createdByName ?? '—'}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  <button className="link" onClick={() => setPreviewing(r)}>Preview</button>
                  {canEdit && <button className="link" onClick={() => void restore(r)}>Restore</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Page ----------
export function EditorPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const canEdit = can('campaign.edit');
  const lib = useLibrary();
  const s = useEditor();
  const [tab, setTab] = useState<'edit' | 'preview' | 'versions'>('edit');
  const [loadError, setLoadError] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      useEditor.getState().load(await api<CampaignDto>('GET', `/api/campaigns/${id}`));
      setLoadError('');
    } catch (e) { setLoadError(errorText(e)); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  // Autosave 1.2 s after the last change; retry after a failed save.
  useEffect(() => {
    if (!canEdit || s.campaignId !== id) return;
    if (s.saveState !== 'dirty' && s.saveState !== 'error') return;
    const t = setTimeout(() => void useEditor.getState().save(), s.saveState === 'error' ? 5000 : 1200);
    return () => clearTimeout(t);
  }, [s.content, s.saveState, canEdit, s.campaignId, id]);

  // Warn before leaving with unsaved changes; keyboard shortcuts for undo/redo.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => { if (useEditor.getState().saveState !== 'saved') e.preventDefault(); };
    const keys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !(e.ctrlKey || e.metaKey) || !canEdit) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); useEditor.getState().undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); useEditor.getState().redo(); }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', keys);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', keys); };
  }, [canEdit]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeLabel = useMemo(() => {
    if (!dragging) return '';
    if (dragging.startsWith('lib:')) return lib.find((d) => d.type === dragging.slice(4))?.label ?? '';
    const b = s.content.blocks.find((x) => x.id === dragging);
    return b ? blockDefinition(b.type)?.label ?? '' : '';
  }, [dragging, lib, s.content.blocks]);

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const st = useEditor.getState();
    const blocks = st.content.blocks;
    const overIndex = over.id === 'canvas-end' ? blocks.length : blocks.findIndex((b) => b.id === over.id);
    if (String(active.id).startsWith('lib:')) {
      const def = lib.find((d) => d.type === String(active.id).slice(4));
      if (def && overIndex >= 0) st.addBlock(def, overIndex);
      return;
    }
    const from = blocks.findIndex((b) => b.id === active.id);
    if (from >= 0 && overIndex >= 0) st.moveBlock(from, Math.min(overIndex, blocks.length - 1));
  }

  async function rename() {
    const name = useEditor.getState().name.trim();
    if (!name) return reload();
    try { await api('PATCH', `/api/campaigns/${id}`, { name }); } catch { /* shown on next save */ }
  }

  if (loadError) return <main className="page"><p className="error">{loadError}</p><Link to="/">Back to campaigns</Link></main>;
  if (s.campaignId !== id) return <main className="page"><p>Loading…</p></main>;

  const STATUS: Record<string, string> = {
    saved: 'All changes saved', dirty: 'Unsaved changes…', saving: 'Saving…',
    error: s.message, invalid: `Not saved: ${s.message}`, conflict: s.message,
  };

  return (
    <div className="editor">
      <div className="editor-top">
        <Link to="/" className="back">← Campaigns</Link>
        <input
          className="name-input"
          aria-label="Campaign name"
          value={s.name}
          readOnly={!canEdit}
          maxLength={120}
          onChange={(e) => s.setName(e.target.value)}
          onBlur={() => canEdit && void rename()}
        />
        {!canEdit && <span className="badge">View only</span>}
        <span className={`save-state ${s.saveState}`} role="status" aria-live="polite">{STATUS[s.saveState]}</span>
        {s.saveState === 'conflict' && <button className="primary" onClick={() => void reload()}>Reload latest</button>}
        {canEdit && (
          <>
            <button type="button" onClick={s.undo} disabled={s.past.length === 0} aria-label="Undo">↶ Undo</button>
            <button type="button" onClick={s.redo} disabled={s.future.length === 0} aria-label="Redo">↷ Redo</button>
          </>
        )}
        <div role="tablist" className="tabs">
          {(['edit', 'preview', 'versions'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'edit' ? 'Edit' : t === 'preview' ? 'Preview' : 'Versions'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'edit' && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="editor-grid">
            <aside className="panel-left" aria-label="Block library">
              <h2>Blocks</h2>
              <p className="muted small">Drag a block into the email, or press Add. Each one becomes your own copy to edit.</p>
              <h3 className="lib-group">Basic blocks</h3>
              <ul className="lib-list">{lib.filter((d) => d.category === 'shared').map((d) => <LibraryItem key={d.type} def={d} canEdit={canEdit} />)}</ul>
              {lib.some((d) => d.category === s.content.settings.palette) && (
                <>
                  <h3 className="lib-group">{paletteOf(s.content.settings.palette).label} blocks</h3>
                  <ul className="lib-list">{lib.filter((d) => d.category === s.content.settings.palette).map((d) => <LibraryItem key={d.type} def={d} canEdit={canEdit} />)}</ul>
                </>
              )}
            </aside>
            <section className="panel-center" aria-label="Email canvas"><Canvas canEdit={canEdit} /></section>
            <aside className="panel-right" aria-label="Properties"><Properties canEdit={canEdit} /></aside>
          </div>
          <DragOverlay>{dragging ? <div className="drag-chip">{activeLabel}</div> : null}</DragOverlay>
        </DndContext>
      )}
      {tab === 'preview' && <div className="tab-body"><PreviewPane campaignId={id} /></div>}
      {tab === 'versions' && <div className="tab-body"><VersionsPane campaignId={id} canEdit={canEdit} onRestored={() => setTab('edit')} /></div>}
    </div>
  );
}
