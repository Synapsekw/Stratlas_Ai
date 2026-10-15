/**
 * The app's placement of findings on a model: the store with the live 3D view, pointcloud and
 * bridge behind it, the offer the review and the Changes panel make, and the issue list's
 * right-click action. `startPlacement` runs once at start-up (bootstrap.ts).
 */
import { registerAppHooks } from '@aio/ai';
import { cameraSources, isAnnotateReadOnly, issueEditor, setIssueListActions } from '@aio/annotate';
import { getActiveScene } from '@aio/engine';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { acceptByIds } from '../detections/store';
import { bridge, shell } from '../shell';
import { createPlacementHooks } from './agentHooks';
import { ensureSizes, layerReady, placeOnScene } from './controller';
import {
  createPlacementStore,
  followProject,
  type OfferSource,
  type PlacementDeps,
  type PlacementState,
} from './store';

function liveDeps(): PlacementDeps {
  return {
    workspace,
    editor: issueEditor,
    prepare: (issue) => ensureSizes(workspace, issue),
    place: async (issue, layer) => {
      const h = getActiveScene();
      if (!h) return { ok: false, reason: 'layer-not-loaded' };
      return placeOnScene(issue, layer, h, cameraSources);
    },
    writeSelection: async (projectId, name, data) => {
      // the channel takes bytes over a plain ArrayBuffer (a view of it, no copy, when it is one)
      const bytes =
        data.buffer instanceof ArrayBuffer
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
      const r = await bridge.call('project:writeSelection', { projectId, name, data: bytes });
      if (!r.ok) return { error: r.error };
      return r.value.ok ? { path: r.value.path } : { error: r.value.error };
    },
    ready: (id) => {
      // only the Scene screen mounts a 3D view: placing from the review or the issue list goes there
      const s = shell.getState();
      if (s.screen !== 'scene') s.go('scene');
      return layerReady(workspace, id);
    },
    now: () => new Date().toISOString(),
    newId: () => globalThis.crypto.randomUUID(),
  };
}

export const placement = createPlacementStore(liveDeps());

export function offerPlacement(ids: readonly string[], source: OfferSource): void {
  placement.getState().offerIds(ids, source);
}

export function usePlacement<T>(select: (s: PlacementState) => T): T {
  return useStore(placement, select);
}

/**
 * The issue list's "Place on model..." opens the same offer, and opening another project resets
 * the placement. Returns a stop function.
 */
export function startPlacement(): () => void {
  const stopList = setIssueListActions({
    placeOnModel: (ids) => {
      offerPlacement(ids, 'menu');
    },
  });
  const stopProject = followProject(placement, workspace);
  const stopHooks = registerAppHooks(
    createPlacementHooks({
      workspace,
      placeIds: (ids, layerId) => placement.getState().placeIds(ids, layerId),
      acceptByIds,
      editor: issueEditor,
      readOnly: isAnnotateReadOnly,
      placeError: () => placement.getState().error,
    }),
  );
  return () => {
    stopList();
    stopHooks();
    stopProject();
  };
}

export type { OfferSource, PlacementState, PlaceSummary } from './store';
