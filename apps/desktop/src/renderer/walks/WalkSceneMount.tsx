import type { EngineStage } from '@aio/engine';
import { shiftLocal, unshiftLocal, type DateShift, type ProjectManifest } from '@aio/schema';
import { dateShiftOf, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, Vector3 } from 'three';
import { useStore } from 'zustand';
import { useTimeline } from '../workspace/timeline';
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
import { budgetedGround, drapeRunsInFrames, walkGround, type GroundAt } from './walkGround';
import {
  attachWalkScene,
  DRAPE_LIFT_M,
  previewPoints,
  sceneRuns,
  type WalkSceneInput,
  type WalkSceneMarker,
  type WalkScenePlacing,
  type WalkSceneView,
  type WalkSceneWalk,
} from './walkScene';
import {
  beamHalfRad,
  headingFromBearingDeg,
  shiftHeadingRad,
  walkViews,
  type WalkViewNow,
} from './walkView';

/*
 * The walks in the 3D view: every visible placed walk draped on the ground the view draws
 * (`walkGround.ts`, asked again as layers load, the date on screen changes or the project
 * changes), and the walk being placed on the 3D view with its preview and handles
 * (`walkScene.ts`), fed from the Place walk session.
 */

/** What the 3D view shows of the session: null unless the session places on the 3D view. */
export function scenePlacing(
  s: Pick<PlaceState, 'layerId' | 'step' | 'surface' | 'fit' | 'pins' | 'preview' | 'armed'>,
  colour: string,
  durationS: number,
  shift: DateShift | null = null,
): WalkScenePlacing | null {
  if (s.layerId === null || s.surface?.kind !== '3d') return null;
  const fit = s.pins.length >= 2 ? s.fit : null;
  return {
    walk: fit ? { id: s.layerId, colour, runs: shiftRuns(sceneRuns(fit, durationS), shift) } : null,
    preview: s.preview
      ? {
          pts: previewPoints(s.preview.xz, s.preview.y).map((p) => shiftLocal(p, shift)),
          ghost: s.preview.ghost,
          tooClose: s.preview.tooClose,
        }
      : null,
    handles: sessionHandles(s).map((h) => ({
      id: h.handle,
      at: shiftLocal([h.xz[0], h.y ?? 0, h.xz[1]], shift),
    })),
    clicks: wantsSurfaceClick(s),
  };
}

/** The runs of a walk moved with its survey date. */
function shiftRuns(runs: WalkSceneWalk['runs'], shift: DateShift | null): WalkSceneWalk['runs'] {
  return shift ? runs.map((r) => ({ ...r, pts: r.pts.map((p) => shiftLocal(p, shift)) })) : runs;
}

/** The shift of the walk the session places (null: none, or a walk not on a lined-up date). */
function sessionShift(): DateShift | null {
  const id = placeSession.getState().layerId;
  const m = workspace.getState().project?.manifest;
  return id !== null && m ? dateShiftOf(m, id) : null;
}

/** A pick on the 3D view as model x/z of the walk's own frame (the writer subtracts the shift). */
const picked = (at: [number, number]): [number, number] => {
  const p = unshiftLocal([at[0], 0, at[1]], sessionShift());
  return [p[0], p[2]];
};

/**
 * The height of a pin picked on the 3D view at scene x/z `at`: the ground the walks drape onto,
 * asked near the picked height `y` (a cloud's floor rather than the ortho plane the pick went
 * through to; a roof picked stays the roof), else `y`.
 */
export function pickedHeight(
  at: [number, number],
  y: number,
  ground: GroundAt = (x, z, near) => walkGround.ground(x, z, near),
): number {
  return ground(at[0], at[1], y) ?? y;
}

const INPUT: WalkSceneInput = {
  hover: (at, y) => {
    placeSession
      .getState()
      .hover(at ? picked(at) : null, at && y !== undefined ? pickedHeight(at, y) : y);
  },
  click: (at, y) => {
    placeSession.getState().click(picked(at), pickedHeight(at, y));
  },
  drag: (h, at, y) => {
    placeSession.getState().dragHandle(h, picked(at), pickedHeight(at, y));
  },
  endDrag: () => {
    placeSession.getState().endDrag();
  },
};

/**
 * The placed walks the 3D view draws: visible, not switched off, and not the walk a session is
 * editing (on any surface: its saved spot would disagree with the draft). Points sit at the
 * walk's stored ground (its pins), unlifted: `drapePlaced` moves them onto the drawn ground.
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
      runs: shiftRuns(sceneRuns(w.fit, w.layer.durationS, undefined, 0), w.shift ?? null),
    }));
}

/**
 * How long after a date change, a project edit or a layer switched on or off the ground is asked
 * again (once: visibility follows a date change a moment later).
 */
export const SETTLE_MS = 400;
/** Layers that load close together are answered with one resample this long after the last. */
export const LOADED_SETTLE_MS = 150;
/** Fresh ground asks the Beams may make in one draw; the rest come on the next frames. */
export const BEAM_GROUND_BUDGET = 64;

/** The timers `resampleWhenSettled` runs on (the window's in the app). */
export interface SettleTimers {
  set(cb: () => void, ms: number): number;
  clear(handle: number): void;
}
const windowTimers: SettleTimers = {
  set: (cb, ms) => window.setTimeout(cb, ms),
  clear: (h) => {
    window.clearTimeout(h);
  },
};

/**
 * Ask the ground again (`resample`) once things settle: one pass `SETTLE_MS` from now (the date,
 * the project or a layer's visibility changed), and one `LOADED_SETTLE_MS` after the last of
 * layers that load close together. The returned function stops both.
 */
export function resampleWhenSettled(
  onLayerLoaded: (cb: () => void) => () => void,
  resample: () => void,
  timers: SettleTimers = windowTimers,
): () => void {
  const settle = timers.set(resample, SETTLE_MS);
  let loaded: number | null = null;
  const off = onLayerLoaded(() => {
    if (loaded !== null) timers.clear(loaded);
    loaded = timers.set(resample, LOADED_SETTLE_MS);
  });
  return () => {
    off();
    timers.clear(settle);
    if (loaded !== null) timers.clear(loaded);
  };
}

/**
 * The placed walks moved onto `ground` (lifted `DRAPE_LIFT_M`; the stored height where nothing is
 * drawn), the ground asked over a few frames for long walks; `done` gets them once.
 */
export function drapePlaced(
  placed: readonly WalkSceneWalk[],
  ground: GroundAt,
  done: (walks: WalkSceneWalk[]) => void,
  opts?: Parameters<typeof drapeRunsInFrames>[4],
): () => void {
  const runs = placed.flatMap((w) => w.runs.map((r) => r.pts));
  return drapeRunsInFrames(
    runs,
    ground,
    DRAPE_LIFT_M,
    (draped) => {
      let k = 0;
      done(
        placed.map((w) => ({
          ...w,
          runs: w.runs.map((r) => ({ ...r, pts: draped[k++] ?? r.pts })),
        })),
      );
    },
    opts,
  );
}

/** A brisk walking pace, m/s: how far a walk can reach from where it is placed. */
const WALK_PACE_M_S = 1.5;
/** The reach of a walk being placed is capped here, metres. */
const MAX_PLACE_REACH_M = 5000;
/** `setReach` keys: the walk being placed, and the placed walks drawn faintly. */
const REACH_PLACING = 'walk-placing';
const REACH_PLACED = 'walks-placed';

/**
 * What the camera must be able to back off to see of the walks (`EngineStage.setReach`): their
 * points, and while one is placed a cube of `radiusM` about `centre` (the walk's length, so a
 * walk far longer than a small model can be framed before its first click). Null for nothing.
 */
export function walkReach(
  pts: Iterable<readonly [number, number, number]>,
  centre: Vector3 | null,
  radiusM: number,
): Box3 | null {
  const box = new Box3();
  const p = new Vector3();
  for (const q of pts) box.expandByPoint(p.set(q[0], q[1], q[2]));
  if (centre && radiusM > 0)
    box.union(new Box3(centre.clone().subScalar(radiusM), centre.clone().addScalar(radiusM)));
  return box.isEmpty() ? null : box;
}

/**
 * The reach the placed walks add: only while a walk is placed on the 3D view, so the person can
 * back off to see them; otherwise a placed walk far from a small model would widen the camera
 * cap and push the fog out for good.
 */
export function placedReach(placed: readonly WalkSceneWalk[], placingIn3d: boolean): Box3 | null {
  if (!placingIn3d) return null;
  return walkReach(
    placed.flatMap((w) => w.runs.flatMap((r) => r.pts)),
    null,
    0,
  );
}

const placingPoints = (p: WalkScenePlacing): [number, number, number][] => [
  ...(p.walk?.runs.flatMap((r) => r.pts) ?? []),
  ...(p.preview?.pts ?? []),
  ...p.handles.map((h) => h.at),
];

/**
 * The Beam of every visible placed walk a 360 pane shows (`views`), but the walk being edited:
 * standing on the ground the view draws under its spot (`ground`, else the stored pin height),
 * its cone along the pane's look and as wide as the pane's view, draped on that ground.
 */
export function sceneMarkers(
  fits: readonly SheetWalk[],
  views: Readonly<Record<string, WalkViewNow>>,
  hidden: ReadonlySet<string>,
  editing: string | null,
  colourOf: (w: SheetWalk) => string,
  ground: GroundAt,
): WalkSceneMarker[] {
  const out: WalkSceneMarker[] = [];
  for (const [id, now] of Object.entries(views)) {
    const w = fits.find((f) => f.layer.id === id);
    if (!w || !w.layer.visible || hidden.has(id) || id === editing) continue;
    const a = w.fit.at(now.t);
    if (!a) continue;
    const shift = w.shift ?? null;
    const p = shiftLocal([a.xz[0], a.groundY, a.xz[1]], shift);
    // the spot and its cone are asked near the walk's stored ground: a roof over it is skipped
    const near = p[1];
    // a turned date turns the look and the walk's way with its track
    out.push({
      id,
      colour: colourOf(w),
      at: [p[0], ground(p[0], p[2], near) ?? p[1], p[2]],
      lookHeadingRad:
        now.lookDeg === null ? null : shiftHeadingRad(headingFromBearingDeg(now.lookDeg), shift),
      halfRad: beamHalfRad(now.hfovDeg),
      walkHeadingRad: shiftHeadingRad(a.headingRad, shift),
      ground: (x, z) => ground(x, z, near),
    });
  }
  return out;
}

/** The placing the view shows now: pushed only when it changes from or to something. */
function pushPlacing(
  stage: EngineStage,
  v: WalkSceneView,
  m: ProjectManifest | undefined,
  last: { current: boolean },
): void {
  const s = placeSession.getState();
  // a session on the map or a drawing: the 3D view has nothing of it to show (hovers there
  // would otherwise redraw the 3D view on every move)
  if (s.layerId === null || s.surface?.kind !== '3d') {
    if (last.current) {
      v.setPlacing(null, null);
      stage.setReach(REACH_PLACING, null);
    }
    last.current = false;
    return;
  }
  const layer = m?.layers.find((l) => l.kind === 'walk' && l.id === s.layerId);
  const walk = layer?.kind === 'walk' ? layer : undefined;
  const colour = m && walk ? resolveCssColour(walkColour(m, walk)) : '#ffffff';
  const p = scenePlacing(
    s,
    colour,
    walk?.durationS ?? 0,
    m && walk ? dateShiftOf(m, walk.id) : null,
  );
  v.setPlacing(p, p ? INPUT : null);
  last.current = p !== null;
  // the camera may back off far enough to see the whole walk, however small the model
  const reach = Math.min((walk?.durationS ?? 0) * WALK_PACE_M_S, MAX_PLACE_REACH_M);
  const centre = stage.contentBounds()?.getCenter(new Vector3()) ?? null;
  stage.setReach(REACH_PLACING, p ? walkReach(placingPoints(p), centre, reach) : null);
}

export function WalkSceneMount({ stage }: { stage: EngineStage | null }): null {
  const view = useRef<WalkSceneView | null>(null);
  const shown = useRef(false);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const hidden = useHiddenLayers();
  const { fits } = usePlacedWalkFits();
  const editing = useStore(placeSession, walkBeingEdited);
  const placingIn3d = useStore(placeSession, (s) => s.layerId !== null && s.surface?.kind === '3d');

  useEffect(() => {
    if (!stage) return;
    const v = attachWalkScene(stage);
    view.current = v;
    shown.current = false;
    const push = () => {
      pushPlacing(stage, v, workspace.getState().project?.manifest, shown);
    };
    push();
    const off = placeSession.subscribe(push);
    return () => {
      off();
      stage.setReach(REACH_PLACING, null);
      stage.setReach(REACH_PLACED, null);
      v.dispose();
      view.current = null;
    };
  }, [stage]);

  useEffect(() => {
    const v = view.current;
    if (v && stage) pushPlacing(stage, v, manifest, shown);
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
  // the ground is asked again when layers load, the date on screen changes (visibility follows
  // it a moment later), the project changes (a walk moved) or a layer is switched on or off
  const focus = useTimeline((s) => s.focus);
  const switchedOff = useWorkspace((s) => s.hidden);
  const groundVersion = useStore(walkGround.store, (s) => s.version);
  useEffect(() => {
    if (!stage) return;
    return resampleWhenSettled(
      (cb) => stage.onLayerLoaded(cb),
      () => {
        walkGround.resample();
      },
    );
  }, [stage, focus, manifest, switchedOff]);
  useEffect(() => {
    const v = view.current;
    if (!v || !stage) return;
    return drapePlaced(placed, walkGround.ground, (walks) => {
      v.setPlaced(walks);
    });
  }, [placed, stage, groundVersion]);

  // the Beam of every walk a 360 pane shows (two while comparing), on the ground the view draws;
  // outside React, so a time tick or a drag renders nothing else
  useEffect(() => {
    const v = view.current;
    if (!v || !stage || !manifest) return;
    const colourOf = (w: SheetWalk) => resolveCssColour(walkColour(manifest, w.layer));
    // a draw asks the ground afresh a few dozen times at most: a cone swept onto new ground is
    // finished on the next frames
    let more: number | null = null;
    const draw = () => {
      if (more !== null) cancelAnimationFrame(more);
      more = null;
      const ground = budgetedGround(walkGround, BEAM_GROUND_BUDGET);
      v.setMarkers(sceneMarkers(fits, walkViews.getState(), hidden, editing, colourOf, ground));
      if (ground.starved()) more = requestAnimationFrame(draw);
    };
    draw();
    const offViews = walkViews.subscribe(draw);
    const offLoaded = stage.onLayerLoaded(draw);
    return () => {
      offViews();
      offLoaded();
      if (more !== null) cancelAnimationFrame(more);
      v.setMarkers([]);
    };
  }, [fits, hidden, manifest, editing, stage, groundVersion]);
  useEffect(() => {
    stage?.setReach(REACH_PLACED, placedReach(placed, placingIn3d));
  }, [placed, placingIn3d, stage]);

  return null;
}
