import type { EngineStage } from '@aio/engine';
import { layersOfSpace, spacesOf } from '@aio/schema';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { useFlightlineDisplay } from '../flyability/flightlineDisplay';
import {
  clearFlightlines,
  displayColour,
  linesToDraw,
  loadFlightline,
  type FlightlineLayer,
} from '../flyability/flightlineModel';
import { attachFlightlines, type FlightlineView } from '../flyability/flightlineScene';
import { shell, useShell } from '../shell';
import { DEFAULT_SPLIT, sidesOf } from '../workspace/splitModel';
import { useStagePrefs } from '../workspace/stagePrefs';
import { useActiveSpace } from './activeSpace';
import { offSpaceLayers, scopeChange, type SpaceMemory } from './spaceModel';

/*
 * What the open project's active space does to the stage: the other spaces' layers are hidden
 * (the in-memory hidden set only, never a saved `visible`), a space without a map never stays on
 * the map view, and the space's flight lines are drawn in the 3D view.
 */

/** Bumped when the theme changes, so flight lines resolve their `var(--date-N)` colour again. */
function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => {
      setV((n) => n + 1);
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      obs.disconnect();
    };
  }, []);
  return v;
}

export function SpacesMount({ stage }: { stage: EngineStage | null }): null {
  const project = useWorkspace((s) => s.project);
  const openSeq = useWorkspace((s) => s.openSeq);
  const hidden = useWorkspace((s) => s.hidden);
  const { spaceId, mapAvailable } = useActiveSpace();
  const stageMode = useShell((s) => s.stageMode);
  const theme = useThemeVersion();
  const projectId = project?.id ?? null;
  const manifest = project?.manifest;

  // (1) scope the layers to the space once per switch (and once per project opened)
  const last = useRef<{ key: string; space: string; memory: SpaceMemory } | null>(null);
  useEffect(() => {
    const m = workspace.getState().project?.manifest;
    if (!m || projectId === null) {
      last.current = null;
      return;
    }
    const key = `${projectId}:${String(openSeq)}`;
    const prev = last.current?.key === key ? last.current : null;
    if (prev?.space === spaceId) return;
    const cur = workspace.getState().hidden;
    // first scope of a project: every space remembers what is hidden in it now (saved `visible:
    // false`, timeline dates), so what this scope hides in the others is not mistaken for that
    const memory: SpaceMemory = prev?.memory ?? {};
    if (!prev)
      for (const s of spacesOf(m))
        memory[s.id] = layersOfSpace(m, s.id)
          .filter((l) => cur[l.id])
          .map((l) => l.id);
    const r = scopeChange(m, prev?.space ?? null, spaceId, cur, memory);
    last.current = { key, space: spaceId, memory: r.memory };
    // only the changes: an intent that already holds must not re-render everyone
    const show = r.show.filter((id) => cur[id]);
    const hide = r.hide.filter((id) => !cur[id]);
    if (show.length > 0 || hide.length > 0) workspace.getState().applyVisibility(show, hide);
  }, [projectId, openSeq, spaceId]);

  // The invariant behind (1): layers of another space never stay visible, whatever shows them
  // (an import finishing, a timeline date jump). Only the differences go out, so it settles after
  // one pass and never touches the active space.
  useEffect(() => {
    const m = workspace.getState().project?.manifest;
    if (!m) return;
    const cur = workspace.getState().hidden;
    const hide = offSpaceLayers(m, spaceId).filter((id) => !cur[id]);
    if (hide.length > 0) workspace.getState().applyVisibility([], hide);
  }, [manifest, hidden, spaceId]);

  // (2) backstop for the greyed Map and Split (the island and the keys explain them): a stage in
  // the map view, or in a split with a map pane, when a space without a map comes on goes to 3D.
  // A split without the map (a photo or a comparison beside 3D) stays. A georeferenced space has
  // a map, so this never runs for it.
  const splitPref = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.split : undefined));
  const splitHasMap = sidesOf(splitPref ?? DEFAULT_SPLIT, 'map').length > 0;
  useEffect(() => {
    if (mapAvailable) return;
    if (stageMode === 'map' || (stageMode === 'split' && splitHasMap))
      shell.getState().setStageMode('3d');
  }, [mapAvailable, stageMode, splitHasMap]);

  // (3) flight lines of the active space; a project switch forgets what was loaded
  useEffect(() => {
    clearFlightlines();
  }, [projectId, openSeq]);
  const view = useRef<FlightlineView | null>(null);
  // whether the view holds any line: an empty list is not drawn again (no needless render)
  const drawn = useRef(false);
  useEffect(() => {
    if (!stage) return;
    const v = attachFlightlines(stage);
    view.current = v;
    drawn.current = false;
    return () => {
      v.dispose();
      view.current = null;
      drawn.current = false;
    };
  }, [stage]);
  const display = useFlightlineDisplay(projectId);
  // the selected flight (a click on its line, or its row), for "selected flight only"
  const activeId = useWorkspace((s) =>
    s.selection === null ? null : s.selection.kind === 'layer' ? s.selection.id : null,
  );
  // the active space's flight lines and whether each is switched off: the draw ignores the rest
  const lineKey = (manifest?.layers ?? [])
    .filter((l) => l.kind === 'flightline' && (l.space ?? 'main') === spaceId)
    .map((l) => `${l.id}:${hidden[l.id] ? 0 : 1}`)
    .join('|');
  useEffect(() => {
    const v = view.current;
    if (!v || !manifest || projectId === null) return;
    const layers = manifest.layers.filter(
      (l): l is FlightlineLayer => l.kind === 'flightline' && (l.space ?? 'main') === spaceId,
    );
    const off = workspace.getState().hidden;
    const shown = linesToDraw(layers, off, display, activeId);
    if (shown.length === 0) {
      if (drawn.current) v.set([]);
      drawn.current = false;
      return;
    }
    let live = true;
    void Promise.all(
      shown.map(async (l) => ({ l, points: await loadFlightline(projectId, l) })),
    ).then((loaded) => {
      if (!live) return;
      const draws = loaded.flatMap(({ l, points }) =>
        points
          ? [
              {
                id: l.id,
                points,
                colour: displayColour(l, layers.indexOf(l), display),
                visible: true,
                widthPx: display.widthPx,
              },
            ]
          : [],
      );
      if (draws.length === 0 && !drawn.current) return;
      v.set(draws);
      drawn.current = draws.length > 0;
    });
    return () => {
      live = false;
    };
  }, [stage, manifest, projectId, spaceId, lineKey, theme, display, activeId]);

  return null;
}
