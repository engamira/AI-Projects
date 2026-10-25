import { create } from 'zustand';
import {
  MAX_VARIANTS,
  cloneBlock,
  createInstance,
  newVariant,
  validateContent,
  versionOf,
  type BlockDefinition,
  type CampaignDto,
  type EmailContent,
  type EmailSettings,
  type EmailVersion,
  type ConditionGroup,
  type Versioning,
  type PropValue,
  type SaveDraftResponse,
} from '@cl/shared';
import { api, ApiError } from '../api';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'invalid' | 'conflict';

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1000; // typing in the same field within a second is one undo step

type EditorState = {
  campaignId: string | null;
  status: string;
  name: string;
  content: EmailContent;
  /** The version being edited: null = the Default, otherwise the id of a segment version. */
  editing: string | null;
  /** A segment made by block rules whose view of the language email is being shown (blocks it does not see are dimmed). */
  focus: { code: string; contact: Record<string, string | number | boolean | null> } | null;
  version: number;
  past: EmailContent[];
  future: EmailContent[];
  selectedId: string | null;
  saveState: SaveState;
  message: string;
  lastKey: string | null;
  lastKeyAt: number;

  load: (dto: CampaignDto) => void;
  setName: (name: string) => void;
  select: (id: string | null) => void;
  /** Switch between the Default version and a segment's version. */
  setEditing: (variantId: string | null) => void;
  /** Creates a version for a segment as a copy of the Default (or of another version) and starts editing it. */
  addVariant: (fields: string[], values: (string | number | boolean | null)[], copyFrom: string | null) => string | null;
  removeVariant: (id: string) => void;
  /** Creates the default email for one language (it holds every block any segment of that language needs). */
  addLanguageVersion: (languageField: string, value: string, copyFrom: string | null) => string | null;
  /** How this campaign builds versions, and which field holds the language. */
  setVersioning: (v: Versioning) => void;
  setFocus: (focus: EditorState['focus']) => void;
  /** Sends a segment the email of a version (or the Default), or back to the automatic choice (null). */
  setRoute: (segmentKey: string, target: string | null) => void;
  /** Shows a block only to contacts who meet the condition (null = everyone). */
  setShowWhen: (blockId: string, condition: ConditionGroup | null) => void;
  /** Copies one block into every other version (replacing the block with the same identity, or adding it at the same place). */
  copyBlockToOthers: (id: string) => void;
  undo: () => void;
  redo: () => void;
  addBlock: (def: BlockDefinition, index?: number) => void;
  moveBlock: (from: number, to: number) => void;
  duplicateBlock: (id: string) => void;
  deleteBlock: (id: string) => void;
  setProp: (id: string, key: string, value: PropValue) => void;
  /** Replaces several properties of one block as a single undo step (used by ready-made content). */
  setProps: (id: string, props: Record<string, PropValue>) => void;
  setSetting: <K extends keyof EmailSettings>(key: K, value: EmailSettings[K]) => void;
  save: () => Promise<void>;
};

/** Applies a change to the version being edited (the Default or one segment's version) and leaves the rest alone. */
function change(content: EmailContent, editing: string | null, f: (d: EmailVersion) => EmailVersion): EmailContent {
  if (editing && content.variants?.some((v) => v.id === editing)) {
    return { ...content, variants: content.variants.map((v) => (v.id === editing ? { ...v, ...f(v) } : v)) };
  }
  return { ...content, ...f(content) };
}

const emptyDoc = (): EmailContent => ({
  schemaVersion: 1,
  settings: { subject: '', preheader: '', senderName: '', senderEmail: '', replyTo: '', palette: 'travel', contentWidth: 600, fontFamily: 'Arial, Helvetica, sans-serif' },
  blocks: [],
});

export const useEditor = create<EditorState>((set, get) => {
  let running: Promise<void> | null = null;
  /** Applies a change as one undo step (or merges it with the previous step when `key` repeats quickly). */
  function commit(next: EmailContent, key?: string) {
    const s = get();
    const now = Date.now();
    const merge = !!key && key === s.lastKey && now - s.lastKeyAt < COALESCE_MS && s.past.length > 0;
    set({
      content: next,
      past: merge ? s.past : [...s.past, s.content].slice(-HISTORY_LIMIT),
      future: [],
      saveState: 'dirty',
      message: '',
      lastKey: key ?? null,
      lastKeyAt: now,
    });
  }

  return {
    campaignId: null,
    status: 'draft',
    name: '',
    content: emptyDoc(),
    editing: null,
    focus: null,
    version: 0,
    past: [],
    future: [],
    selectedId: null,
    saveState: 'saved',
    message: '',
    lastKey: null,
    lastKeyAt: 0,

    load: (dto) =>
      set({
        campaignId: dto.id,
        status: dto.status,
        name: dto.name,
        content: dto.draft.content,
        editing: null,
        focus: null,
        version: dto.draft.version,
        past: [],
        future: [],
        selectedId: null,
        saveState: 'saved',
        message: '',
        lastKey: null,
      }),

    setName: (name) => set({ name }),
    select: (id) => set({ selectedId: id }),

    setEditing: (variantId) => set({ editing: variantId, focus: null, selectedId: null }),
    setFocus: (focus) => set({ focus }),

    addVariant: (fields, values, copyFrom) => {
      const { content } = get();
      if ((content.variants?.length ?? 0) >= MAX_VARIANTS) return null;
      const v = newVariant(versionOf(content, copyFrom), fields, values);
      if (content.variants?.some((x) => x.key === v.key)) return null;
      commit({ ...content, variants: [...(content.variants ?? []), v] });
      set({ editing: v.id, selectedId: null });
      return v.id;
    },

    addLanguageVersion: (languageField, value, copyFrom) => {
      const { content } = get();
      if ((content.variants?.length ?? 0) >= MAX_VARIANTS) return null;
      const v = newVariant(versionOf(content, copyFrom), [languageField], [value], 'language');
      if (content.variants?.some((x) => x.key === v.key && x.kind === 'language')) return null;
      commit({ ...content, variants: [...(content.variants ?? []), v] });
      set({ editing: v.id, selectedId: null });
      return v.id;
    },

    setVersioning: (v) => {
      const { content } = get();
      commit({ ...content, versioning: v });
    },

    setRoute: (key, target) => {
      const { content } = get();
      const routes = { ...(content.versioning?.routes ?? {}) };
      if (target) routes[key] = target; else delete routes[key];
      const base = content.versioning ?? { mode: 'copies' as const };
      const { routes: _old, ...rest } = base;
      commit({ ...content, versioning: Object.keys(routes).length ? { ...rest, routes } : rest });
    },

    setShowWhen: (blockId, condition) => {
      const { content, editing } = get();
      commit(change(content, editing, (d) => ({
        ...d,
        blocks: d.blocks.map((b) => {
          if (b.id !== blockId) return b;
          const { showWhen: _old, ...rest } = b;
          return condition ? { ...rest, showWhen: condition } : rest;
        }),
      })), `${editing ?? ''}:${blockId}:showWhen`);
    },

    removeVariant: (id) => {
      const { content, editing } = get();
      const rest = (content.variants ?? []).filter((v) => v.id !== id);
      const next = { ...content } as EmailContent;
      if (rest.length) next.variants = rest; else delete next.variants;
      if (next.versioning?.routes) {
        const routes = Object.fromEntries(Object.entries(next.versioning.routes).filter(([, target]) => target !== id));
        const { routes: _r, ...others } = next.versioning;
        next.versioning = Object.keys(routes).length ? { ...others, routes } : others;
      }
      commit(next);
      if (editing === id) set({ editing: null, selectedId: null });
    },

    copyBlockToOthers: (id) => {
      const { content, editing } = get();
      const src = versionOf(content, editing).blocks;
      const at = src.findIndex((b) => b.id === id);
      if (at < 0) return;
      const block = src[at]!;
      const into = (d: EmailVersion): EmailVersion => {
        const copy = JSON.parse(JSON.stringify(block)) as typeof block;
        const i = d.blocks.findIndex((b) => b.id === id);
        const blocks = i >= 0 ? d.blocks.map((b, k) => (k === i ? copy : b)) : [...d.blocks.slice(0, at), copy, ...d.blocks.slice(at)];
        return { ...d, blocks };
      };
      const next: EmailContent = { ...content };
      if (editing !== null) Object.assign(next, into(content));
      if (content.variants) next.variants = content.variants.map((v) => (v.id === editing ? v : { ...v, ...into(v) }));
      commit(next);
    },

    undo: () => {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      set({
        content: prev,
        past: s.past.slice(0, -1),
        future: [s.content, ...s.future],
        saveState: 'dirty',
        lastKey: null,
        editing: s.editing && prev.variants?.some((v) => v.id === s.editing) ? s.editing : null,
        selectedId: versionOf(prev, s.editing).blocks.some((b) => b.id === s.selectedId) ? s.selectedId : null,
      });
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({ content: next, past: [...s.past, s.content], future: s.future.slice(1), saveState: 'dirty', lastKey: null, editing: s.editing && next.variants?.some((v) => v.id === s.editing) ? s.editing : null });
    },

    addBlock: (def, index) => {
      const { content, editing } = get();
      const inst = createInstance(def);
      const cur = versionOf(content, editing);
      const at = index === undefined ? cur.blocks.length : Math.max(0, Math.min(index, cur.blocks.length));
      commit(change(content, editing, (d) => ({ ...d, blocks: [...d.blocks.slice(0, at), inst, ...d.blocks.slice(at)] })));
      set({ selectedId: inst.id });
    },

    moveBlock: (from, to) => {
      const { content, editing } = get();
      const n = versionOf(content, editing).blocks.length;
      if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
      commit(change(content, editing, (d) => {
        const blocks = [...d.blocks];
        const [b] = blocks.splice(from, 1);
        blocks.splice(to, 0, b!);
        return { ...d, blocks };
      }));
    },

    duplicateBlock: (id) => {
      const { content, editing } = get();
      const i = versionOf(content, editing).blocks.findIndex((b) => b.id === id);
      if (i < 0) return;
      const copy = cloneBlock(versionOf(content, editing).blocks[i]!);
      commit(change(content, editing, (d) => ({ ...d, blocks: [...d.blocks.slice(0, i + 1), copy, ...d.blocks.slice(i + 1)] })));
      set({ selectedId: copy.id });
    },

    deleteBlock: (id) => {
      const { content, editing, selectedId } = get();
      commit(change(content, editing, (d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) })));
      if (selectedId === id) set({ selectedId: null });
    },

    setProp: (id, key, value) => {
      const { content, editing } = get();
      commit(change(content, editing, (d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === id ? { ...b, props: { ...b.props, [key]: value } } : b)) })), `${editing ?? ''}:${id}:${key}`);
    },

    setProps: (id, props) => {
      const { content, editing } = get();
      commit(change(content, editing, (d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === id ? { ...b, props } : b)) })));
    },

    setSetting: (key, value) => {
      const { content, editing } = get();
      commit(change(content, editing, (d) => ({ ...d, settings: { ...d.settings, [key]: value } })), `${editing ?? ''}:settings:${key}`);
    },

    save: () => {
      // One save at a time. A second request with the same base version would be refused as a conflict, so
      // edits made while a save is in flight are saved right after it finishes (the loop below).
      if (running) return running;
      running = (async () => {
        for (let i = 0; i < 5; i++) {
          await saveOnce();
          if (get().saveState !== 'dirty') break;
        }
      })().finally(() => { running = null; });
      return running;
    },
  };

  async function saveOnce(): Promise<void> {
    const s = get();
    if (!s.campaignId || s.saveState === 'conflict') return;
    const sent = s.content;
    const check = validateContent(sent);
    if (!check.ok) {
      set({ saveState: 'invalid', message: check.error });
      return;
    }
    set({ saveState: 'saving', message: '' });
    try {
      const r = await api<SaveDraftResponse>('PUT', `/api/campaigns/${s.campaignId}/draft`, { content: sent, baseVersion: s.version });
      // If the user kept editing while this request was in flight, stay "dirty" so the newer content is saved next.
      set((cur) => ({ version: r.version, saveState: cur.content === sent ? 'saved' : 'dirty' }));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') set({ saveState: 'conflict', message: e.message });
      else if (e instanceof ApiError && e.status === 400) set({ saveState: 'invalid', message: e.message });
      else set({ saveState: 'error', message: 'Could not save. Check your connection; we will keep trying.' });
    }
  }
});

/** Saves now if there are unsaved changes (used before previewing, saving a version or restoring). */
export async function flushSave(): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const s = useEditor.getState();
    if (s.saveState === 'saved') return true;
    if (s.saveState === 'conflict' || s.saveState === 'invalid') return false;
    await s.save(); // joins a save already in progress, or starts one
  }
  return useEditor.getState().saveState === 'saved';
}
