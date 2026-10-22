import { workspace } from '@aio/workspace';
import type { ProjectManifest } from '@aio/schema';
import { useStore } from 'zustand';
import { bridge } from '../shell';
import { createFarNotice, freshLayerIds, type FarNoticeState, type SeenLayers } from './farContent';

export const farNotice = createFarNotice({
  call: async (channel, req) => {
    const r = await bridge.call(channel as 'builder:layerExtents', req as { projectId: string });
    return r.ok ? r.value : { ok: false, error: r.error };
  },
  project: () => workspace.getState().project,
  reopen: (manifest) => {
    const ws = workspace.getState();
    const p = ws.project;
    if (p) ws.openProject({ ...p, manifest: manifest as ProjectManifest }, ws.issues);
  },
});

export function useFarNotice<T>(selector: (s: FarNoticeState) => T): T {
  return useStore(farNotice, selector);
}

/** Layers added to the open project (an import, a finished conversion) are checked for distance. */
export function startFarWatch(): () => void {
  let seen: SeenLayers | null = null;
  let checkedProject: string | null = null;
  const look = () => {
    const p = workspace.getState().project;
    // a notice belongs to the project it was raised for
    const open = farNotice.getState().notice;
    if (open && open.projectId !== p?.id) farNotice.getState().dismiss();
    const next = freshLayerIds(
      seen,
      p ? { id: p.id, layerIds: p.manifest.layers.map((l) => l.id) } : null,
    );
    seen = next.seen;
    if (!p) {
      checkedProject = null;
      return;
    }
    if (next.fresh.size > 0) {
      void farNotice.getState().check(p.id, next.fresh);
      return;
    }
    // the first look at a project is a baseline, so an already-imported photo is checked once
    if (checkedProject === p.id) return;
    checkedProject = p.id;
    void farNotice.getState().check(p.id, next.fresh);
  };
  look();
  // only the open project matters: a clock or selection change returns at once
  return workspace.subscribe((s, prev) => {
    if (s.project !== prev.project) look();
  });
}
