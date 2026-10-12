import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

const KEY = 'stratlas.datePrompt';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

function parse(raw: string | null | undefined): Record<string, true> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, true> = {};
    for (const [id, done] of Object.entries(v)) if (done === true) out[id] = true;
    return out;
  } catch {
    return {};
  }
}

function browserStorage(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface DatePromptPrefState {
  /** Projects whose one-time filing prompt was answered, on this machine. */
  done: Record<string, true>;
  finish(projectId: string): void;
}

/** Which projects have answered the filing prompt, remembered on this machine. */
export function createDatePromptPref(
  storage: KeyValue | null = browserStorage(),
): StoreApi<DatePromptPrefState> {
  let initial: Record<string, true> = {};
  try {
    initial = parse(storage?.getItem(KEY));
  } catch {
    // blocked storage: start empty
  }
  const store = createStore<DatePromptPrefState>()((set, get) => ({
    done: initial,
    finish: (projectId) => {
      set({ done: { ...get().done, [projectId]: true } });
    },
  }));
  store.subscribe((s) => {
    try {
      storage?.setItem(KEY, JSON.stringify(s.done));
    } catch {
      // private window or blocked storage: the answer is just not remembered
    }
  });
  return store;
}

export const datePromptPref = createDatePromptPref();

/** Whether the open project has answered the prompt. */
export function useDatePromptDone(projectId: string | undefined): boolean {
  return useStore(datePromptPref, (s) => (projectId ? s.done[projectId] === true : false));
}
