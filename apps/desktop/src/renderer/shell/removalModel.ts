import type { ProjectManifest, RemovalPlan, RemoveTarget } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge, Res } from '../bridge';

/*
 * Every removal of the window goes through here (delete and start over): the Datasets tree, the
 * Processing drawer, Start over and the library's Empty project trash. The dialog opens on a plan
 * from main; Delete lets go of the layers first (a viewer holding a file makes the move wait),
 * then asks main, then applies the saved manifest and reads runs, jobs and tilesets again.
 */

export interface RemovalPorts {
  bridge: Bridge;
  projectId: () => string | null;
  /**
   * Let go of the layers before their files move: hide, deselect, close a walk's 360 pane. Answers
   * a function that puts back what it changed (called when main refuses or fails).
   */
  release: (layerIds: readonly string[]) => Promise<() => void>;
  applyManifest: (manifest: ProjectManifest) => void;
  /** After a removal: photo runs, jobs and 3D tiles read again. */
  refresh: (plan: RemovalPlan) => void;
}

export interface RemovalUi {
  targets: RemoveTarget[] | null;
  plan: RemovalPlan | null;
  busy: boolean;
  error: string | null;
  /** The open project's trash; null until read. */
  trash: { bytes: number; entries: number } | null;
  /** Entries the last Empty could not delete. */
  held: number;
  /** Bumped after each removal (panels that list runs read again). */
  removed: number;
  ask: (targets: RemoveTarget[]) => Promise<void>;
  cancel: () => void;
  confirm: () => Promise<boolean>;
  /**
   * Remove without the dialog (Start over's old run): null when done, else why not. With the plan
   * that was shown, its layers are released first, and nothing goes when more would go now.
   */
  removeNow: (targets: RemoveTarget[], shown?: RemovalPlan) => Promise<string | null>;
  /** Read a project's trash without touching `trash` (the library menu asks for any project). */
  readTrash: (projectId: string) => Promise<{ bytes: number; entries: number } | null>;
  /** Read the open project's trash into `trash`; a reply for a project no longer open is dropped. */
  loadTrash: (projectId?: string) => Promise<void>;
  /** null when emptied (held entries are in `held`), else why not. */
  emptyTrash: (projectId?: string) => Promise<string | null>;
}

const errorOf = <T extends { ok: boolean; error?: string }>(r: Res<T>): string | null =>
  !r.ok ? r.error : r.value.ok ? null : (r.value.error ?? 'Failed.');

/** Everything `now` takes along was in `shown` (the plan the person saw). */
function within(now: RemovalPlan, shown: RemovalPlan): boolean {
  const ids = (xs: readonly { id: string }[]) => new Set(xs.map((x) => x.id));
  const sub = (a: Iterable<string>, b: ReadonlySet<string>) => [...a].every((x) => b.has(x));
  return (
    sub(ids(now.layers), ids(shown.layers)) &&
    sub(ids(now.runs), ids(shown.runs)) &&
    sub(ids(now.changes), ids(shown.changes)) &&
    sub(now.tilesets, new Set(shown.tilesets)) &&
    sub(now.surfaces, new Set(shown.surfaces)) &&
    sub(now.detections, new Set(shown.detections))
  );
}

export function createRemovalStore(p: RemovalPorts): StoreApi<RemovalUi> {
  return createStore<RemovalUi>()((set, get) => {
    /** The project the open dialog was asked in. */
    let askedIn: string | null = null;
    /** One removal at a time: null when it went through, else why not. Sets and clears `busy`. */
    const run = async (
      targets: RemoveTarget[],
      plan: RemovalPlan | null,
      projectId: string | null,
    ): Promise<string | null> => {
      if (projectId === null) return 'No project is open.';
      if (p.projectId() !== projectId) return 'The project changed.';
      if (plan?.refused !== undefined) return plan.refused;
      const layerIds = plan
        ? plan.layers.map((l) => l.id)
        : targets.flatMap((t) => ('layer' in t ? [t.layer] : []));
      /** Set while main has not answered: a throw then puts the layers back too. */
      let putBack: (() => void) | null = null;
      try {
        putBack = await p.release(layerIds);
        // another project may have been opened while the viewers let go
        if (p.projectId() !== projectId) return 'The project changed.';
        const r = await p.bridge.call('builder:remove', { projectId, targets });
        const back = putBack;
        putBack = null;
        // the files moved in the project asked about; a project opened since has its own manifest
        const same = p.projectId() === projectId;
        if (!r.ok || !r.value.ok) {
          if (same) back();
          return errorOf(r) ?? 'Failed.';
        }
        if (same) {
          p.applyManifest(r.value.manifest);
          p.refresh(r.value.plan);
          set((s) => ({ removed: s.removed + 1 }));
        }
        void get().loadTrash(projectId);
        return null;
      } catch (e) {
        if (putBack && p.projectId() === projectId) putBack();
        return e instanceof Error ? e.message : 'Failed.';
      }
    };
    /** The plan to remove by: the one shown, if nothing more would go now; else why not. */
    const recheck = async (
      targets: RemoveTarget[],
      shown: RemovalPlan,
      projectId: string | null,
    ): Promise<RemovalPlan | string> => {
      if (shown.refused !== undefined) return shown.refused;
      if (projectId === null) return 'No project is open.';
      const r = await p.bridge.call('builder:removePlan', { projectId, targets });
      if (!r.ok || !r.value.ok) return errorOf(r) ?? 'Failed.';
      const now = r.value.plan;
      if (now.refused !== undefined) return now.refused;
      return within(now, shown)
        ? now
        : 'More would go with it now than was shown. Delete it from the Processing drawer.';
    };
    return {
      targets: null,
      plan: null,
      busy: false,
      error: null,
      trash: null,
      held: 0,
      removed: 0,
      ask: async (targets) => {
        if (get().busy) return;
        const projectId = p.projectId();
        askedIn = projectId;
        set({ targets, plan: null, busy: false, error: null });
        if (projectId === null) {
          set({ error: 'No project is open.' });
          return;
        }
        const r = await p.bridge.call('builder:removePlan', { projectId, targets });
        if (get().targets !== targets) return; // closed or asked again meanwhile
        if (r.ok && r.value.ok) set({ plan: r.value.plan });
        else set({ error: errorOf(r) ?? 'Failed.' });
      },
      cancel: () => {
        if (!get().busy) set({ targets: null, plan: null, error: null });
      },
      confirm: async () => {
        const { targets, plan, busy } = get();
        if (busy || targets === null || plan === null || plan.refused !== undefined) return false;
        set({ busy: true, error: null });
        const error = await run(targets, plan, askedIn);
        if (error !== null) {
          set({ busy: false, error });
          return false;
        }
        set({ targets: null, plan: null, busy: false });
        return true;
      },
      removeNow: async (targets, shown) => {
        if (get().busy) return 'Another removal is still running.';
        set({ busy: true });
        try {
          const projectId = p.projectId();
          const plan = shown ? await recheck(targets, shown, projectId) : null;
          if (typeof plan === 'string') return plan;
          return await run(targets, plan, projectId);
        } catch (e) {
          return e instanceof Error ? e.message : 'Failed.';
        } finally {
          set({ busy: false });
        }
      },
      readTrash: async (projectId) => {
        const r = await p.bridge.call('builder:trash', { projectId });
        return r.ok ? r.value : null;
      },
      loadTrash: async (projectId = p.projectId() ?? undefined) => {
        if (projectId === undefined) return;
        const trash = await get().readTrash(projectId);
        // another project's trash (library menu) or a reply after a switch is not the footer's
        if (trash && projectId === p.projectId()) set({ trash });
      },
      emptyTrash: async (projectId = p.projectId() ?? undefined) => {
        if (projectId === undefined) return 'No project is open.';
        const r = await p.bridge.call('builder:emptyTrash', { projectId });
        if (!r.ok || !r.value.ok) return errorOf(r) ?? 'Failed.';
        if (projectId === p.projectId()) set({ held: r.value.held });
        await get().loadTrash(projectId);
        return null;
      },
    };
  });
}
