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
import { walkCompare } from './walkCompare';
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
import { headingFromBearingDeg, walkMarkerStyle, walkViews } from './walkView';

/*
 * The walks in the 3D view: every visible placed walk faintly, and the walk being placed on the
 * 3D view with its preview and handles (`walkScene.ts`), fed from the Place walk session.
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

const INPUT: WalkSceneInput = {
  hover: (at, y) => {
    placeSession.getState().hover(at ? picked(at) : null, y);
  },
  click: (at, y) => {
    placeSession.getState().click(picked(at), y);
  },
  drag: (h, at, y) => {
    placeSession.getState().dragHandle(h, picked(at), y);
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
      runs: shiftRuns(sceneRuns(w.fit, w.layer.durationS), w.shift ?? null),
    }));
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

// ---------------------------------------------------------------- SPIKE: the walk on the ground

/** Draped points sit this far over the ground (the lines also pull towards the camera). */
const LIFT_PLACED = DRAPE_LIFT_M;
/** The ground is asked about every this many metres along a walk, heights between interpolated. */
const DRAPE_STEP_M = 1;

/**
 * The ground the 3D view draws under scene x/z, or null where nothing is drawn: the DSM straight
 * down first, then the ground imagery (ortho, street map drape), then the top of the visible
 * models and clouds. Only visible layers count (the stage skips hidden ones).
 */
export function sceneGround(
  stage: Pick<EngineStage, 'raycastRay'>,
  m: Pick<ProjectManifest, 'layers'>,
): (x: number, z: number) => number | null {
  const tiers: string[][] = [[], [], []];
  for (const l of m.layers) {
    if (l.kind === 'raster') (l.role === 'dsm' ? tiers[0] : tiers[1])?.push(l.id);
    else if (l.kind === 'basemap') tiers[1]?.push(l.id);
    else if (l.kind === 'mesh' || l.kind === 'pointcloud') tiers[2]?.push(l.id);
  }
  const from = new Vector3();
  const down = new Vector3(0, -1, 0);
  return (x, z) => {
    for (const ids of tiers) {
      let top: number | null = null;
      for (const id of ids) {
        const hit = stage.raycastRay(from.set(x, 20_000, z), down, { layer: id });
        if (hit && (top === null || hit.point.y > top)) top = hit.point.y;
      }
      if (top !== null) return top;
    }
    return null;
  };
}

/**
 * A run of walk points (y: the walk's stored ground plus `lift`) moved onto `ground`, asked every
 * `DRAPE_STEP_M` along the run and interpolated between; where the ground answers nothing the
 * stored height stays.
 */
export function drapePoints(
  pts: readonly [number, number, number][],
  ground: (x: number, z: number) => number | null,
  lift: number,
): [number, number, number][] {
  const n = pts.length;
  if (n === 0) return [];
  const stored = pts.map((p) => p[1] - LIFT_M_STORED);
  // stations: indices where the ground is asked (the first, every step, the last)
  const at: { i: number; y: number }[] = [];
  let run = Infinity;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[i - 1];
    if (!p) continue;
    if (q) run += Math.hypot(p[0] - q[0], p[2] - q[2]);
    if (run >= DRAPE_STEP_M || i === n - 1) {
      at.push({ i, y: ground(p[0], p[2]) ?? stored[i] ?? 0 });
      run = 0;
    }
  }
  const out: [number, number, number][] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!p) continue;
    while (k < at.length - 1 && (at[k + 1]?.i ?? n) < i) k++;
    const a = at[k];
    const b = at[k + 1] ?? a;
    let y = a?.y ?? stored[i] ?? 0;
    if (a && b && b.i > a.i && i >= a.i) y = a.y + ((b.y - a.y) * (i - a.i)) / (b.i - a.i);
    out.push([p[0], y + lift, p[2]]);
  }
  return out;
}
/** The lift `sceneRuns` put on the stored heights (taken off again before draping). */
const LIFT_M_STORED = 0.1;

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
  // SPIKE: the placed walks follow the ground drawn under them (DSM, then the imagery, then
  // models and clouds), asked again as layers load or the date on screen changes
  const focus = useTimeline((s) => s.focus);
  useEffect(() => {
    const v = view.current;
    if (!v || !stage) return;
    const drape = () => {
      const m = workspace.getState().project?.manifest;
      const ground = m ? sceneGround(stage, m) : () => null;
      v.setPlaced(
        placed.map((w) => ({
          ...w,
          runs: w.runs.map((r) => ({ ...r, pts: drapePoints(r.pts, ground, LIFT_PLACED) })),
        })),
      );
    };
    drape();
    // visibility follows the date a moment later: look again once it has settled
    const again = window.setTimeout(drape, 400);
    let pending = 0;
    const off = stage.onLayerLoaded(() => {
      window.clearTimeout(pending);
      pending = window.setTimeout(drape, 150);
    });
    return () => {
      off();
      window.clearTimeout(again);
      window.clearTimeout(pending);
    };
  }, [placed, stage, focus]);

  // SPIKE: a marker with its view cone for every walk a 360 pane shows (two while comparing)
  useEffect(() => {
    const v = view.current;
    if (!v || !stage || !manifest) return;
    const draw = () => {
      const style = walkMarkerStyle.getState().style;
      const far = walkCompare.getState().far;
      const ground = sceneGround(stage, manifest);
      const out: WalkSceneMarker[] = [];
      for (const [id, now] of Object.entries(walkViews.getState())) {
        const w = fits.find((f) => f.layer.id === id);
        if (!w || !w.layer.visible || hidden.has(id) || id === editing) continue;
        const a = w.fit.at(now.t);
        if (!a) continue;
        const p = shiftLocal([a.xz[0], a.groundY, a.xz[1]], w.shift ?? null);
        out.push({
          id,
          colour: resolveCssColour(walkColour(manifest, w.layer)),
          at: [p[0], ground(p[0], p[2]) ?? p[1], p[2]],
          lookHeadingRad: now.lookDeg === null ? null : headingFromBearingDeg(now.lookDeg),
          halfRad: (Math.min(170, Math.max(5, now.hfovDeg)) * Math.PI) / 360,
          walkHeadingRad: a.headingRad,
          style,
          dim: far === id,
        });
      }
      v.setMarkers(out);
    };
    draw();
    const offViews = walkViews.subscribe(draw);
    const offStyle = walkMarkerStyle.subscribe(draw);
    const offCompare = walkCompare.subscribe(draw);
    const offLoaded = stage.onLayerLoaded(draw);
    return () => {
      offViews();
      offStyle();
      offCompare();
      offLoaded();
      v.setMarkers([]);
    };
  }, [fits, hidden, manifest, editing, stage, focus]);
  useEffect(() => {
    stage?.setReach(REACH_PLACED, placedReach(placed, placingIn3d));
  }, [placed, placingIn3d, stage]);

  return null;
}
