import { create } from 'zustand';
import {
  cloneBlock,
  createInstance,
  validateContent,
  type BlockDefinition,
  type CampaignDto,
  type EmailContent,
  type EmailSettings,
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
        selectedId: prev.blocks.some((b) => b.id === s.selectedId) ? s.selectedId : null,
      });
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({ content: next, past: [...s.past, s.content], future: s.future.slice(1), saveState: 'dirty', lastKey: null });
    },

    addBlock: (def, index) => {
      const { content } = get();
      const inst = createInstance(def);
      const at = index === undefined ? content.blocks.length : Math.max(0, Math.min(index, content.blocks.length));
      const blocks = [...content.blocks.slice(0, at), inst, ...content.blocks.slice(at)];
      commit({ ...content, blocks });
      set({ selectedId: inst.id });
    },

    moveBlock: (from, to) => {
      const { content } = get();
      if (from === to || from < 0 || to < 0 || from >= content.blocks.length || to >= content.blocks.length) return;
      const blocks = [...content.blocks];
      const [b] = blocks.splice(from, 1);
      blocks.splice(to, 0, b!);
      commit({ ...content, blocks });
    },

    duplicateBlock: (id) => {
      const { content } = get();
      const i = content.blocks.findIndex((b) => b.id === id);
      if (i < 0) return;
      const copy = cloneBlock(content.blocks[i]!);
      commit({ ...content, blocks: [...content.blocks.slice(0, i + 1), copy, ...content.blocks.slice(i + 1)] });
      set({ selectedId: copy.id });
    },

    deleteBlock: (id) => {
      const { content, selectedId } = get();
      commit({ ...content, blocks: content.blocks.filter((b) => b.id !== id) });
      if (selectedId === id) set({ selectedId: null });
    },

    setProp: (id, key, value) => {
      const { content } = get();
      commit({ ...content, blocks: content.blocks.map((b) => (b.id === id ? { ...b, props: { ...b.props, [key]: value } } : b)) }, `${id}:${key}`);
    },

    setProps: (id, props) => {
      const { content } = get();
      commit({ ...content, blocks: content.blocks.map((b) => (b.id === id ? { ...b, props } : b)) });
    },

    setSetting: (key, value) => {
      const { content } = get();
      commit({ ...content, settings: { ...content.settings, [key]: value } }, `settings:${key}`);
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
