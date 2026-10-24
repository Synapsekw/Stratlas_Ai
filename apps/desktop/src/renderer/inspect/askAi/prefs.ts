/**
 * Ask AI's settings on this computer: which AI looks (Auto, Local only, Cloud), the local model and
 * its options, the cloud batch size and where the review queue starts. They live in localStorage
 * (machine-local, like the Detect dialog's mode and model were), each read and write in try/catch,
 * so a browser with no storage still runs on the defaults. The first read takes over the Detect
 * dialog's mode and model. Per project: the last check asked for, and whether the cloud confirm
 * was turned off.
 */
import { DEFAULT_BATCH, MAX_BATCH } from '@aio/ai';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AskCheck } from './checks';

export type AskBackendPref = 'auto' | 'local' | 'cloud';

export interface AskAiPrefs {
  backend: AskBackendPref;
  /** The local model id; null: the first installed. */
  localModel: string | null;
  /** null: the model card's, else 0.25. */
  minConfidence: number | null;
  /** null: the card's input width, and size / 5. */
  tile: { on: boolean; size: number | null; overlap: number | null };
  cloudBatch: number;
  /** The review queue's lowest confidence shown at first. */
  queueThreshold: number;
}

const PREFS_KEY = 'quadrion.askAi.prefs';
const OLD_MODE_KEY = 'stratlas.detect.mode';
const OLD_MODEL_KEY = 'stratlas.detect.model';
const checkKey = (projectId: string) => `quadrion.askAi.check.${projectId}`;
const noConfirmKey = (projectId: string) => `quadrion.askAi.noConfirm.${projectId}`;

const DEFAULTS: AskAiPrefs = {
  backend: 'auto',
  localModel: null,
  minConfidence: null,
  tile: { on: false, size: null, overlap: null },
  cloudBatch: DEFAULT_BATCH,
  queueThreshold: 0,
};

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // a remembered choice is a convenience only
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const unit = (v: unknown): number | null => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
const pixels = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** Stored values of the right kind over the defaults; anything else is dropped. */
function fromStored(v: Record<string, unknown>): AskAiPrefs {
  const tile = isObject(v.tile) ? v.tile : {};
  const backend = v.backend;
  return {
    backend: backend === 'local' || backend === 'cloud' ? backend : 'auto',
    localModel: typeof v.localModel === 'string' && v.localModel ? v.localModel : null,
    minConfidence: unit(v.minConfidence),
    tile: { on: tile.on === true, size: pixels(tile.size), overlap: pixels(tile.overlap) },
    cloudBatch:
      typeof v.cloudBatch === 'number' &&
      Number.isInteger(v.cloudBatch) &&
      v.cloudBatch >= 1 &&
      v.cloudBatch <= MAX_BATCH
        ? v.cloudBatch
        : DEFAULT_BATCH,
    queueThreshold: unit(v.queueThreshold) ?? 0,
  };
}

/** The stored preferences; the first read takes over the Detect dialog's mode and model. */
export function readPrefs(): AskAiPrefs {
  const raw = readStore(PREFS_KEY);
  if (raw !== null) {
    try {
      const v: unknown = JSON.parse(raw);
      if (isObject(v)) return fromStored(v);
    } catch {
      // unreadable: the defaults
    }
    return { ...DEFAULTS };
  }
  const mode = readStore(OLD_MODE_KEY);
  const model = readStore(OLD_MODEL_KEY);
  const prefs: AskAiPrefs = {
    ...DEFAULTS,
    backend:
      mode === 'cloud' ? 'cloud' : mode === 'local' || mode === 'detectors' ? 'local' : 'auto',
    localModel: model !== null && model !== '' ? model : null,
  };
  writeStore(PREFS_KEY, JSON.stringify(prefs));
  return prefs;
}

export const askAiPrefs: StoreApi<AskAiPrefs> = createStore<AskAiPrefs>(() => readPrefs());

export function setAskAiPrefs(p: Partial<AskAiPrefs>): void {
  askAiPrefs.setState(p);
  writeStore(PREFS_KEY, JSON.stringify(askAiPrefs.getState()));
}

export function useAskAiPrefs<T>(sel: (p: AskAiPrefs) => T): T {
  return useStore(askAiPrefs, sel);
}

function isCheck(v: unknown): v is AskCheck {
  if (!isObject(v)) return false;
  if (v.kind === 'everything') return true;
  if (v.kind === 'class') return typeof v.classId === 'string' && v.classId !== '';
  return (
    v.kind === 'detector' &&
    (v.where === 'shipped' || v.where === 'project' || v.where === 'library') &&
    typeof v.id === 'string' &&
    v.id !== ''
  );
}

/** The check last asked for in this project, or null. */
export function lastCheck(projectId: string): AskCheck | null {
  try {
    const v: unknown = JSON.parse(readStore(checkKey(projectId)) ?? 'null');
    return isCheck(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberCheck(projectId: string, c: AskCheck): void {
  writeStore(checkKey(projectId), JSON.stringify(c));
}

/** The person turned the cloud confirm off for this project ("Don't ask again"). */
export function cloudConfirmSkipped(projectId: string): boolean {
  return readStore(noConfirmKey(projectId)) === '1';
}

export function skipCloudConfirm(projectId: string): void {
  writeStore(noConfirmKey(projectId), '1');
}
