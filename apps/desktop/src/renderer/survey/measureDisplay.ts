/**
 * The saved survey measurements on the second 3D view and the second map of a split, drawn only:
 * the tools, the vertex handles and the panels stay with the main view (`MeasureLayer`, which
 * also loads the project's measurements). Each view draws the site-wide measurements and those
 * of the survey date it shows. The linked hover (`hoverScene`) takes part here too: a chart's
 * point shows in both panes and either pane's line drives the chart.
 */
import type { EngineStage } from '@aio/engine';
import type { MapController } from '@aio/maps';
import { useWorkspace, type Workspace } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { attachHover3d, attachHoverMap } from './hoverScene';
import { attach3d, attachMap, frameOf } from './measureScene';

/** Draw the measurements in a 3D view that takes no measuring input (`store`: how it sees the workspace). */
export function useMeasureDisplay3d(stage: EngineStage | null, store: StoreApi<Workspace>): void {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  useEffect(() => {
    if (!stage || !frame) return;
    const detach = attach3d(stage, frame, { display: true, dates: store });
    // the linked hover shows and snaps in both panes of a split (board 11)
    const detachHover = attachHover3d(stage, frame);
    return () => {
      detachHover();
      detach();
    };
  }, [stage, frame, store]);
}

/** Draw the measurements on a map that takes no measuring input. */
export function useMeasureDisplayMap(map: MapController | null, store: StoreApi<Workspace>): void {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  useEffect(() => {
    if (!map || !frame) return;
    // nothing is drawn from this map, so no terrain height is asked of it
    const detach = attachMap(map, frame, () => null, { display: true, dates: store });
    const detachHover = attachHoverMap(map, frame);
    return () => {
      detachHover();
      detach();
    };
  }, [map, frame, store]);
}
