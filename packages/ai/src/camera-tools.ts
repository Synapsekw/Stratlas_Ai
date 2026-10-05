/**
 * Camera tools for the agent: find_places, fly_to, set_view, orbit, zoom, look_at, frame_all.
 * Every move becomes one camera request on the workspace (a target point, a direction and a
 * distance), which the 3D stage flies to whether or not it has focus or shares a split, and which
 * the map follows (it pans and zooms). Each move answers with where the camera is now in the
 * person's terms (place, easting and northing, height) and can be undone.
 */
import { fitDistance, headingDeg, isEngineStage } from '@aio/engine';
import type { Vec3 } from '@aio/schema';
import { Frustum, Matrix4, Quaternion, Vector3 } from 'three';
import { assetUrl } from '@aio/workspace';
import { parseFlight } from './geometry';
import {
  boxCentre,
  describePoint,
  measure,
  placeIndex,
  resolveTarget,
  round,
  searchPlaces,
  targetPoint,
  words,
  type Place,
  type PlaceBox,
  type Resolved,
} from './places';
import { define, project, ToolError, type RendererToolContext } from './tool-kit';
import type { ViewDirection } from './tools';

/** Camera position and orbit target, local frame. */
export interface Pose {
  position: Vec3;
  target: Vec3;
}

const DEG = Math.PI / 180;
const HOME_MARGIN = 1.05;
const FIT_MARGIN = 1.25;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 1];
};

/** The camera now: the live stage, else the last camera request, else null. */
export function currentPose(ctx: RendererToolContext): Pose | null {
  const s = ctx.scene();
  if (s && isEngineStage(s)) {
    const v = s.saveView();
    return { position: v.position, target: v.target };
  }
  if (s) {
    const fwd = new Vector3(0, 0, -1).applyQuaternion(s.camera.quaternion);
    const pos = s.camera.position;
    return { position: pos.toArray(), target: pos.clone().addScaledVector(fwd, 50).toArray() };
  }
  const last = ctx.workspace.getState().lastCamera?.target;
  if (last?.kind === 'point') {
    const d = last.distance ?? 100;
    return { target: last.p, position: add(last.p, scale(unit(last.dir ?? [1, 1, 1]), d)) };
  }
  return null;
}

function lens(ctx: RendererToolContext): { fov: number; aspect: number } {
  const cam = ctx.scene()?.camera;
  return { fov: cam?.fov ?? 40, aspect: cam && cam.aspect > 0 ? cam.aspect : 16 / 9 };
}

const radiusOf = (b: PlaceBox) => len(sub(b.max, b.min)) / 2;

/** What the 3D view frames on Home: the visible content, else the places with a position. */
export function siteBox(ctx: RendererToolContext): PlaceBox | null {
  const s = ctx.scene();
  if (s && isEngineStage(s)) {
    const b = s.contentBounds();
    if (b) return { min: b.min.toArray(), max: b.max.toArray() };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of placeIndex(ctx)) {
    if (p.kind !== 'layer' || !p.box) continue;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] ?? 0, p.box.min[i] ?? 0);
      max[i] = Math.max(max[i] ?? 0, p.box.max[i] ?? 0);
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** Unit vector from the target to the camera for a side ("north": the camera north of it). */
export function viewDirection(view: ViewDirection | 'iso', current: Pose | null): Vec3 {
  const el = 25 * DEG;
  switch (view) {
    case 'top':
      // a hair south of straight down keeps north at the top of the screen
      return unit([0, 1, 1e-4]);
    case 'north':
      return [0, Math.sin(el), -Math.cos(el)];
    case 'south':
      return [0, Math.sin(el), Math.cos(el)];
    case 'east':
      return [Math.cos(el), Math.sin(el), 0];
    case 'west':
      return [-Math.cos(el), Math.sin(el), 0];
    case 'iso':
      return unit([1, 1, 1]);
    case 'oblique': {
      const d: Vec3 = current ? sub(current.position, current.target) : [1, 0, 1];
      const h = Math.hypot(d[0], d[2]) > 1e-6 ? unit([d[0], 0, d[2]]) : unit([1, 0, 1]);
      const e = 35 * DEG;
      return [h[0] * Math.cos(e), Math.sin(e), h[2] * Math.cos(e)];
    }
  }
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** The named asset or group the camera looks at: the smallest that holds the point, else the
 * nearest within reach. */
export function placeAt(places: readonly Place[], p: Vec3, reachM = 40): Place | null {
  let inside: { place: Place; size: number } | null = null;
  let near: { place: Place; d: number } | null = null;
  for (const place of places) {
    if ((place.kind !== 'asset' && place.kind !== 'group' && place.kind !== 'pile') || !place.box)
      continue;
    const b = place.box;
    const pad = 1;
    const holds = [0, 1, 2].every(
      (i) => (p[i] ?? 0) >= (b.min[i] ?? 0) - pad && (p[i] ?? 0) <= (b.max[i] ?? 0) + pad,
    );
    const size = radiusOf(b);
    if (holds && (!inside || size < inside.size)) inside = { place, size };
    const d = len(sub(boxCentre(b), p));
    if (!near || d < near.d) near = { place, d };
  }
  if (inside) return inside.place;
  return near && near.d <= reachM ? near.place : null;
}

/** Where the camera is and what it looks at, in the person's terms. */
export function cameraReport(ctx: RendererToolContext, pose: Pose, places?: readonly Place[]) {
  const offset = sub(pose.position, pose.target);
  const distance = len(offset);
  const heading = headingDeg(new Vector3(...pose.position), new Vector3(...pose.target));
  const pitch = -Math.atan2(offset[1], Math.hypot(offset[0], offset[2])) / DEG;
  const at = placeAt(places ?? placeIndex(ctx, { measure: true }), pose.target);
  const cam = describePoint(ctx, pose.position);
  return {
    camera: { en: cam.en, heightM: cam.elevationM, ...(cam.latLon ? { latLon: cam.latLon } : {}) },
    lookingAt: {
      ...(at ? { place: at.name, placeId: at.id } : {}),
      ...describePoint(ctx, pose.target),
    },
    distanceM: round(distance, 1),
    headingDeg: Math.round(heading),
    facing: COMPASS[Math.round(heading / 45) % 8],
    pitchDeg: Math.round(pitch),
  };
}

/** Send the camera to a pose; the 3D view flies there and the map follows. */
export function applyPose(ctx: RendererToolContext, pose: Pose): void {
  const dir = sub(pose.position, pose.target);
  ctx.workspace.getState().flyTo({
    kind: 'point',
    p: pose.target,
    distance: Math.max(0.05, len(dir)),
    dir,
  });
}

/** Undo for a camera move: back to the pose before it. */
function undoTo(ctx: RendererToolContext, before: Pose | null): (() => void) | undefined {
  return before
    ? () => {
        applyPose(ctx, before);
      }
    : undefined;
}

/** Map-only stage: a 3D-only move (orbit, look at, a side view) shows the 3D view first. */
function ensure3d(ctx: RendererToolContext, wanted: boolean): boolean {
  const view = ctx.app?.stageView?.();
  if (!wanted || !view || view.show3d) return false;
  ctx.app?.show3d?.();
  return true;
}

const mapOnly = (ctx: RendererToolContext) => {
  const v = ctx.app?.stageView?.();
  return v ? !v.show3d && v.showMap : false;
};

/** Distance to the first thing a camera at `pos` looking along `dir` sees, or `fallback`. */
function sightDistance(ctx: RendererToolContext, pos: Vec3, dir: Vec3, fallback: number): number {
  const s = ctx.scene();
  const hit = s?.raycastRay(new Vector3(...pos), new Vector3(...unit(dir)));
  if (!hit) return fallback;
  return Math.min(500, Math.max(2, hit.distance));
}

/** The pose that shows a resolved target. */
export function poseFor(
  ctx: RendererToolContext,
  r: Resolved,
  opts: { view?: ViewDirection | 'iso'; distanceM?: number; margin?: number },
): Pose | null {
  const current = currentPose(ctx);
  // a photo, panorama or clip without a side asked for: stand where that camera stood
  if (r.eye && !opts.view && opts.distanceM === undefined) {
    const { pos, q, headingDeg: h } = r.eye;
    let fwd: Vec3;
    if (q) fwd = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...q)).toArray();
    else fwd = [Math.sin((h ?? 0) * DEG), 0, -Math.cos((h ?? 0) * DEG)];
    const d = sightDistance(ctx, pos, fwd, 20);
    return { position: pos, target: add(pos, scale(unit(fwd), d)) };
  }
  const centre = r.box ? boxCentre(r.box) : r.p;
  if (!centre) return null;
  const { fov, aspect } = lens(ctx);
  const dir = opts.view
    ? viewDirection(opts.view, current)
    : current
      ? unit(sub(current.position, current.target))
      : unit([1, 1, 1]);
  let distance = opts.distanceM;
  if (distance === undefined) {
    if (r.box) {
      const floor = r.place?.kind === 'issue' ? 5 : 2;
      distance = Math.max(
        floor,
        fitDistance(radiusOf(r.box), fov, aspect, opts.margin ?? FIT_MARGIN),
      );
    } else {
      const now = current ? len(sub(current.position, current.target)) : 100;
      distance = Math.min(150, Math.max(5, now));
    }
  }
  return { target: centre, position: add(centre, scale(dir, distance)) };
}

/** Named assets and groups whose centre is in the camera's view, nearest first. */
export function placesInView(
  ctx: RendererToolContext,
  places: readonly Place[],
  max = 8,
): string[] {
  const s = ctx.scene();
  if (!s) return [];
  const cam = s.camera;
  cam.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );
  const v = new Vector3();
  const hits: { name: string; d: number }[] = [];
  for (const p of places) {
    if ((p.kind !== 'group' && p.kind !== 'asset' && p.kind !== 'pile') || !p.box) continue;
    v.fromArray(boxCentre(p.box));
    if (frustum.containsPoint(v)) hits.push({ name: p.name, d: v.distanceTo(cam.position) });
  }
  return hits
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((h) => h.name);
}

// Tools --------------------------------------------------------------------------------------

/** The tool result for a move: what it showed, where the camera is now, how to undo it. */
function moved(
  ctx: RendererToolContext,
  label: string,
  pose: Pose,
  before: Pose | null,
  extra: Record<string, unknown> = {},
) {
  applyPose(ctx, pose);
  const report = cameraReport(ctx, pose);
  const undo = undoTo(ctx, before);
  const where = report.lookingAt.place ?? label;
  const summary = `${label}${where !== label ? ` (${where})` : ''}, ${String(report.distanceM)} m`;
  return {
    result: {
      showing: label,
      ...extra,
      ...report,
      ...(mapOnly(ctx) ? { note: 'The map shows the place; the 3D view follows when shown.' } : {}),
    },
    summary,
    ...(undo ? { undo } : {}),
  };
}

/** A clip's place sized by its flight path (read from its pose file). */
async function clipBox(ctx: RendererToolContext, place: Place): Promise<Place> {
  if (place.kind !== 'clip' || place.box || !place.layer) return place;
  const layer = project(ctx).manifest.layers.find((l) => l.id === place.layer);
  if (layer?.kind !== 'video') return place;
  try {
    const flight = parseFlight(await ctx.fetchJson(assetUrl(project(ctx).id, layer.flight.src)));
    if (!flight) return place;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const s of flight.samples) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i] ?? 0, s.pos[i] ?? 0);
        max[i] = Math.max(max[i] ?? 0, s.pos[i] ?? 0);
      }
    }
    const box = { min, max };
    return { ...place, box, p: boxCentre(box) };
  } catch {
    return place;
  }
}

define('find_places', async ({ query, kinds, near, radiusM, limit }, ctx) => {
  const index = placeIndex(ctx, { untagged: true });
  const hasWords = words(query).length > 0;
  let rows: { place: Place; score: number }[] = hasWords
    ? searchPlaces(ctx, query, { index, ...(kinds ? { kinds } : {}) })
    : index
        .filter((p) => (kinds ? (kinds as readonly string[]).includes(p.kind) : p.kind !== 'asset'))
        .map((place) => ({ place, score: 0 }));
  let distances: Map<string, number> | null = null;
  if (near) {
    const from = await targetPoint(ctx, near);
    const found = new Map<string, number>();
    const measured: { place: Place; score: number }[] = [];
    for (const r of rows.slice(0, 2000)) {
      const place = measure(ctx, r.place);
      const c = place.box ? boxCentre(place.box) : place.p;
      if (!c) continue;
      const d = len(sub(c, from));
      if (radiusM !== undefined && d > radiusM) continue;
      found.set(place.id, d);
      measured.push({ place, score: r.score });
    }
    rows = measured.sort((a, b) => (found.get(a.place.id) ?? 0) - (found.get(b.place.id) ?? 0));
    distances = found;
  }
  const shown = await Promise.all(
    rows.slice(0, limit).map(async ({ place, score }) => {
      const p = await clipBox(ctx, measure(ctx, place));
      const c = p.box ? boxCentre(p.box) : p.p;
      const size = p.box ? sub(p.box.max, p.box.min).map((v) => round(v, 1)) : undefined;
      const d = distances?.get(p.id);
      return {
        id: p.id,
        kind: p.kind,
        name: p.name,
        ...(p.detail ? { detail: p.detail } : {}),
        ...(p.layer ? { layer: p.layer } : {}),
        ...(hasWords ? { match: Math.round(score) } : {}),
        position: c ? describePoint(ctx, c) : null,
        ...(size ? { sizeM: size } : {}),
        ...(d !== undefined ? { distanceM: round(d, 1) } : {}),
        ...(p.photos ? { photos: p.photos.slice(0, 8) } : {}),
      };
    }),
  );
  return {
    result: {
      total: rows.length,
      shown: shown.length,
      places: shown,
      ...(shown.length === 0
        ? { hint: 'Nothing matches. Try fewer or other words, a kind, or a coordinate.' }
        : {}),
      ...(shown.some((s) => s.position === null)
        ? { note: 'A null position means the 3D model has not loaded it yet; fly_to still works.' }
        : {}),
    },
    summary: `${String(shown.length)} of ${String(rows.length)} places`,
  };
});

define('fly_to', async ({ target, view, distanceM, open3d }, ctx) => {
  project(ctx);
  const before = currentPose(ctx);
  const r = await resolveTarget(ctx, target);
  if (open3d === true || (view !== undefined && view !== 'top')) ensure3d(ctx, true);
  const pose = poseFor(ctx, r, {
    ...(view ? { view } : {}),
    ...(distanceM !== undefined ? { distanceM } : {}),
  });
  if (!pose) {
    // an asset the 3D view has not loaded yet: it frames it once the model is in
    const node = r.place?.nodes?.[0];
    if (!node) throw new ToolError(`${r.label} has no position to fly to.`);
    const layer = r.place?.layer;
    ctx.workspace.getState().flyTo({
      kind: 'selection',
      selection: layer ? { kind: 'asset', id: node, layer } : { kind: 'asset', id: node },
    });
    const undo = undoTo(ctx, before);
    return {
      result: { showing: r.label, note: 'The 3D view frames it as soon as the model has loaded.' },
      summary: r.label,
      ...(undo ? { undo } : {}),
    };
  }
  return moved(ctx, r.label, pose, before, {
    ...(r.place ? { place: { id: r.place.id, kind: r.place.kind, name: r.place.name } } : {}),
    ...(r.eye && !view && distanceM === undefined ? { view: 'eye' } : {}),
  });
});

const PRESET: Record<string, ViewDirection | 'iso'> = {
  top: 'top',
  north: 'north',
  south: 'south',
  east: 'east',
  west: 'west',
  front: 'south',
  side: 'east',
  iso: 'iso',
  home: 'iso',
};

define('set_view', async ({ view, target }, ctx) => {
  project(ctx);
  const before = currentPose(ctx);
  ensure3d(ctx, view !== 'top' && view !== 'home');
  let r: Resolved;
  if (target) r = await resolveTarget(ctx, target);
  else {
    const box = siteBox(ctx);
    if (!box) throw new ToolError('Nothing is loaded to look at yet.');
    r = { label: 'the whole site', p: boxCentre(box), box };
  }
  const pose = poseFor(ctx, r, {
    view: PRESET[view] ?? 'iso',
    ...(view === 'home' && !target ? { margin: HOME_MARGIN } : {}),
  });
  if (!pose) throw new ToolError(`${r.label} has no position yet.`);
  return moved(ctx, `${view} view of ${r.label}`, pose, before, { view });
});

define('frame_all', (_input, ctx) => {
  project(ctx);
  const before = currentPose(ctx);
  const box = siteBox(ctx);
  const pose = box
    ? poseFor(ctx, { label: 'the whole site', p: boxCentre(box), box }, { margin: HOME_MARGIN })
    : null;
  if (!box || !pose) throw new ToolError('Nothing is loaded to frame yet.');
  const size = sub(box.max, box.min);
  return moved(ctx, 'the whole site', pose, before, {
    siteSizeM: {
      eastWest: Math.round(size[0]),
      northSouth: Math.round(size[2]),
      height: Math.round(size[1]),
    },
  });
});

define('orbit', async ({ yawDeg, pitchDeg, target }, ctx) => {
  project(ctx);
  const before = currentPose(ctx);
  if (!before) throw new ToolError('Open the 3D view first.');
  ensure3d(ctx, true);
  const centre = target ? await targetPoint(ctx, target) : before.target;
  const offset = sub(before.position, before.target);
  const d = Math.max(0.5, len(offset));
  const az = Math.atan2(offset[0], -offset[2]) + yawDeg * DEG;
  const el0 = Math.atan2(offset[1], Math.hypot(offset[0], offset[2]));
  const el = Math.min(89.9 * DEG, Math.max(-5 * DEG, el0 + pitchDeg * DEG));
  const dir: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const pose = { target: centre, position: add(centre, scale(dir, d)) };
  const label = `orbit ${String(Math.round(yawDeg))}°${pitchDeg ? `, pitch ${String(Math.round(pitchDeg))}°` : ''}`;
  return moved(ctx, label, pose, before);
});

define('zoom', ({ factor, distanceM }, ctx) => {
  project(ctx);
  const before = currentPose(ctx);
  if (!before) throw new ToolError('Open the 3D view or the map first.');
  const offset = sub(before.position, before.target);
  const d0 = Math.max(0.05, len(offset));
  const d = Math.min(20_000, Math.max(0.5, distanceM ?? d0 / (factor ?? 1)));
  const pose = { target: before.target, position: add(before.target, scale(unit(offset), d)) };
  return moved(ctx, d < d0 ? 'zoom in' : 'zoom out', pose, before);
});

define('look_at', async ({ target }, ctx) => {
  project(ctx);
  const before = currentPose(ctx);
  if (!before) throw new ToolError('Open the 3D view first.');
  ensure3d(ctx, true);
  const r = await resolveTarget(ctx, target);
  const centre = r.box ? boxCentre(r.box) : r.p;
  if (!centre) throw new ToolError(`${r.label} has no position yet.`);
  if (len(sub(before.position, centre)) < 0.5) {
    throw new ToolError(`The camera is at ${r.label}; use fly_to with a distance instead.`);
  }
  return moved(ctx, r.label, { position: before.position, target: centre }, before);
});
