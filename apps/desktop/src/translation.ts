import { useSyncExternalStore } from 'react';
import { mostlyChinese } from './translation-text.ts';
import type { Translatable } from './translation-text.ts';

// The replies' translation into Chinese, made in the desktop's main process with the user's own OpenAI-compatible
// API (see electron/translation.cjs). Absent in a browser: the feature is the desktop client's alone.
export type TranslationSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  // Whether the system's secure storage can keep a key.
  secure: boolean;
};
export type TranslationDraft = { baseUrl?: string; model?: string; key?: string };
type Answer<T> = { value: T; error?: undefined } | { value?: undefined; error: string };
export type Translator = {
  settings: () => Promise<TranslationSettings>;
  save: (
    change: Partial<TranslationDraft & { enabled: boolean }>,
  ) => Promise<Answer<TranslationSettings>>;
  models: (draft?: TranslationDraft) => Promise<Answer<string[]>>;
  test: (draft?: TranslationDraft) => Promise<Answer<{ source: string; text: string; ms: number }>>;
  cached: (text: string) => Promise<string | null>;
  translate: (text: string) => Promise<Answer<string>>;
};
declare global {
  interface Window {
    translator?: Translator;
  }
}
export const translator = () => (typeof window === 'undefined' ? undefined : window.translator);

export type Entry =
  | { status: 'pending' }
  | { status: 'done'; text: string; open: boolean }
  | { status: 'error'; error: string };

let settings: TranslationSettings | null = null;
// Auto translation takes what completes from this moment: the app's start, or when it was switched on.
let autoSince = Date.now();
const entries = new Map<string, Entry>();
// Blocks seen while still being written: once whole they are new, whatever their clock says.
const seenWriting = new Set<string>();
const autoTried = new Set<string>();
const looked = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const configured = (value = settings) => !!value && !!value.baseUrl && value.hasKey;
// The snapshots are the values themselves, each replaced rather than changed, so a render that reads them is redone.
export const useTranslationSettings = () => useSyncExternalStore(subscribe, () => settings);
export const useTranslation = (id: string) =>
  useSyncExternalStore(subscribe, () => entries.get(id));

let loading: Promise<void> | undefined;
export function loadTranslationSettings() {
  const api = translator();
  if (!api) return Promise.resolve();
  loading ??= api.settings().then(
    (value) => {
      settings = value;
      changed();
    },
    () => {
      loading = undefined;
    },
  );
  return loading;
}
export function setTranslationSettings(value: TranslationSettings) {
  if (value.enabled && !settings?.enabled) autoSince = Date.now();
  settings = value;
  changed();
}

export function requestTranslation(id: string, text: string) {
  const api = translator();
  if (!api) return;
  const current = entries.get(id);
  if (current?.status === 'pending') return;
  entries.set(id, { status: 'pending' });
  changed();
  void api.translate(text).then(
    (result) => {
      entries.set(
        id,
        result.error !== undefined
          ? { status: 'error', error: result.error }
          : { status: 'done', text: result.value, open: true },
      );
      changed();
    },
    (error: unknown) => {
      entries.set(id, { status: 'error', error: String((error as Error)?.message ?? error) });
      changed();
    },
  );
}
// A translation made before, from the cache on disk: shown again without a call to the API.
export function lookUpTranslation(id: string, text: string) {
  const api = translator();
  if (!api || looked.has(id) || entries.has(id)) return;
  looked.add(id);
  void api.cached(text).then(
    (found) => {
      if (found && !entries.has(id)) {
        entries.set(id, { status: 'done', text: found, open: true });
        changed();
      }
    },
    () => {},
  );
}
export function toggleTranslation(id: string) {
  const entry = entries.get(id);
  if (entry?.status !== 'done') return;
  entries.set(id, { ...entry, open: !entry.open });
  changed();
}
export const needsTranslation = (text: string) => !!text.trim() && !mostlyChinese(text);

// Called with every block of the open conversation as it changes. A block is translated by itself once whole, while
// auto translation is on, when it is new: seen while it was written, or begun after `autoSince`. History opened later
// is left to its button.
export function autoTranslate(blocks: Translatable[]) {
  if (!translator()) return;
  for (const block of blocks) {
    if (!block.complete) {
      seenWriting.add(block.id);
      continue;
    }
    if (!settings?.enabled || !configured() || autoTried.has(block.id)) continue;
    const fresh = seenWriting.has(block.id) || Date.parse(block.at) >= autoSince - 5_000;
    if (!fresh) continue;
    autoTried.add(block.id);
    if (entries.has(block.id) || !needsTranslation(block.text)) continue;
    requestTranslation(block.id, block.text);
  }
}
