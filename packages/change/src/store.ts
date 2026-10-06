import type {
  AioBridge,
  ChangeKind,
  ChangeReview,
  ChangeSet,
  ChangeSetSummary,
  IpcChannel,
  IpcRequest,
  IpcResponse,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { IN_APP_KINDS } from './pairs';
import { reviewItem, type RegisterFilter, type RegisterSort } from './register';

/**
 * The Changes panel's state: the change sets of the open project, the date pair, the filters,
 * the selected item, "Show changes" and a running computation. Talks to main through
 * `window.aio` (`change:*`).
 */

export interface SelectedItem {
  setId: string;
  itemId: string;
}

export interface ChangeRun {
  jobId: string;
  phase: string;
  done: number;
  total: number;
}

export interface ChangeState {
  projectId: string | null;
  readOnly: boolean;
  summaries: ChangeSetSummary[];
  problems: { name: string; error: string }[];
  /** Loaded sets, by id. */
  sets: Record<string, ChangeSet>;
  /** The date pair the panel shows (capture ids, earlier first). */
  pair: { from: string; to: string } | null;
  filter: RegisterFilter;
  sort: RegisterSort;
  selected: SelectedItem | null;
  /** "Show changes" in Compare dates: pins and outlines on both views. */
  show: boolean;
  run: ChangeRun | null;
  error: string | null;
  /** Bumped on every change, for overlays. */
  version: number;
}

export interface ChangeActions {
  /** Read the project's change sets (none: clear). */
  load(projectId: string | null): Promise<void>;
  setPair(pair: { from: string; to: string } | null): void;
  setFilter(patch: Partial<RegisterFilter>): void;
  setSort(sort: RegisterSort): void;
  select(sel: SelectedItem | null): void;
  setShow(on: boolean): void;
  /** Run the in-app producers for the pair; true when sets were written. */
  compute(kinds?: readonly ChangeKind[]): Promise<boolean>;
  cancel(): Promise<void>;
  /** Save a person's review of one item (null clears it). */
  review(sel: SelectedItem, review: ChangeReview | null): Promise<boolean>;
  /** Replace one set and save it. */
  save(set: ChangeSet): Promise<boolean>;
}

export type ChangeStore = ChangeState & ChangeActions;

const bridge = () => (globalThis as { aio?: AioBridge }).aio;

async function call<C extends IpcChannel>(
  channel: C,
  req: IpcRequest<C>,
): Promise<IpcResponse<C> | { ok: false; error: string }> {
  const aio = bridge();
  if (!aio) return { ok: false, error: 'Not running in the desktop app.' };
  try {
    return await aio.invoke(channel, req);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const initial: ChangeState = {
  projectId: null,
  readOnly: false,
  summaries: [],
  problems: [],
  sets: {},
  pair: null,
  filter: {},
  sort: 'verdict',
  selected: null,
  show: false,
  run: null,
  error: null,
  version: 0,
};

let runSeq = 0;

export function createChangeStore() {
  return createStore<ChangeStore>()((set, get) => {
    const bump = (patch: Partial<ChangeState>) => {
      set({ ...patch, version: get().version + 1 });
    };
    return {
      ...initial,
      async load(projectId) {
        if (projectId !== get().projectId)
          bump({ ...initial, show: get().show, projectId, pair: null });
        if (!projectId) return;
        const list = await call('change:list', { projectId });
        if (get().projectId !== projectId) return;
        if (!list.ok) {
          bump({ error: list.error });
          return;
        }
        const sets: Record<string, ChangeSet> = {};
        for (const s of list.sets) {
          const r = await call('change:read', { projectId, id: s.id });
          if (r.ok) sets[s.id] = r.set;
        }
        if (get().projectId !== projectId) return;
        bump({
          summaries: list.sets,
          problems: list.problems,
          readOnly: list.readOnly,
          sets,
          error: null,
        });
      },
      setPair(pair) {
        bump({ pair, selected: null });
      },
      setFilter(patch) {
        bump({ filter: { ...get().filter, ...patch } });
      },
      setSort(sort) {
        bump({ sort });
      },
      select(sel) {
        bump({ selected: sel });
        if (!sel) return;
        const item = get().sets[sel.setId]?.items.find((i) => i.id === sel.itemId);
        if (item?.at) workspace.getState().flyTo({ kind: 'point', p: item.at, distance: 25 });
        // a model part: select it, so both dates outline it (captureSelection)
        if (item?.kind === 'component' && (item.nodeTo ?? item.nodeFrom)) {
          const layer = item.nodeTo ? item.layerTo : item.layerFrom;
          const id = item.nodeTo ?? item.nodeFrom;
          if (id) workspace.getState().select({ kind: 'asset', id, ...(layer ? { layer } : {}) });
        }
      },
      setShow(on) {
        bump({ show: on });
      },
      async compute(kinds = IN_APP_KINDS) {
        const { projectId, pair } = get();
        if (!projectId || !pair || get().run) return false;
        runSeq += 1;
        const jobId = `change-${String(Date.now())}-${String(runSeq)}`;
        bump({ run: { jobId, phase: 'start', done: 0, total: kinds.length }, error: null });
        const off = bridge()?.on('change:progress', (e) => {
          if (e.jobId === jobId && get().run?.jobId === jobId) bump({ run: { ...e } });
        });
        const r = await call('change:compute', {
          jobId,
          projectId,
          from: pair.from,
          to: pair.to,
          kinds: [...kinds],
        });
        off?.();
        bump({ run: null, ...(r.ok ? {} : { error: r.error }) });
        if (r.ok) await get().load(projectId);
        return r.ok;
      },
      async cancel() {
        const run = get().run;
        if (run) await call('change:cancel', { jobId: run.jobId });
      },
      async review(sel, review) {
        const s = get().sets[sel.setId];
        if (!s) return false;
        return get().save(reviewItem(s, sel.itemId, review));
      },
      async save(next) {
        const { projectId, readOnly } = get();
        if (!projectId) return false;
        if (readOnly) {
          bump({ error: 'This project is a read-only package. Change reviews are not saved.' });
          return false;
        }
        const before = get().sets[next.id];
        bump({ sets: { ...get().sets, [next.id]: next } });
        const r = await call('change:write', { projectId, set: next });
        if (!r.ok) {
          bump({
            error: r.error,
            sets: before ? { ...get().sets, [next.id]: before } : get().sets,
          });
          return false;
        }
        bump({ error: null });
        return true;
      },
    };
  });
}

export const changeStore = createChangeStore();

export function useChange<T>(selector: (s: ChangeStore) => T): T {
  return useStore(changeStore, selector);
}

/** The loaded sets of a date pair. */
export function setsOfPair(
  sets: Readonly<Record<string, ChangeSet>>,
  pair: { from: string; to: string } | null,
): ChangeSet[] {
  if (!pair) return [];
  return Object.values(sets)
    .filter((s) => s.from === pair.from && s.to === pair.to)
    .sort((a, b) => a.id.localeCompare(b.id));
}
