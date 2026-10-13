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
  /** Remove without the dialog (Start over's old run): null when done, else why not. */
  removeNow: (targets: RemoveTarget[]) => Promise<string | null>;
  loadTrash: (projectId?: string) => Promise<void>;
  /** null when emptied (held entries are in `held`), else why not. */
  emptyTrash: (projectId?: string) => Promise<string | null>;
}

const errorOf = <T extends { ok: boolean; error?: string }>(r: Res<T>): string | null =>
  !r.ok ? r.error : r.value.ok ? null : (r.value.error ?? 'Failed.');

export function createRemovalStore(p: RemovalPorts): StoreApi<RemovalUi> {
  return createStore<RemovalUi>()((set, get) => {
    const run = async (
      targets: RemoveTarget[],
      plan: RemovalPlan | null,
    ): Promise<string | null> => {
      const projectId = p.projectId();
      if (projectId === null) return 'No project is open.';
      if (plan?.refused !== undefined) return plan.refused;
      const layerIds = plan
        ? plan.layers.map((l) => l.id)
        : targets.flatMap((t) => ('layer' in t ? [t.layer] : []));
      const putBack = await p.release(layerIds);
      const r = await p.bridge.call('builder:remove', { projectId, targets });
      if (!r.ok || !r.value.ok) {
        putBack();
        return errorOf(r) ?? 'Failed.';
      }
      p.applyManifest(r.value.manifest);
      p.refresh(r.value.plan);
      set((s) => ({ removed: s.removed + 1 }));
      void get().loadTrash(projectId);
      return null;
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
        const projectId = p.projectId();
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
        const { targets, plan } = get();
        if (targets === null || plan === null || plan.refused !== undefined) return false;
        set({ busy: true, error: null });
        const error = await run(targets, plan);
        if (error !== null) {
          set({ busy: false, error });
          return false;
        }
        set({ targets: null, plan: null, busy: false });
        return true;
      },
      removeNow: (targets) => run(targets, null),
      loadTrash: async (projectId = p.projectId() ?? undefined) => {
        if (projectId === undefined) return;
        const r = await p.bridge.call('builder:trash', { projectId });
        if (r.ok) set({ trash: r.value });
      },
      emptyTrash: async (projectId = p.projectId() ?? undefined) => {
        if (projectId === undefined) return 'No project is open.';
        const r = await p.bridge.call('builder:emptyTrash', { projectId });
        if (!r.ok || !r.value.ok) return errorOf(r) ?? 'Failed.';
        set({ held: r.value.held });
        await get().loadTrash(projectId);
        return null;
      },
    };
  });
}
