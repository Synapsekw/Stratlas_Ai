import type {
  AioBridge,
  ChangeKind,
  ChangeReview,
  ChangeScope,
  ChangeSet,
  ChangeSetSummary,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  VolumesMissingCode,
} from '@aio/schema';
import { inferChangeScope, VOLUMES_MISSING_CODES } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { IN_APP_KINDS } from './pairs';
import type { ChangePairContext, ChangeProducer } from './producers';
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
  /** The date pair it computes (the panel's, or another: the checks after a new date). */
  pair: { from: string; to: string };
}

/** How a computation ended. */
export type ChangeOutcome = 'done' | 'failed' | 'cancelled';

/** The same date pair. */
export const samePair = (
  a: { from: string; to: string } | null | undefined,
  b: { from: string; to: string } | null | undefined,
): boolean => !!a && !!b && a.from === b.from && a.to === b.to;

export interface Misaligned {
  from: string;
  to: string;
  /** The measured gap in metres. */
  shiftM: number;
  /** The producer that was refused (run again after the line-up). */
  producer: string;
  /** The refused scoped job's parameters, for a replay (never a whole-map run). */
  params?: Record<string, unknown>;
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
  /** The area shown: a scope id; null is the whole map. */
  area: string | null;
  filter: RegisterFilter;
  sort: RegisterSort;
  selected: SelectedItem | null;
  /** "Show changes" in Compare dates: pins and outlines on both views. */
  show: boolean;
  run: ChangeRun | null;
  /** A run the pipeline refused because the two dates sit apart (the panel offers a line-up). */
  misaligned: Misaligned | null;
  error: string | null;
  /** Bumped on every change, for overlays. */
  version: number;
}

export interface ChangeActions {
  /** Read the project's change sets (none: clear). */
  load(projectId: string | null): Promise<void>;
  setPair(pair: { from: string; to: string } | null): void;
  /** Show one area's entry (null: the whole map). */
  setArea(id: string | null): void;
  setFilter(patch: Partial<RegisterFilter>): void;
  setSort(sort: RegisterSort): void;
  select(sel: SelectedItem | null): void;
  setShow(on: boolean): void;
  /** Keep (or clear, with null) a refused run for the panel. */
  setMisaligned(m: Misaligned | null): void;
  /** Show (or clear, with null) an error line in the panel. */
  setError(error: string | null): void;
  /**
   * Run the in-app producers for the panel's pair, or for `pair` (the checks after a new date):
   * a pair the panel does not show leaves its pair, refused run and error line alone. How it
   * ended (`cancelled`: Cancel was pressed), or null when it did not start (another run, no
   * project or pair).
   */
  compute(
    kinds?: readonly ChangeKind[],
    pair?: { from: string; to: string },
  ): Promise<ChangeOutcome | null>;
  /** Cancel the running computation, or the one with `jobId` (still running after a project switch). */
  cancel(jobId?: string): Promise<void>;
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
  area: null,
  filter: {},
  sort: 'verdict',
  selected: null,
  show: false,
  run: null,
  misaligned: null,
  error: null,
  version: 0,
};

let runSeq = 0;
/** Runs the person cancelled, by job id. */
const cancelled = new Set<string>();

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
        const cur = get().pair;
        if (cur && pair?.from === cur.from && pair.to === cur.to) return;
        bump({ pair, area: null, selected: null });
      },
      setArea(id) {
        bump({ area: id, selected: null });
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
      setMisaligned(m) {
        bump({ misaligned: m });
      },
      setError(error) {
        bump({ error });
      },
      async compute(kinds = IN_APP_KINDS, given) {
        const projectId = get().projectId;
        const pair = given ?? get().pair;
        if (!projectId || !pair || get().run) return null;
        // the panel's own pair: its refused run and error line are this run's
        const panel = samePair(pair, get().pair);
        runSeq += 1;
        const jobId = `change-${String(Date.now())}-${String(runSeq)}`;
        bump({
          run: { jobId, phase: 'start', done: 0, total: kinds.length, pair: { ...pair } },
          ...(panel ? { misaligned: null, error: null } : {}),
        });
        const off = bridge()?.on('change:progress', (e) => {
          if (e.jobId === jobId && get().run?.jobId === jobId) bump({ run: { ...e, pair } });
        });
        const r = await call('change:compute', {
          jobId,
          projectId,
          from: pair.from,
          to: pair.to,
          kinds: [...kinds],
        });
        off?.();
        const stopped = cancelled.delete(jobId);
        const outcome: ChangeOutcome = r.ok ? 'done' : stopped ? 'cancelled' : 'failed';
        // the project changed meanwhile (its store was reset, maybe a new run started): this run
        // no longer owns the store's state
        if (get().projectId !== projectId || get().run?.jobId !== jobId) return outcome;
        bump({ run: null, ...(r.ok || !panel ? {} : { error: r.error }) });
        if (r.ok) await get().load(projectId);
        return outcome;
      },
      async cancel(given) {
        const jobId = given ?? get().run?.jobId;
        if (!jobId) return;
        cancelled.add(jobId);
        await call('change:cancel', { jobId });
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

/**
 * Run one producer for a pair, the way the panel's own button does: when it wrote change sets,
 * read the project's sets again. Returns the error sentence, or null when it ran.
 */
export async function runProducer(
  producer: ChangeProducer,
  ctx: ChangePairContext,
): Promise<string | null> {
  const r = await producer.run(ctx);
  if (r.ok && r.ids?.length) await changeStore.getState().load(ctx.projectId);
  return r.ok ? null : r.error;
}

export function useChange<T>(selector: (s: ChangeStore) => T): T {
  return useStore(changeStore, selector);
}

/** The loaded sets of a date pair for one area (null: the whole map). */
export function setsOfPair(
  sets: Readonly<Record<string, ChangeSet>>,
  pair: { from: string; to: string } | null,
  area: string | null = null,
): ChangeSet[] {
  if (!pair) return [];
  // the scope also of a set an older build wrote back without it (`inferChangeScope`)
  return Object.values(sets)
    .filter(
      (s) => s.from === pair.from && s.to === pair.to && (inferChangeScope(s)?.id ?? null) === area,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The distinct areas the pair's sets were limited to, by name then id. */
export function areasOfPair(
  sets: Readonly<Record<string, ChangeSet>>,
  pair: { from: string; to: string } | null,
): ChangeScope[] {
  if (!pair) return [];
  const found = new Map<string, ChangeScope>();
  for (const s of Object.values(sets)) {
    const scope = s.from === pair.from && s.to === pair.to ? inferChangeScope(s) : undefined;
    // a set that kept its scope names the area over one that lost it
    if (scope && (!found.has(scope.id) || s.scope)) found.set(scope.id, scope);
  }
  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

type VolumesMissing = NonNullable<ChangeSet['volumesMissing']>;

/** A stored reason in the person's language: a code is worded here, a sentence shows as it is. */
function volumesWhy(v: VolumesMissing): string {
  const code = (VOLUMES_MISSING_CODES as readonly string[]).includes(v.reason)
    ? (v.reason as VolumesMissingCode)
    : null;
  switch (code) {
    case 'misaligned':
      return t('change.area.why.misaligned', { shift: (v.shiftM ?? 0).toFixed(1) });
    case 'failed':
      return v.detail ?? t('change.area.why.failed');
    case 'unavailable':
      return v.detail ?? t('change.area.why.failed');
    case 'cancelled':
    case 'notStarted':
    case 'packTooOld':
      return t(`change.area.why.${code}`);
    default:
      return v.reason;
  }
}

/**
 * Why an area has no volumes: the note on its imagery set, unless a surface set came in after it.
 * Null for the whole map, or when volumes exist or were never missing.
 */
export function volumesNote(sets: readonly ChangeSet[]): string | null {
  const missing = sets.find((s) => s.producer === 'change.raster')?.volumesMissing;
  if (!missing) return null;
  // volumes from an earlier run are no answer to the latest one
  const after = sets.some((s) => s.producer === 'change.surface' && s.createdAt >= missing.at);
  return after ? null : volumesWhy(missing);
}
