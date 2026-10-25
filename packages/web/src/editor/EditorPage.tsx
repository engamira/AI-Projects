import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
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
  activeVariants,
  activeLanguageVersions,
  blocksShownFor,
  describeCondition,
  emptyGroup,
  isGroup,
  pickVersion,
  versionName,
  type ConditionGroup,
  type ConditionRule,
  parseCell,
  segmentKey,
  variantCode,
  versionOf,
  blockDefinition,
  paletteOf,
  type BlockDefinition,
  type BlockInstance,
  type BrandProfileDto,
  type CampaignDto,
  type EmailSettings,
  type LibraryResponse,
  BLOCK_PRESETS,
  segmentCode,
  valueLabel,
  type ContactField,
  type SegmentsResponse,
  type TestAudienceResult,
  type TestContactDto,
  campaignStatus,
  applyItem,
  matchingItem,
  presetKeys,
  type PlaceholderIssue,
  type PreviewResponse,
  type PreviewRecipientsResponse,
  SAMPLE_RECIPIENTS,
  type PropValue,
  type RevisionDto,
} from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';
import { BlockView } from './BlockView';
import { SegmentFieldPicker } from '../components/SegmentFieldPicker';
import { ConditionBuilder } from '../components/ConditionBuilder';
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

/** The campaign's segment fields (the only fields a "show when" condition can use). */
const AudienceCtx = createContext<{ segmentFields: ContactField[] }>({ segmentFields: [] });
const plainLabel = (label: string): string => label.replace(/ \(.*\)$/, '');

/** The words and blocks being edited: the Default version, or the segment version chosen in the bar above the canvas. */
function useDoc() {
  const content = useEditor((s) => s.content);
  const editing = useEditor((s) => s.editing);
  return versionOf(content, editing);
}

// ---------- Library (originals) ----------
function LibraryItem({ def, canEdit: canEditBasic, compact }: { def: BlockDefinition; canEdit: boolean; compact?: boolean }) {
  const { can } = useSession();
  const canEdit = def.type === 'custom_html' ? can('html.custom') : canEditBasic; // Custom HTML is Admin-only; everything else is for Builders
  const addBlock = useEditor((s) => s.addBlock);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `lib:${def.type}`, disabled: !canEdit });
  return (
    <li ref={setNodeRef} className={`lib-item ${isDragging ? 'dragging' : ''}`}>
      <button className="handle" type="button" aria-label={`Drag ${def.label} into the email`} disabled={!canEdit} {...attributes} {...listeners}>⠿</button>
      <div className="lib-text">
        <strong>{def.label}</strong>
        <div className="muted small">{def.description}</div>
      </div>
      <button type="button" disabled={!canEdit} aria-label={`Add ${def.label} to the end of the email`} title={def.label} onClick={() => addBlock(def)}>{compact ? def.label.slice(0, 2) : 'Add'}</button>
    </li>
  );
}

// ---------- Canvas ----------
function SortableBlock({ block, index, total, canEdit: canEditBasic }: { block: BlockInstance; index: number; total: number; canEdit: boolean }) {
  const { can } = useSession();
  const canEdit = block.type === 'custom_html' ? can('html.custom') : canEditBasic;
  const { selectedId, select, moveBlock, duplicateBlock, deleteBlock } = useEditor();
  const doc = useDoc();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: !canEdit });
  const def = blockDefinition(block.type);
  const { segmentFields } = useContext(AudienceCtx);
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
        {block.showWhen && (
          <span className="cond-badge" data-testid="cond-badge" title="This block is shown only to contacts who meet this condition">
            Only when {describeCondition(block.showWhen, (k) => plainLabel(segmentFields.find((f) => f.key === k)?.label ?? k), (k) => segmentFields.find((f) => f.key === k)?.type)}
          </span>
        )}
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
      <div className="block-body"><BlockView block={block} settings={doc.settings} /></div>
    </div>
  );
}

function Canvas({ canEdit }: { canEdit: boolean }) {
  const select = useEditor((s) => s.select);
  const content = useDoc();
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
/** Switch between typing every field and picking ready-made content for each item (one drop-down per speaker, card or column). */
function PresetPicker({ type, props, canEdit, on, onToggle, onChoose }: { type: string; props: BlockInstance['props']; canEdit: boolean; on: boolean; onToggle: (v: boolean) => void; onChoose: (slot: number, itemId: string) => void }) {
  const block = BLOCK_PRESETS[type]!;
  return (
    <div className="preset-picker" data-testid="preset-picker">
      <label className={`switch${on ? ' on' : ''}${canEdit ? '' : ' disabled'}`}>
        <input type="checkbox" role="switch" checked={on} disabled={!canEdit} onChange={(e) => onToggle(e.target.checked)} />
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        <span className="switch-text">
          <strong>Use ready-made content</strong>
          <small>{on ? 'On: pick for each item below' : 'Off: fill in every field yourself'}</small>
        </span>
      </label>
      {on ? (
        <>
          {block.slots.map((slot, i) => {
            const current = matchingItem(type, i, props);
            return (
              <label key={slot.prefix}>{slot.label}
                <select aria-label={`Ready-made content for ${slot.label}`} disabled={!canEdit} value={current?.id ?? ''} onChange={(e) => e.target.value && onChoose(i, e.target.value)}>
                  {!current && <option value="">— Choose —</option>}
                  {block.items.map((it) => <option key={it.id} value={it.id}>{it.label}</option>)}
                </select>
              </label>
            );
          })}
          <p className="muted small">Each choice fills that item's picture and words. Links and spacing are not changed. Names, people and prices are samples: replace them with real details before sending, and swap the sample pictures for your own if you prefer. Turn the switch off to edit every field yourself.</p>
        </>
      ) : null}
    </div>
  );
}

function usedFields(g: ConditionGroup, out = new Set<string>()): Set<string> {
  for (const r of g.rules) { if (isGroup(r)) usedFields(r, out); else out.add((r as ConditionRule).field); }
  return out;
}

/** "Who sees this block": everyone, or only contacts who meet conditions about this campaign's segment fields. */
function ShowWhenPanel({ block, canEdit }: { block: BlockInstance; canEdit: boolean }) {
  const { segmentFields } = useContext(AudienceCtx);
  const setShowWhen = useEditor((s) => s.setShowWhen);
  if (segmentFields.length === 0) {
    return <div className="show-when"><h3>Who sees this block</h3><p className="muted small">Everyone. To show a block only to some segments, first choose this campaign's segment fields in the Audience tab.</p></div>;
  }
  const stale = block.showWhen ? [...usedFields(block.showWhen)].filter((k) => !segmentFields.some((f) => f.key === k)) : [];
  return (
    <div className="show-when" data-testid="show-when">
      <h3>Who sees this block</h3>
      <select aria-label="Who sees this block" disabled={!canEdit} value={block.showWhen ? 'some' : 'all'}
        onChange={(e) => setShowWhen(block.id, e.target.value === 'some' ? emptyGroup(segmentFields[0]!.key) : null)}>
        <option value="all">Everyone</option>
        <option value="some">Only contacts who meet conditions</option>
      </select>
      {block.showWhen && <ConditionBuilder value={block.showWhen} fields={segmentFields} disabled={!canEdit} onChange={(g) => setShowWhen(block.id, g)} />}
      {stale.length > 0 && <p className="error" role="alert">This condition uses {stale.join(', ')}, which is no longer one of the campaign's segment fields. Choose the field again or remove the rule.</p>}
      <p className="muted small">Conditions can use this campaign's segment fields: {segmentFields.map((f) => plainLabel(f.label)).join(', ')}. Contacts who do not meet them get the email without this block.</p>
    </div>
  );
}

function Properties({ canEdit: canEditBasic }: { canEdit: boolean }) {
  const { selectedId, setProp, setProps, setSetting, copyBlockToOthers } = useEditor();
  const hasVersions = useEditor((s) => (s.content.variants?.length ?? 0) > 0);
  const content = useDoc();
  const { can } = useSession();
  const [readyMade, setReadyMade] = useState<Record<string, boolean>>({}); // per block, this session only
  const block = content.blocks.find((b) => b.id === selectedId);
  const canEdit = block?.type === 'custom_html' ? can('html.custom') : canEditBasic;
  const def = block ? blockDefinition(block.type) : undefined;
  if (block && def) {
    return (
      <>
        <h2>{def.label}</h2>
        <p className="muted small">Changes here affect only this block in this email.</p>
        {BLOCK_PRESETS[block.type] && (
          <PresetPicker
            type={block.type}
            props={block.props}
            canEdit={canEdit}
            on={readyMade[block.id] === true}
            onToggle={(v) => setReadyMade((m) => ({ ...m, [block.id]: v }))}
            onChoose={(slot, itemId) => setProps(block.id, applyItem(block.type, block.props, slot, itemId))}
          />
        )}
        <FieldForm
          fields={readyMade[block.id] && BLOCK_PRESETS[block.type] ? def.fields.filter((f) => !presetKeys(block.type).has(f.key)) : def.fields}
          values={block.props}
          disabled={!canEdit}
          onChange={(k, v: PropValue) => setProp(block.id, k, v)}
        />
        <ShowWhenPanel block={block} canEdit={canEditBasic} />
        {hasVersions && canEditBasic && block.type !== 'custom_html' && (
          <p><button type="button" onClick={() => copyBlockToOthers(block.id)} title="Puts an independent copy of this block into every other version of the email, replacing the same block there if it exists">Copy this block to all other versions</button></p>
        )}
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
const PHONE_WIDTHS = [
  { w: 320, label: 'Small phone (320)' },
  { w: 375, label: 'Phone (375)' },
  { w: 414, label: 'Large phone (414)' },
];
const DESKTOP_WIDTHS = [
  { w: 600, label: 'Email width (600)' },
  { w: 768, label: 'Tablet (768)' },
  { w: 1024, label: 'Desktop (1024)' },
  { w: 1280, label: 'Wide desktop (1280)' },
];

// The preview is HTML we generated, shown in a frame with no scripts and a content policy that only allows https pictures and inline styles.
const PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https:; form-action 'none'">`;

/** One simulated screen: the generated email at a chosen width. */
function DeviceFrame({ kind, html, widths, initial }: { kind: 'phone' | 'desktop'; html: string; widths: { w: number; label: string }[]; initial: number }) {
  const [width, setWidth] = useState(initial);
  const name = kind === 'phone' ? 'Phone' : 'Desktop';
  return (
    <section className={`device device-${kind}`} aria-label={`${name} view`}>
      <div className="device-bar">
        <strong>{name}</strong>
        <select aria-label={`${name} width`} value={widths.some((x) => x.w === width) ? width : 'custom'} onChange={(e) => e.target.value !== 'custom' && setWidth(Number(e.target.value))}>
          {widths.map((x) => <option key={x.w} value={x.w}>{x.label}</option>)}
          <option value="custom">Custom…</option>
        </select>
        <input type="number" aria-label={`${name} width in pixels`} min={280} max={1600} value={width} onChange={(e) => setWidth(Math.max(280, Math.min(1600, Number(e.target.value) || 280)))} style={{ width: 80 }} /> <span className="muted small">px</span>
      </div>
      <div className={`frame frame-${kind}`}>
        {kind === 'desktop' && (
          <div className="frame-chrome" aria-hidden="true">
            <i /><i /><i />
            <span className="frame-url">Email preview</span>
          </div>
        )}
        {kind === 'phone' && <div className="frame-notch" aria-hidden="true" />}
        <div className="device-screen">
          <iframe title={`${name} preview`} sandbox="" srcDoc={html.replace(/<head[^>]*>/i, (m) => m + PREVIEW_CSP)} style={{ width, height: kind === 'phone' ? '70vh' : '74vh', border: 0, background: '#fff', display: 'block' }} />
        </div>
        {kind === 'phone' && <div className="frame-home" aria-hidden="true" />}
      </div>
    </section>
  );
}

function PreviewPane({ campaignId, revision, onClose }: { campaignId: string; revision?: RevisionDto; onClose?: () => void }) {
  const [html, setHtml] = useState('');
  const [text, setText] = useState('');
  const [issues, setIssues] = useState<PlaceholderIssue[]>([]);
  const [as, setAs] = useState<string>('sample');
  const [recipients, setRecipients] = useState<PreviewRecipientsResponse | null>(null);
  const [shownAs, setShownAs] = useState('');
  const [shownVersion, setShownVersion] = useState('');
  const [showText, setShowText] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  // The desktop view starts as wide as the screen allows next to the phone, between 600 and 1024 px.
  const desktopStart = Math.max(600, Math.min(1024, Math.round((typeof window === 'undefined' ? 1280 : window.innerWidth) - 375 - 24 - 72)));

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (!revision && !(await flushSave())) throw new Error('Fix the problem shown at the top before previewing.');
        const r = await api<PreviewResponse>('GET', `/api/campaigns/${campaignId}/preview?as=${as}${revision ? `&revision=${revision.id}` : ''}`);
        if (live) { setShownAs(r.recipientLabel ?? ''); setShownVersion(r.versionLabel ?? ''); setHtml(r.html); setText(r.text); setIssues(r.placeholderIssues); setWarnings(r.warnings); setError(''); }
      } catch (e) {
        if (live) setError(errorText(e));
      }
    })();
    return () => { live = false; };
  }, [campaignId, revision, as]);

  // who the email can be shown as: examples, the made-up test audience and your contacts, grouped by segment
  useEffect(() => {
    api<PreviewRecipientsResponse>('GET', `/api/campaigns/${campaignId}/preview-recipients`).then(setRecipients).catch(() => undefined);
  }, [campaignId]);

  return (
    <div className="preview-pane">
      <div className="preview-bar">
        <strong>{revision ? `Version ${revision.number}` : 'Current draft'}</strong>
        <span className="muted small">Phone and desktop side by side. Each has its own width.</span>
        <label className="small">Preview as{' '}
          <select value={as} onChange={(e) => setAs(e.target.value)}>
            {(recipients?.groups ?? [{ title: 'Built-in examples', recipients: SAMPLE_RECIPIENTS.map((r) => ({ id: r.id, label: r.label })) }]).map((g) => (
              <optgroup key={g.title} label={g.title}>{g.recipients.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</optgroup>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setShowText((v) => !v)}>{showText ? 'Show email' : 'Show plain text'}</button>
        {onClose && <button type="button" onClick={onClose}>Close preview</button>}
      </div>
      {issues.length > 0 && (
        <div className="error" role="alert">
          <strong>{issues.length} personalization problem{issues.length > 1 ? 's' : ''} to fix before sending:</strong>
          <ul>{issues.map((i, k) => <li key={k}><code>{i.text}</code> — {i.message}</li>)}</ul>
        </div>
      )}
      {(shownAs || shownVersion) && <p className="small" data-testid="previewing-as">{shownAs && <>Previewing as <strong>{shownAs}</strong></>}{shownAs && shownVersion && ' · '}{shownVersion && <>Showing the <strong data-testid="shown-version">{shownVersion}</strong></>}</p>}
      <p className="muted small">Browser preview. It is not an Outlook or Gmail simulation: real email apps can render differently.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {warnings.length > 0 && <details><summary>{warnings.length} rendering note(s)</summary><pre>{warnings.join('\n')}</pre></details>}
      {showText && (
        <div>
          <p className="muted small">Plain-text version, sent alongside the HTML for email apps that cannot show it.</p>
          <pre className="plain-text" style={{ whiteSpace: 'pre-wrap', maxWidth: 680, padding: 16, border: '1px solid var(--border, #ccc)', borderRadius: 8 }}>{text}</pre>
        </div>
      )}
      <div className="preview-devices" style={showText ? { display: "none" } : undefined}>
        <DeviceFrame kind="phone" html={html} widths={PHONE_WIDTHS} initial={375} />
        <DeviceFrame kind="desktop" html={html} widths={DESKTOP_WIDTHS} initial={desktopStart} />
      </div>
    </div>
  );
}

// ---------- Audience set-up for this campaign ----------
type AudienceInfo = { audience: { fields: string[] }; available: ContactField[]; test: TestContactDto[] };

/** Add a field of your own (for example "Interest") while setting up a campaign; it is then available to every campaign. */
function AddFieldInline({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  const [error, setError] = useState('');
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try { await api('POST', '/api/contact-fields', { label, type }); setLabel(''); setOpen(false); onAdded(); } catch (err) { setError(errorText(err)); }
  }
  if (!open) return <p><button type="button" className="link" onClick={() => setOpen(true)}>＋ Add a field of my own</button></p>;
  return (
    <form className="inline-form" onSubmit={(e) => void add(e)} aria-label="Add a field of my own">
      <div><label htmlFor="inline-field-name">New field name</label><input id="inline-field-name" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Interest" /></div>
      <div><label htmlFor="inline-field-type">Kind of values</label>
        <select id="inline-field-type" value={type} onChange={(e) => setType(e.target.value)}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / no</option></select></div>
      <div className="inline-form-actions"><button className="primary" disabled={!label.trim()}>Add field</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
      {error && <p className="error" role="alert" style={{ flexBasis: '100%' }}>{error}</p>}
    </form>
  );
}

/** How this campaign's versions are built, the language defaults, and which email each segment receives. */
function VersioningCard({ chosen, chosenFields, segs, test, canEdit, onOpen }: {
  chosen: string[]; chosenFields: ContactField[]; segs: SegmentsResponse | null; test: TestContactDto[]; canEdit: boolean; onOpen: () => void;
}) {
  const content = useEditor((s) => s.content);
  const addVariant = useEditor((s) => s.addVariant);
  const addLanguageVersion = useEditor((s) => s.addLanguageVersion);
  const removeVariant = useEditor((s) => s.removeVariant);
  const setVersioning = useEditor((s) => s.setVersioning);
  const setEditing = useEditor((s) => s.setEditing);
  const [copyFrom, setCopyFrom] = useState<string>('');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [typedLanguage, setTypedLanguage] = useState('');
  const [error, setError] = useState('');
  const typeOf = (k: string) => chosenFields.find((f) => f.key === k)?.type;
  const label = (f: ContactField) => plainLabel(f.label);

  // the language field defaults to Language when it is one of the segment fields
  const saved = content.versioning;
  const languageField = saved?.languageField && chosen.includes(saved.languageField) ? saved.languageField : saved?.languageField === undefined && chosen.includes('language') ? 'language' : undefined;
  const mode = saved?.mode ?? (languageField ? 'conditions' : 'copies');
  const useLanguages = mode === 'conditions' && !!languageField;
  const languageFieldLabel = chosenFields.find((f) => f.key === languageField)?.label;
  const setMode = (m: 'conditions' | 'copies') => setVersioning({ mode: m, ...(languageField ? { languageField } : {}) });
  const setLanguageField = (k: string) => setVersioning({ mode, ...(k ? { languageField: k } : {}) });

  const copies = activeVariants(content, chosen);
  const languages = activeLanguageVersions({ ...content, versioning: { mode: 'conditions', ...(languageField ? { languageField } : {}) } }, chosen);
  const unused = (content.variants ?? []).filter((v) => !copies.includes(v) && !languages.includes(v));

  // languages found in the segments (contact list and test audience), plus languages that already have a default
  const found = new Map<string, { value: string; contacts: number }>();
  if (languageField) {
    const at = chosen.indexOf(languageField);
    const note = (raw: unknown, n: number) => {
      const v = raw === null || raw === undefined ? '' : String(raw).trim();
      if (!v) return;
      const k = v.toLowerCase();
      found.set(k, { value: found.get(k)?.value ?? v, contacts: (found.get(k)?.contacts ?? 0) + n });
    };
    for (const s of segs?.segments ?? []) note(s.values[at], s.total);
    for (const c of test) note(c.data[languageField], 0);
    for (const v of languages) note(v.values[0], 0);
  }

  type Row = { key: string; values: (string | number | boolean | null)[]; total?: number; eligible?: number };
  const rows = new Map<string, Row>();
  const add = (values: Row['values'], extra: Partial<Row> = {}) => {
    const key = segmentKey(chosen, values);
    if (!rows.has(key)) rows.set(key, { key, values, ...extra });
  };
  for (const s of segs?.segments ?? []) if (!s.values.every((v) => v === null || v === '')) add(s.values, { total: s.total, eligible: s.eligible });
  for (const c of test) add(chosenFields.map((f) => c.data[f.key] ?? null));
  for (const v of copies) add(v.values);
  const list = [...rows.values()];
  const codeOf = (values: Row['values']) => values.map((x) => (x === null || x === '' ? 'blank' : typeof x === 'boolean' ? (x ? 'yes' : 'no') : String(x))).join('-');
  const effective = { ...content, versioning: { mode, ...(languageField ? { languageField } : {}) } };
  const resolve = (r: Row) => {
    const contact = Object.fromEntries(chosen.map((k, i) => [k, r.values[i] ?? null]));
    const pick = pickVersion(effective, chosen, contact);
    const src = pick.variant ?? content;
    return { ...pick, shown: blocksShownFor(src.blocks, contact, typeOf).length, total: src.blocks.length };
  };
  const contactsOnDefault = list.filter((r) => resolve(r).layer === 'default').reduce((n, r) => n + (r.total ?? 0), 0);

  function commit(id: string | null) {
    if (!id) setError('Could not add that version: it already exists, or the campaign has the most versions allowed.');
    else onOpen();
  }
  function ensureVersioning() { if (!saved || saved.mode !== mode || saved.languageField !== languageField) setVersioning({ mode, ...(languageField ? { languageField } : {}) }); }
  function createCopy(values: Row['values']) {
    setError('');
    ensureVersioning();
    commit(addVariant(chosen, values, copyFrom || null));
  }
  function createLanguage(value: string) {
    setError('');
    if (!languageField) return;
    ensureVersioning();
    commit(addLanguageVersion(languageField, value, copyFrom || null));
  }
  function createTyped() {
    const values: Row['values'] = [];
    for (const f of chosenFields) {
      const cell = parseCell(f, typed[f.key] ?? '');
      if ('error' in cell) { setError(cell.error + '.'); return; }
      values.push(cell.value);
    }
    setTyped({});
    createCopy(values);
  }

  return (
    <div className="card wide" data-testid="segment-versions">
      <h3 style={{ marginTop: 0 }}>One email for each segment</h3>
      <p className="muted small">Contacts get, in this order: an email written only for their segment, else the default email for their language, else the overall Default email.</p>
      {error && <p className="error" role="alert">{error}</p>}

      <fieldset className="build-mode" disabled={!canEdit}>
        <legend>How will you build the versions?</legend>
        <label className="check"><input type="radio" name="build-mode" checked={mode === 'conditions'} onChange={() => setMode('conditions')} />
          <span><strong>One email per language, with show/hide conditions.</strong> Each language gets a default email that holds every block any of its segments need. On each block you choose which segments see it.</span></label>
        <label className="check"><input type="radio" name="build-mode" checked={mode === 'copies'} onChange={() => setMode('copies')} />
          <span><strong>A separate copy for each segment.</strong> A segment's version starts as a copy of the Default (or of another version) and you add, delete and edit its blocks one version at a time.</span></label>
      </fieldset>

      {mode === 'conditions' && (
        <label className="lang-setting">Language field
          <select aria-label="Language field" disabled={!canEdit} value={languageField ?? ''} onChange={(e) => setLanguageField(e.target.value)}>
            <option value="">— none —</option>
            {chosenFields.map((f) => <option key={f.key} value={f.key}>{label(f)}</option>)}
          </select>
        </label>
      )}
      {mode === 'conditions' && !languageField && <p className="muted small">Choose the field that holds the language (it must be one of the segment fields above) to get a default email for each language. Without it, everyone gets the Default email, with show/hide conditions applied.</p>}

      {canEdit && (
        <label>New versions start as a copy of
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">The Default email</option>
            {languages.map((v) => <option key={v.id} value={v.id}>The {versionName(v)} email</option>)}
            {copies.map((v) => <option key={v.id} value={v.id}>The {versionName(v)} version</option>)}
          </select>
        </label>
      )}

      {useLanguages && (
        <>
          <h4>Default email for each language</h4>
          <p className="muted small">The languages come from this campaign's segments ({languageFieldLabel ? plainLabel(languageFieldLabel) : ''}). Put every block that any segment of the language needs in its default, then set who sees each block.</p>
          {found.size === 0 && <p className="muted">No languages found yet. Import contacts, add test combinations, or type a language below.</p>}
          {found.size > 0 && (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Language</th><th>Contacts</th><th>Default email</th><th></th></tr></thead>
                <tbody>
                  {[...found.entries()].map(([k, l]) => {
                    const v = languages.find((x) => x.key === segmentKey([languageField!], [l.value]));
                    return (
                      <tr key={k}>
                        <td><strong>{l.value}</strong></td>
                        <td>{l.contacts}</td>
                        <td>{v ? <span className="ok">{v.blocks.length} block{v.blocks.length === 1 ? '' : 's'}</span> : <span className="muted">Not created yet</span>}</td>
                        <td>
                          {v && <button type="button" className="link" aria-label={`${canEdit ? 'Edit' : 'View'} the ${l.value} default`} onClick={() => { setEditing(v.id); onOpen(); }}>{canEdit ? 'Edit' : 'View'}</button>}
                          {v && canEdit && <button type="button" className="link danger" aria-label={`Delete the ${l.value} default`} onClick={() => { if (window.confirm(`Delete the default email for ${l.value}? Its segments will get the overall Default.`)) removeVariant(v.id); }}>Delete</button>}
                          {!v && canEdit && <button type="button" className="link" aria-label={`Create the default for ${l.value}`} onClick={() => createLanguage(l.value)}>Create default</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {canEdit && (
            <div className="inline-form">
              <div><label htmlFor="typed-language">Another language</label><input id="typed-language" value={typedLanguage} onChange={(e) => setTypedLanguage(e.target.value)} placeholder="e.g. fr" /></div>
              <div className="inline-form-actions"><button type="button" disabled={!typedLanguage.trim()} onClick={() => { createLanguage(typedLanguage.trim()); setTypedLanguage(''); }}>Create this default</button></div>
            </div>
          )}
        </>
      )}

      <h4>Which email each segment receives</h4>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Segment</th><th>Contacts</th><th>Email</th><th></th></tr></thead>
          <tbody>
            <tr><td><strong>Overall Default</strong></td><td className="muted small">{contactsOnDefault > 0 ? `${contactsOnDefault} in segments with no version` : 'everyone else'}</td><td>Default email</td><td><button type="button" className="link" onClick={() => { setEditing(null); onOpen(); }}>Edit</button></td></tr>
            {list.map((r) => {
              const own = copies.find((v) => v.key === r.key);
              const res = resolve(r);
              const code = own ? variantCode(own) : codeOf(r.values);
              return (
                <tr key={r.key}>
                  <td><strong>{code}</strong></td>
                  <td>{r.total !== undefined ? `${r.total} (${r.eligible} eligible)` : <span className="muted small">no contacts in your list</span>}</td>
                  <td>
                    {res.layer === 'copy' && <span className="ok">Own copy</span>}
                    {res.layer === 'language' && <span>{versionName(res.variant!)}<span className="muted small"> · {res.shown} of {res.total} blocks</span></span>}
                    {res.layer === 'default' && <span className="muted">Uses the Default{res.total !== res.shown ? ` · ${res.shown} of ${res.total} blocks` : ''}</span>}
                  </td>
                  <td>
                    {own && <button type="button" className="link" aria-label={`${canEdit ? 'Edit' : 'View'} the ${code} version`} onClick={() => { setEditing(own.id); onOpen(); }}>{canEdit ? 'Edit' : 'View'}</button>}
                    {own && canEdit && <button type="button" className="link danger" aria-label={`Delete the ${code} version`} onClick={() => { if (window.confirm(`Delete the ${code} version of this email? Its contacts will get ${useLanguages ? 'the language default or the overall Default' : 'the Default email'}.`)) removeVariant(own.id); }}>Delete</button>}
                    {!own && res.layer === 'language' && <button type="button" className="link" aria-label={`Edit the ${code} email`} onClick={() => { setEditing(res.variant!.id); onOpen(); }}>{canEdit ? 'Edit the language default' : 'View'}</button>}
                    {!own && canEdit && <button type="button" className="link" aria-label={`Create a version for ${code}`} onClick={() => createCopy(r.values)}>{res.layer === 'language' ? 'Make a separate copy' : 'Create version'}</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <>
          <p className="small" style={{ marginTop: 12 }}><strong>Another segment.</strong> Type one value for each field to write a separate copy for a segment that is not in the list yet.</p>
          <div className="map-grid">
            {chosenFields.map((f) => (
              <label key={f.key}>{label(f)}
                <input aria-label={`Version value for ${label(f)}`} value={typed[f.key] ?? ''} onChange={(e) => setTyped({ ...typed, [f.key]: e.target.value })} />
              </label>
            ))}
          </div>
          <p><button type="button" disabled={chosenFields.some((f) => !(typed[f.key] ?? '').trim())} onClick={createTyped}>Create this version</button></p>
        </>
      )}
      {unused.length > 0 && (
        <details>
          <summary>{unused.length} version{unused.length > 1 ? 's' : ''} not used now</summary>
          <p className="muted small">These were made for other segment fields, or for language defaults that are switched off. They are kept, and used again if you choose the same settings. Contacts get another email meanwhile.</p>
          <ul>{unused.map((v) => <li key={v.id}><strong>{versionName(v)}</strong> <span className="muted small">({v.fields.join(', ')})</span> {canEdit && <button type="button" className="link danger" onClick={() => { if (window.confirm('Delete this version?')) removeVariant(v.id); }}>Delete</button>}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function AudiencePane({ campaignId, canEdit, onOpenVersion, onContinue }: { campaignId: string; canEdit: boolean; onOpenVersion: () => void; onContinue: () => void }) {
  const { can } = useSession();
  const [info, setInfo] = useState<AudienceInfo | null>(null);
  const [segs, setSegs] = useState<SegmentsResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const i = await api<AudienceInfo>('GET', `/api/campaigns/${campaignId}/audience`);
    setInfo(i);
    if (can('audience.manage') && i.audience.fields.length) setSegs(await api<SegmentsResponse>('GET', `/api/audience/segments?fields=${i.audience.fields.join(',')}`));
    else setSegs(null);
  }, [campaignId, can]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  const guarded = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try { await fn(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const chosen = info?.audience.fields ?? [];
  const chosenFields = chosen.map((k) => info?.available.find((f) => f.key === k)).filter((f): f is ContactField => !!f);

  function changeFields(next: string[]) {
    const hasVersions = activeVariants(useEditor.getState().content, chosen).length > 0;
    const parts = [info && info.test.length ? 'removes the test audience made for this campaign' : '', hasVersions ? 'stops using the segment versions you wrote (they are kept, and used again if you choose the same fields)' : ''].filter(Boolean);
    if (next.join() !== chosen.join() && parts.length && !window.confirm(`Changing the fields ${parts.join(' and ')}. Continue?`)) return;
    void guarded(async () => { await api('PUT', `/api/campaigns/${campaignId}/audience`, { fields: next }); });
  }
  const generate = (mode: 'sheet' | 'values') => guarded(async () => {
    const vals = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.split(',').map((s) => s.trim()).filter(Boolean)]));
    const r = await api<TestAudienceResult>('POST', `/api/campaigns/${campaignId}/test-audience`, { mode, values: mode === 'values' ? vals : undefined });
    setNote(r.added === 0 ? 'Nothing new to add: those combinations are already in the test audience.' : `Added ${r.added} test contact${r.added === 1 ? '' : 's'}${r.alreadyThere ? ` (${r.alreadyThere} already there)` : ''}.`);
    if (mode === 'values') setValues({});
  });

  return (
    <div className="audience-pane">
      <p className="step-line" data-testid="audience-step"><strong>Step 1 of 2: who is this campaign for?</strong> <span className="muted">Set up the segments first. They tell you which languages and versions you need.</span> <button type="button" className="primary" onClick={onContinue}>Step 2: write the email →</button></p>
      <h2>Who this campaign is for</h2>
      <p className="muted small">Choose the fields that split this campaign's audience into segments, for example Country and Language. A segment is named from its values, such as UAE-en or EG-ar, and those names appear in Preview and test sends. Each campaign can use different fields.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <SegmentFieldPicker available={info?.available ?? []} chosen={chosen} disabled={!canEdit || busy} onChange={changeFields} idPrefix="campaign-seg" />
      {canEdit && can('audience.manage') && <AddFieldInline onAdded={() => void guarded(async () => undefined)} />}
      {!canEdit && <p className="muted small">Only a Builder can change this, and only while the campaign is a draft.</p>}
      {note && <p className="ok" role="status">{note}</p>}

      {chosen.length === 0 && <p className="muted">Pick at least one field to see the segments and to create a test audience.</p>}
      {segs && (
        <>
          <h3>Segments in your contact list</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Segment</th>{segs.fields.map((f) => <th key={f.key}>{f.label.replace(/ \(.*\)$/, '')}</th>)}<th>Contacts</th><th>Eligible</th></tr></thead>
              <tbody>{segs.segments.map((s) => <tr key={s.id}><td><strong>{segmentCode(s.values)}</strong></td>{s.values.map((v, i) => <td key={i}>{valueLabel(v)}</td>)}<td>{s.total}</td><td>{s.eligible}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}

      {chosen.length > 0 && <VersioningCard chosen={chosen} chosenFields={chosenFields} segs={segs} test={info?.test ?? []} canEdit={canEdit} onOpen={onOpenVersion} />}

      {chosen.length > 0 && (
        <div className="card wide" data-testid="test-audience">
          <h3 style={{ marginTop: 0 }}>Test audience</h3>
          <p className="muted small">Made-up contacts, one for each segment, to try this email against. They are not part of your contact list, they are never emailed, and they use made-up addresses ending in .invalid. Pick one in the Preview tab with "Preview as".</p>
          {canEdit && (
            <>
              <p className="small"><strong>Add combinations.</strong> Type the values for each field. Every value you list for one field is combined with the values you list for the others, and anything already in the test audience is kept. For example Country UAE with Language en, ar adds UAE-en and UAE-ar. Then add Country FR with Language fr for FR-fr.</p>
              <div className="map-grid">
                {chosenFields.map((f) => (
                  <label key={f.key}>{f.label.replace(/ \(.*\)$/, '')} <span className="muted small">(separate several with commas)</span>
                    <input value={values[f.key] ?? ''} placeholder={f.type === 'text' ? 'e.g. UAE' : ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                  </label>
                ))}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <div style={{ flex: '0 0 auto' }}><button type="button" className="primary" disabled={busy || chosenFields.some((f) => !(values[f.key] ?? '').trim())} onClick={() => void generate('values')}>Add these combinations</button></div>
                <div style={{ flex: '0 0 auto' }}><button type="button" disabled={busy} onClick={() => void generate('sheet')}>Add the segments from my contact list</button></div>
                {(info?.test.length ?? 0) > 0 && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Remove every test contact of this campaign?')) void guarded(async () => { await api('DELETE', `/api/campaigns/${campaignId}/test-audience`); }); }}>Remove all</button>}
              </div>
            </>
          )}
          {(info?.test.length ?? 0) > 0 && (
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Segment</th><th>Test contact</th><th>Made-up address</th><th></th></tr></thead>
                <tbody>{info!.test.map((c) => <tr key={c.id}><td><strong>{c.code}</strong></td><td>{String(c.data.first_name ?? '')} {String(c.data.last_name ?? '')}</td><td className="muted small">{c.email}</td><td>{canEdit && <button type="button" className="link danger" aria-label={`Remove test contact ${c.code}`} disabled={busy} onClick={() => void guarded(async () => { await api('DELETE', `/api/campaigns/${campaignId}/test-audience/${c.id}`); })}>Remove</button>}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Live preview: the real email HTML next to the canvas, refreshed shortly after each saved edit. */
function LivePane({ campaignId }: { campaignId: string }) {
  const saveState = useEditor((s) => s.saveState);
  const version = useEditor((s) => s.version);
  const editing = useEditor((s) => s.editing);
  const [html, setHtml] = useState('');
  const [issues, setIssues] = useState(0);
  const [kind, setKind] = useState<'phone' | 'desktop'>('phone');
  const [error, setError] = useState('');
  useEffect(() => {
    if (saveState !== 'saved') return; // wait until the edit has been saved: the preview always shows saved content
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const r = await api<PreviewResponse>('GET', `/api/campaigns/${campaignId}/preview?as=sample${editing ? `&variant=${editing}` : ''}`);
        if (live) { setHtml(r.html); setIssues(r.placeholderIssues.length); setError(''); }
      } catch (e) { if (live) setError(errorText(e)); }
    }, 600);
    return () => { live = false; clearTimeout(timer); };
  }, [campaignId, saveState, version, editing]);
  return (
    <div className="live-pane" data-testid="live-preview">
      <div className="preview-bar">
        <strong>Live preview</strong>
        <span role="group" aria-label="Preview device">
          <button type="button" aria-pressed={kind === 'phone'} onClick={() => setKind('phone')}>Phone</button>
          <button type="button" aria-pressed={kind === 'desktop'} onClick={() => setKind('desktop')}>Desktop</button>
        </span>
      </div>
      <p className="muted small">Browser preview of the saved email, not an Outlook or Gmail simulation.{saveState !== 'saved' && ' Updating after your changes are saved…'}</p>
      {issues > 0 && <p className="error" role="alert">{issues} personalization problem(s): see the Preview tab.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {kind === 'phone'
        ? <DeviceFrame key="p" kind="phone" html={html} widths={PHONE_WIDTHS} initial={375} />
        : <DeviceFrame key="d" kind="desktop" html={html} widths={DESKTOP_WIDTHS} initial={600} />}
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

// ---------- Which version of the email is being edited ----------
function VersionBar({ audienceFields, canEdit }: { audienceFields: string[]; canEdit: boolean }) {
  const content = useEditor((s) => s.content);
  const editing = useEditor((s) => s.editing);
  const setEditing = useEditor((s) => s.setEditing);
  const active = activeVariants(content, audienceFields);
  const languages = activeLanguageVersions(content, audienceFields);
  if (active.length === 0 && languages.length === 0) return null;
  const current = [...active, ...languages].find((v) => v.id === editing);
  return (
    <div className="version-bar" data-testid="version-bar">
      <label>Editing version{' '}
        <select value={current?.id ?? ''} onChange={(e) => setEditing(e.target.value || null)}>
          <option value="">Default version</option>
          {languages.length > 0 && <optgroup label="Language defaults">{languages.map((v) => <option key={v.id} value={v.id}>{versionName(v)}</option>)}</optgroup>}
          {active.length > 0 && <optgroup label="Segment copies">{active.map((v) => <option key={v.id} value={v.id}>{variantCode(v)} version</option>)}</optgroup>}
        </select>
      </label>
      <span className="muted small">
        {current ? (current.kind === 'language' ? `You are editing the ${versionName(current)} email. Put every block its segments need here, then choose who sees each block.` : `You are editing the ${variantCode(current)} version. Only contacts in that segment receive it.`) : 'The Default version is sent to contacts in segments without a version of their own.'}
        {current && !canEdit ? ' (view only)' : ''}
      </span>
    </div>
  );
}

// ---------- Page ----------
export function EditorPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const canEdit = can('campaign.edit');
  const canAny = canEdit || can('html.custom'); // an Admin may only work on Custom HTML blocks
  const lib = useLibrary();
  const s = useEditor();
  const location = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'edit' | 'audience' | 'preview' | 'versions'>((location.state as { tab?: 'audience' } | null)?.tab ?? 'edit'); // a new campaign opens on its Audience: segments come first
  // the "open on Audience" hint is for the first visit only: a reload goes back to the normal view
  useEffect(() => { if (location.state) navigate(location.pathname, { replace: true, state: null }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [loadError, setLoadError] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [audienceFields, setAudienceFields] = useState<string[]>([]);
  const [availableFields, setAvailableFields] = useState<ContactField[]>([]);

  const reload = useCallback(async () => {
    try {
      useEditor.getState().load(await api<CampaignDto>('GET', `/api/campaigns/${id}`));
      setLoadError('');
    } catch (e) { setLoadError(errorText(e)); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  // the campaign's segment fields decide which segment versions are in use
  useEffect(() => {
    api<{ audience: { fields: string[] }; available: ContactField[] }>('GET', `/api/campaigns/${id}/audience`).then((a) => { setAudienceFields(a.audience.fields); setAvailableFields(a.available); }).catch(() => undefined);
  }, [id, tab]);

  // Autosave 1.2 s after the last change; retry after a failed save.
  useEffect(() => {
    if (!canAny || s.campaignId !== id) return;
    if (s.saveState !== 'dirty' && s.saveState !== 'error') return;
    const t = setTimeout(() => void useEditor.getState().save(), s.saveState === 'error' ? 5000 : 1200);
    return () => clearTimeout(t);
  }, [s.content, s.saveState, canAny, s.campaignId, id]);

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
    const b = versionOf(s.content, s.editing).blocks.find((x) => x.id === dragging);
    return b ? blockDefinition(b.type)?.label ?? '' : '';
  }, [dragging, lib, s.content, s.editing]);

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const st = useEditor.getState();
    const blocks = versionOf(st.content, st.editing).blocks;
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

  const segmentFields = audienceFields.map((k) => availableFields.find((f) => f.key === k)).filter((f): f is ContactField => !!f);

  return (
    <AudienceCtx.Provider value={{ segmentFields }}>
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
        <span className={`badge status-${campaignStatus(s.status).tone}`} title={campaignStatus(s.status).hint}>{campaignStatus(s.status).label}</span>
        {!canAny && <span className="badge">View only</span>}
        {canAny && !canEdit && <span className="badge">Custom HTML only</span>}
        <span className={`save-state ${s.saveState}`} role="status" aria-live="polite">{STATUS[s.saveState]}</span>
        {s.saveState === 'conflict' && <button className="primary" onClick={() => void reload()}>Reload latest</button>}
        {canAny && (
          <>
            <button type="button" onClick={s.undo} disabled={s.past.length === 0} aria-label="Undo">↶ Undo</button>
            <button type="button" onClick={s.redo} disabled={s.future.length === 0} aria-label="Redo">↷ Redo</button>
          </>
        )}
        {tab === 'edit' && (
          <label className={`switch switch-small${live ? ' on' : ''}`} title="Show the real email next to the editor while you work">
            <input type="checkbox" role="switch" checked={live} onChange={(e) => setLive(e.target.checked)} />
            <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
            <span className="switch-text"><strong>Live preview</strong></span>
          </label>
        )}
        <div role="tablist" className="tabs">
          {(['edit', 'audience', 'preview', 'versions'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'edit' ? 'Edit' : t === 'audience' ? 'Audience' : t === 'preview' ? 'Preview' : 'Versions'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'edit' && <VersionBar audienceFields={audienceFields} canEdit={canEdit} />}
      {tab === 'edit' && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className={`editor-grid${live ? ' live' : ''}`}>
            <aside className="panel-left" aria-label="Block library">
              <h2>Blocks</h2>
              <p className="muted small">Drag a block into the email, or press Add. Each one becomes your own copy to edit.</p>
              <h3 className="lib-group">Basic blocks</h3>
              <ul className="lib-list">{lib.filter((d) => d.category === 'shared').map((d) => <LibraryItem key={d.type} def={d} canEdit={canEdit} compact={live} />)}</ul>
              {lib.some((d) => d.category === s.content.settings.palette) && (
                <>
                  <h3 className="lib-group">{paletteOf(s.content.settings.palette).label} blocks</h3>
                  <ul className="lib-list">{lib.filter((d) => d.category === s.content.settings.palette).map((d) => <LibraryItem key={d.type} def={d} canEdit={canEdit} compact={live} />)}</ul>
                </>
              )}
            </aside>
            <section className="panel-center" aria-label="Email canvas"><Canvas canEdit={canAny} /></section>
            <aside className="panel-right" aria-label="Properties"><Properties canEdit={canEdit} /></aside>
            {live && <aside className="panel-live" aria-label="Live preview pane"><LivePane campaignId={id} /></aside>}
          </div>
          <DragOverlay>{dragging ? <div className="drag-chip">{activeLabel}</div> : null}</DragOverlay>
        </DndContext>
      )}
      {tab === 'audience' && <div className="tab-body"><AudiencePane campaignId={id} canEdit={canEdit && s.status === 'draft'} onOpenVersion={() => setTab('edit')} onContinue={() => setTab('edit')} /></div>}
      {tab === 'preview' && <div className="tab-body"><PreviewPane campaignId={id} /></div>}
      {tab === 'versions' && <div className="tab-body"><VersionsPane campaignId={id} canEdit={canEdit} onRestored={() => setTab('edit')} /></div>}
    </div>
    </AudienceCtx.Provider>
  );
}
