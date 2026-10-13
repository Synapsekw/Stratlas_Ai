import type { EngineStage } from '@aio/engine';
import type { ProjectManifest } from '@aio/schema';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import type { PlaceState } from './placeStore';
import {
  placeSession,
  sessionHandles,
  useHiddenLayers,
  usePlacedWalkFits,
  walkBeingEdited,
  walkColour,
  wantsSurfaceClick,
} from './placeWalk';
import { resolveCssColour } from './walkMapOverlay';
import type { SheetWalk } from './walkOverlay';
import {
  attachWalkScene,
  previewPoints,
  sceneRuns,
  type WalkSceneInput,
  type WalkScenePlacing,
  type WalkSceneView,
  type WalkSceneWalk,
} from './walkScene';

/*
 * The walks in the 3D view: every visible placed walk faintly, and the walk being placed on the
 * 3D view with its preview and handles (`walkScene.ts`), fed from the Place walk session.
 */

/** What the 3D view shows of the session: null unless the session places on the 3D view. */
export function scenePlacing(
  s: Pick<PlaceState, 'layerId' | 'step' | 'surface' | 'fit' | 'pins' | 'preview' | 'armed'>,
  colour: string,
  durationS: number,
): WalkScenePlacing | null {
  if (s.layerId === null || s.surface?.kind !== '3d') return null;
  const fit = s.pins.length >= 2 ? s.fit : null;
  return {
    walk: fit ? { id: s.layerId, colour, runs: sceneRuns(fit, durationS) } : null,
    preview: s.preview
      ? {
          pts: previewPoints(s.preview.xz, s.preview.y),
          ghost: s.preview.ghost,
          tooClose: s.preview.tooClose,
        }
      : null,
    handles: sessionHandles(s).map((h) => ({ id: h.handle, at: [h.xz[0], h.y ?? 0, h.xz[1]] })),
    clicks: wantsSurfaceClick(s),
  };
}

const INPUT: WalkSceneInput = {
  hover: (at, y) => {
    placeSession.getState().hover(at, y);
  },
  click: (at, y) => {
    placeSession.getState().click(at, y);
  },
  drag: (h, at, y) => {
    placeSession.getState().dragHandle(h, at, y);
  },
  endDrag: () => {
    placeSession.getState().endDrag();
  },
};

/**
 * The placed walks the 3D view draws faintly: visible, not switched off, and not the walk a
 * session is editing (on any surface: its saved spot would disagree with the draft).
 */
export function scenePlacedWalks(
  fits: readonly SheetWalk[],
  hidden: ReadonlySet<string>,
  editing: string | null,
  colourOf: (w: SheetWalk) => string,
): WalkSceneWalk[] {
  return fits
    .filter((w) => w.layer.visible && !hidden.has(w.layer.id) && w.layer.id !== editing)
    .map((w) => ({
      id: w.layer.id,
      colour: colourOf(w),
      runs: sceneRuns(w.fit, w.layer.durationS),
    }));
}

/** The placing the view shows now: pushed only when it changes from or to something. */
function pushPlacing(
  v: WalkSceneView,
  m: ProjectManifest | undefined,
  last: { current: boolean },
): void {
  const s = placeSession.getState();
  // a session on the map or a drawing: the 3D view has nothing of it to show (hovers there
  // would otherwise redraw the 3D view on every move)
  if (s.layerId === null || s.surface?.kind !== '3d') {
    if (last.current) v.setPlacing(null, null);
    last.current = false;
    return;
  }
  const layer = m?.layers.find((l) => l.kind === 'walk' && l.id === s.layerId);
  const walk = layer?.kind === 'walk' ? layer : undefined;
  const colour = m && walk ? resolveCssColour(walkColour(m, walk)) : '#ffffff';
  const p = scenePlacing(s, colour, walk?.durationS ?? 0);
  v.setPlacing(p, p ? INPUT : null);
  last.current = p !== null;
}

export function WalkSceneMount({ stage }: { stage: EngineStage | null }): null {
  const view = useRef<WalkSceneView | null>(null);
  const shown = useRef(false);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const hidden = useHiddenLayers();
  const { fits } = usePlacedWalkFits();
  const editing = useStore(placeSession, walkBeingEdited);

  useEffect(() => {
    if (!stage) return;
    const v = attachWalkScene(stage);
    view.current = v;
    shown.current = false;
    const push = () => {
      pushPlacing(v, workspace.getState().project?.manifest, shown);
    };
    push();
    const off = placeSession.subscribe(push);
    return () => {
      off();
      v.dispose();
      view.current = null;
    };
  }, [stage]);

  useEffect(() => {
    const v = view.current;
    if (v) pushPlacing(v, manifest, shown);
  }, [manifest, stage]);

  const placed = useMemo(
    () =>
      manifest
        ? scenePlacedWalks(fits, hidden, editing, (w) =>
            resolveCssColour(walkColour(manifest, w.layer)),
          )
        : [],
    [fits, hidden, manifest, editing],
  );
  useEffect(() => {
    view.current?.setPlaced(placed);
  }, [placed, stage]);

  return null;
}
