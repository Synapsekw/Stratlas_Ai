import type { EngineStage } from '@aio/engine';
import { layersOfSpace, spacesOf } from '@aio/schema';
import { t, toast } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import {
  clearFlightlines,
  flightlineColour,
  loadFlightline,
  type FlightlineLayer,
} from '../flyability/flightlineModel';
import { attachFlightlines, type FlightlineView } from '../flyability/flightlineScene';
import { shell, useShell } from '../shell';
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

  // (2) minimum map guard: a space with its own frame has no map
  useEffect(() => {
    if (mapAvailable || stageMode !== 'map') return;
    shell.getState().setStageMode('3d');
    toast(t('fly.map.local'), { tone: 'info', id: 'fly-map-local' });
  }, [mapAvailable, stageMode]);

  // (3) flight lines of the active space; a project switch forgets what was loaded
  useEffect(() => {
    clearFlightlines();
  }, [projectId, openSeq]);
  const view = useRef<FlightlineView | null>(null);
  useEffect(() => {
    if (!stage) return;
    const v = attachFlightlines(stage);
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
  }, [stage]);
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
    const shown = layers.filter((l) => !off[l.id]);
    if (shown.length === 0) {
      v.set([]);
      return;
    }
    let live = true;
    void Promise.all(
      shown.map(async (l) => ({ l, points: await loadFlightline(projectId, l) })),
    ).then((loaded) => {
      if (!live) return;
      v.set(
        loaded.flatMap(({ l, points }) =>
          points
            ? [
                {
                  id: l.id,
                  points,
                  colour: flightlineColour(l, layers.indexOf(l)),
                  visible: true,
                },
              ]
            : [],
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [stage, manifest, projectId, spaceId, lineKey, theme]);

  return null;
}
