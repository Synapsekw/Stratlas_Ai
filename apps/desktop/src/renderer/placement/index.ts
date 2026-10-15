/**
 * The app's placement of findings on a model: the store with the live 3D view, pointcloud and
 * bridge behind it, the offer the review and the Changes panel make, and the issue list's
 * right-click action. `startPlacement` runs once at start-up (bootstrap.ts).
 */
import { cameraSources, issueEditor, setIssueListActions } from '@aio/annotate';
import { getActiveScene } from '@aio/engine';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { bridge } from '../shell';
import { ensureSizes, layerReady, placeOnScene } from './controller';
import {
  createPlacementStore,
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
      return r.ok && r.value.ok ? r.value.path : null;
    },
    ready: (id) => layerReady(workspace, id),
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

/** The issue list's "Place on model..." opens the same offer. Returns a stop function. */
export function startPlacement(): () => void {
  const stopList = setIssueListActions({
    placeOnModel: (ids) => {
      offerPlacement(ids, 'menu');
    },
  });
  return () => {
    stopList();
  };
}

export type { OfferSource, PlacementState, PlaceSummary } from './store';
