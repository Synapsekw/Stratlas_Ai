import { workspace } from '@aio/workspace';
import type { ProjectManifest } from '@aio/schema';
import { useStore } from 'zustand';
import { bridge } from '../shell';
import { createFarNotice, type FarNoticeState } from './farContent';

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
  let seen: { projectId: string; ids: ReadonlySet<string> } | null = null;
  return workspace.subscribe((s) => {
    const p = s.project;
    if (!p) {
      seen = null;
      return;
    }
    const ids = new Set(p.manifest.layers.map((l) => l.id));
    const before = seen?.projectId === p.id ? seen.ids : null;
    seen = { projectId: p.id, ids };
    if (!before) return; // a project just opened is its own baseline
    const fresh = new Set([...ids].filter((id) => !before.has(id)));
    if (fresh.size > 0) void farNotice.getState().check(p.id, fresh);
  });
}
