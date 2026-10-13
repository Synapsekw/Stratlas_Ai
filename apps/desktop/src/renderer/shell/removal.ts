import type { RemovalPlan, RemoveTarget } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { photoUi } from '../photogrammetry/store';
import { bridge, jobs } from '../shell';
import { walks } from '../walks/walks';
import { rasterPacks } from '../workspace/siteTiles';
import { createRemovalStore, type RemovalUi } from './removalModel';

/** How long viewers (the 360 pane above all) get to let go of a file before it moves. */
const RELEASE_MS = 50;

/** After a removal: photo runs, jobs and 3D tiles read again; an open view of a removed run closes. */
export function refreshAfterRemoval(plan: RemovalPlan): void {
  if (plan.runs.length > 0) {
    const view = photoUi.getState().view;
    if (view?.kind === 'run' && plan.runs.some((r) => r.id === view.run)) {
      photoUi.getState().close();
    }
    photoUi.getState().bump();
  }
  if (plan.jobs.length > 0) void jobs.getState().refresh();
  if (plan.tilesets.length > 0) rasterPacks.getState().refresh();
}

export const removal = createRemovalStore({
  bridge,
  projectId: () => workspace.getState().project?.id ?? null,
  release: async (ids) => {
    const ws = workspace.getState();
    const shown = ids.filter((id) => !ws.hidden[id]);
    ws.setLayersVisible(ids, false);
    const sel = ws.selection;
    if (sel && (ids.includes(sel.id) || (sel.layer !== undefined && ids.includes(sel.layer))))
      ws.select(null);
    for (const id of ids) walks.getState().release(id);
    await new Promise((resolve) => setTimeout(resolve, RELEASE_MS));
    return () => {
      // not removed: the layers come back shown and the walks back to the list
      workspace.getState().setLayersVisible(shown, true);
      const now = workspace.getState().project;
      void walks.getState().sync(now?.id ?? null, now?.manifest.layers ?? []);
    };
  },
  applyManifest: (m) => {
    workspace.getState().replaceManifest(m);
  },
  refresh: refreshAfterRemoval,
});

// the trash belongs to the open project: read it again when the project changes
let trashOf: string | null | undefined;
workspace.subscribe((s) => {
  const id = s.project?.id ?? null;
  if (id === trashOf) return;
  trashOf = id;
  removal.setState({ trash: null, held: 0 });
  // a confirm asked in the old project must not act on the new one (a running removal finishes)
  removal.getState().cancel();
  void removal.getState().loadTrash();
});

export function useRemoval<T>(selector: (s: RemovalUi) => T): T {
  return useStore(removal, selector);
}

/** Open the confirm for `targets` (every Delete entry point calls this). */
export function askRemove(targets: RemoveTarget[]): void {
  void removal.getState().ask(targets);
}
