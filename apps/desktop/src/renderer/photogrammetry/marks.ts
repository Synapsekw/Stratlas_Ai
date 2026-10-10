/**
 * Marking ground control points on photos (G4): where each point should be in each photo (the
 * prediction), and the state of each mark. A mark the software proposes (a prediction taken as is,
 * or a target detector's) is a `draft` until a person confirms it; a person can skip a photo (the
 * target is hidden or blurred). Pure functions over `GcpFile`, so the marker view and the tests
 * share them.
 */
import { cameraToPixel, conjugate, pixelToWorldRay, rotate } from '@aio/annotate';
import { fromWgs84, projectToLocal, toWgs84 } from '@aio/geo';
import {
  PhotoCamerasFile,
  type GcpFile,
  type GcpMark,
  type GcpPoint,
  type LensModel,
  type Quat,
  type Vec3,
} from '@aio/schema';

/** Where the cameras put a point in one photo (`GcpPrediction`; the schema exports no type). */
export type GcpPrediction = NonNullable<GcpPoint['predicted']>[number];

/** At least this many confirmed marks per point before **Adjust** (plan, G4 scope). */
export const MIN_MARKS = 3;

export type MarkAction =
  | { kind: 'place'; photo: string; px: [number, number]; by?: GcpMark['by'] }
  | { kind: 'confirm'; photo: string; px?: [number, number] }
  | { kind: 'skip'; photo: string; px?: [number, number] }
  | { kind: 'clear'; photo: string };

/**
 * A point after a mark action. `place` by a person is confirmed at once; a detector's is a draft.
 * `confirm` turns a draft (or the prediction, given as `px`) into a confirmed mark. `skip` keeps
 * the photo out of the adjustment for this point. `clear` removes the mark.
 */
export function applyMark(p: GcpPoint, a: MarkAction, at: string): GcpPoint {
  const rest = p.marks.filter((m) => m.photo !== a.photo);
  const old = p.marks.find((m) => m.photo === a.photo);
  switch (a.kind) {
    case 'clear':
      return { ...p, marks: rest };
    case 'place': {
      const by = a.by ?? 'person';
      const state = by === 'person' ? 'confirmed' : 'draft';
      return { ...p, marks: [...rest, { photo: a.photo, px: a.px, by, at, state }] };
    }
    case 'confirm': {
      const px = old?.px ?? a.px;
      if (!px) return p;
      const by = old && old.state !== 'skipped' ? old.by : 'person';
      return { ...p, marks: [...rest, { photo: a.photo, px, by, at, state: 'confirmed' }] };
    }
    case 'skip': {
      const px = old?.px ?? a.px ?? [0, 0];
      return { ...p, marks: [...rest, { photo: a.photo, px, by: 'person', at, state: 'skipped' }] };
    }
  }
}

/** Replace one point of a GCP file. */
export const withPoint = (f: GcpFile, p: GcpPoint): GcpFile => ({
  ...f,
  points: f.points.map((q) => (q.id === p.id ? p : q)),
});

export const confirmedMarks = (p: GcpPoint) => p.marks.filter((m) => m.state === 'confirmed');
export const draftMarks = (p: GcpPoint) => p.marks.filter((m) => m.state === 'draft');

/** What **Adjust** still waits for, in words; empty when it can start. */
export function adjustProblems(f: GcpFile): string[] {
  const live = f.points.filter((p) => !p.disabled);
  const out: string[] = [];
  const control = live.filter((p) => p.role === 'control');
  if (control.length < 3) out.push('Adjusting needs at least three control points.');
  for (const p of live) {
    const n = confirmedMarks(p).length;
    if (p.role === 'control' && n < MIN_MARKS)
      out.push(
        `${p.id}: ${String(n)} of ${String(MIN_MARKS)} marks confirmed. Mark it in ${String(MIN_MARKS - n)} more ${MIN_MARKS - n === 1 ? 'photo' : 'photos'}, or disable it.`,
      );
  }
  return out;
}

/** A photo the marker can show: its id (as in marks), image size and pose in the local frame. */
export interface MarkerPhoto {
  id: string;
  /** Size of the original image, pixels (marks are in these pixels). */
  size: [number, number];
  pos?: Vec3 | undefined;
  q?: Quat | undefined;
  lens?: LensModel | undefined;
}

/** Project frame of the open project: CRS and origin. */
export interface Frame {
  epsg: number;
  origin: Vec3;
}

/** A GCP in the project's local frame (x east, y up, z south), or null when it cannot be placed. */
export function gcpLocal(p: GcpPoint, fileEpsg: number, frame: Frame): Vec3 | null {
  try {
    const projected =
      fileEpsg === frame.epsg
        ? p.xyz
        : fromWgs84(fileEpsg === 4326 ? p.xyz : toWgs84(p.xyz, fileEpsg), frame.epsg);
    return projectToLocal([projected[0], projected[1], p.xyz[2]], frame.origin);
  } catch {
    return null;
  }
}

/** The point as longitude and latitude, for the map preview. */
export function gcpLonLat(p: GcpPoint, fileEpsg: number): [number, number] | null {
  try {
    const ll = fileEpsg === 4326 ? p.xyz : toWgs84(p.xyz, fileEpsg);
    return Number.isFinite(ll[0]) && Number.isFinite(ll[1]) ? [ll[0], ll[1]] : null;
  } catch {
    return null;
  }
}

/** Search radius of a prediction from photo positions only (GNSS, before alignment). */
export const GNSS_RADIUS_PX = 80;

/** Search radius of a prediction from the point's own confirmed marks (`triangulate`). */
export const MARKED_RADIUS_PX = 12;
/** Two marks place a point only when their rays cross at this angle or more (sine of 2 degrees). */
const MIN_RAY_SIN = Math.sin((2 * Math.PI) / 180);

const median = (values: readonly number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? (v[mid] ?? 0) : ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2;
};

/**
 * Where a point's confirmed marks put it in the cameras' frame: the position nearest the rays
 * through its marks, or null with fewer than two marked photos that have a pose, or when the rays
 * are close to parallel. This is the point as the model sees it, whatever the survey's height
 * datum or the flight's GNSS bias.
 */
export function triangulate(p: GcpPoint, photos: readonly MarkerPhoto[]): Vec3 | null {
  const byId = new Map(photos.map((ph) => [ph.id, ph]));
  const rays: { origin: Vec3; dir: Vec3 }[] = [];
  for (const m of confirmedMarks(p)) {
    const ph = byId.get(m.photo);
    if (!ph?.pos || !ph.q || !ph.lens) continue;
    rays.push(pixelToWorldRay({ pos: ph.pos, q: ph.q }, ph.lens, m.px, ph.size));
  }
  const first = rays[0];
  if (!first || rays.length < 2) return null;
  // the point nearest every ray: sum(I - u u^T) x = sum(I - u u^T) o, a symmetric 3 x 3 system
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  let e = 0;
  let f = 0;
  const r: Vec3 = [0, 0, 0];
  let spread = 0;
  const v = first.dir;
  for (const { origin: o, dir: u } of rays) {
    const along = o[0] * u[0] + o[1] * u[1] + o[2] * u[2];
    a += 1 - u[0] * u[0];
    b -= u[0] * u[1];
    c -= u[0] * u[2];
    d += 1 - u[1] * u[1];
    e -= u[1] * u[2];
    f += 1 - u[2] * u[2];
    r[0] += o[0] - u[0] * along;
    r[1] += o[1] - u[1] * along;
    r[2] += o[2] - u[2] * along;
    spread = Math.max(
      spread,
      Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]),
    );
  }
  if (spread < MIN_RAY_SIN) return null;
  const det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
  if (Math.abs(det) < 1e-12) return null;
  const x: Vec3 = [
    (r[0] * (d * f - e * e) - b * (r[1] * f - r[2] * e) + c * (r[1] * e - r[2] * d)) / det,
    (a * (r[1] * f - r[2] * e) - r[0] * (b * f - c * e) + c * (b * r[2] - c * r[1])) / det,
    (a * (d * r[2] - e * r[1]) - b * (b * r[2] - c * r[1]) + r[0] * (b * e - c * d)) / det,
  ];
  // behind a camera: the marks do not agree on one point
  for (const { origin: o, dir: u } of rays)
    if ((x[0] - o[0]) * u[0] + (x[1] - o[1]) * u[1] + (x[2] - o[2]) * u[2] <= 0) return null;
  return x;
}

/**
 * The largest shift between survey and cameras the marker believes, metres. Height datums differ
 * by the geoid's undulation (at most about 106 m on Earth) and a logged altitude is tens of metres
 * off; a GNSS position without RTK is metres off. Anything beyond comes from a wrong number (a GSD
 * that does not fit the cameras, marks on the wrong target) and is ignored.
 */
export const MAX_SHIFT_M = 150;

const plausible = (shift: Vec3): Vec3 | null =>
  shift.every((v) => Number.isFinite(v)) && Math.hypot(shift[0], shift[1], shift[2]) <= MAX_SHIFT_M
    ? shift
    : null;

/** A point of the GCP file with its surveyed position in the project's local frame. */
export interface PlacedPoint {
  point: GcpPoint;
  local: Vec3 | null;
}

/**
 * The model's ground level against the survey's, before any mark: `[0, up, 0]`, metres. A run
 * states its ground sample distance, the median depth of each photo's tie points over its focal
 * length, so the ground lies `gsd * focal` below a photo that looks down; ground control lies on
 * the ground. Null without a stated GSD (or one that is no positive number), without a photo
 * looking down, without a placed point, or when the shift is no plausible one (`MAX_SHIFT_M`):
 * better the positions as surveyed than a wild guess.
 */
export function groundShift(
  points: readonly PlacedPoint[],
  photos: readonly MarkerPhoto[],
  gsdCm: number | null | undefined,
): Vec3 | null {
  if (typeof gsdCm !== 'number' || !Number.isFinite(gsdCm) || gsdCm <= 0) return null;
  const ground: number[] = [];
  for (const ph of photos) {
    if (!ph.pos || !ph.q || ph.lens?.model !== 'pinhole') continue;
    // 1 for a nadir photo; an oblique photo's depth is not its height above the ground
    const down = -rotate(ph.q, [0, 0, -1])[1];
    if (down < Math.SQRT1_2) continue;
    const focalPx = ph.size[0] / 2 / Math.tan((ph.lens.hfovDeg * Math.PI) / 360);
    ground.push(ph.pos[1] - (gsdCm / 100) * focalPx * down);
  }
  const surveyed: number[] = [];
  for (const { point, local } of points) if (local && !point.disabled) surveyed.push(local[1]);
  if (!ground.length || !surveyed.length) return null;
  return plausible([0, median(ground) - median(surveyed), 0]);
}

/**
 * How far the cameras' frame sits from the survey, metres in the local frame (add it to a surveyed
 * position before projecting it). A flight without RTK logs heights tens of metres off the survey
 * datum and positions a few metres off, and the GNSS-only alignment inherits both: projected at
 * its surveyed height a point lands far from its target, or outside the photos that see it.
 *
 * The marks say where the survey really is: every point with two confirmed marks is triangulated,
 * and the median of (triangulated - surveyed) is the shift. Before any mark, `groundShift` gives
 * its vertical part. Null when neither is known: the positions are projected as surveyed. A point
 * whose marks put it further from its surveyed position than `MAX_SHIFT_M` says nothing (marks on
 * another target, a wrong coordinate).
 */
export function surveyShift(
  points: readonly PlacedPoint[],
  photos: readonly MarkerPhoto[],
  gsdCm?: number | null,
): Vec3 | null {
  const seen: Vec3[] = [];
  for (const { point, local } of points) {
    if (!local || point.disabled) continue;
    const x = triangulate(point, photos);
    const shift = x && plausible([x[0] - local[0], x[1] - local[1], x[2] - local[2]]);
    if (shift) seen.push(shift);
  }
  if (seen.length === 0) return groundShift(points, photos, gsdCm);
  return [
    median(seen.map((s) => s[0])),
    median(seen.map((s) => s[1])),
    median(seen.map((s) => s[2])),
  ];
}

/** True for a position inside the photo, or within `margin` pixels of it. */
export const inFrame = (
  px: readonly [number, number],
  size: readonly [number, number],
  margin = 0,
): boolean =>
  px[0] >= -margin && px[1] >= -margin && px[0] <= size[0] + margin && px[1] <= size[1] + margin;

/**
 * A position in every photo whose search ring reaches into the frame: a prediction is only as good
 * as its radius, so a target near the edge of a photo may be predicted just beside it. Such a photo
 * is offered (the target may well be in it), but its prediction is not a mark to confirm.
 */
const project = (at: Vec3, photos: readonly MarkerPhoto[], radiusPx: number): GcpPrediction[] => {
  const out: GcpPrediction[] = [];
  for (const ph of photos) {
    if (!ph.pos || !ph.q || !ph.lens) continue;
    const rel: Vec3 = [at[0] - ph.pos[0], at[1] - ph.pos[1], at[2] - ph.pos[2]];
    const px = cameraToPixel(ph.lens, rotate(conjugate(ph.q), rel), ph.size);
    if (px && inFrame(px, ph.size, radiusPx))
      out.push({ photo: ph.id, px: [px[0], px[1]], radiusPx });
  }
  return out;
};

/**
 * Where the point should appear in each photo, best knowledge first:
 *
 * 1. its own confirmed marks: with two, the point is triangulated and projected into every photo;
 * 2. the run's own predictions (`predicted`, written by `photo.align` and `photo.georef` from the
 *    calibrated cameras);
 * 3. its surveyed position moved by `shift` (`surveyShift`: what the marks of the other points,
 *    or the run's ground level, say about the survey), through the photos' poses.
 */
export function predictions(
  p: GcpPoint,
  local: Vec3 | null,
  photos: readonly MarkerPhoto[],
  shift: Vec3 | null = null,
): GcpPrediction[] {
  const own = triangulate(p, photos);
  if (own) return project(own, photos, MARKED_RADIUS_PX);
  if (p.predicted?.length) return p.predicted;
  if (!local) return [];
  const at: Vec3 = shift ? [local[0] + shift[0], local[1] + shift[1], local[2] + shift[2]] : local;
  return project(at, photos, GNSS_RADIUS_PX);
}

/**
 * The photos to mark a point in: those it is predicted in (sorted by the predicted distance to the
 * image centre, where lens distortion is least), then photos already marked without a prediction.
 */
export function photosFor<P extends MarkerPhoto>(
  p: GcpPoint,
  preds: readonly GcpPrediction[],
  photos: readonly P[],
): { photo: P; prediction: GcpPrediction | null }[] {
  const byId = new Map(photos.map((ph) => [ph.id, ph]));
  const seen = new Set<string>();
  const out: { photo: P; prediction: GcpPrediction | null; d: number }[] = [];
  for (const pr of preds) {
    const ph = byId.get(pr.photo);
    if (!ph || seen.has(ph.id)) continue;
    seen.add(ph.id);
    const d = Math.hypot(pr.px[0] - ph.size[0] / 2, pr.px[1] - ph.size[1] / 2);
    out.push({ photo: ph, prediction: pr, d: d / Math.hypot(ph.size[0], ph.size[1]) });
  }
  out.sort((a, b) => a.d - b.d || a.photo.id.localeCompare(b.photo.id));
  for (const m of p.marks) {
    const ph = byId.get(m.photo);
    if (ph && !seen.has(ph.id)) {
      seen.add(ph.id);
      out.push({ photo: ph, prediction: null, d: Infinity });
    }
  }
  return out.map(({ photo, prediction }) => ({ photo, prediction }));
}

/**
 * The marker's list for one point of a GCP file: every point placed in the project's frame, the
 * survey's shift learned from the file's marks (`surveyShift`), the predictions and their photos.
 */
export function markerList<P extends MarkerPhoto>(
  f: GcpFile,
  p: GcpPoint,
  photos: readonly P[],
  frame: Frame | null,
  gsdCm?: number | null,
): { photo: P; prediction: GcpPrediction | null }[] {
  const epsg = 'epsg' in f.crs ? f.crs.epsg : null;
  const place = (q: GcpPoint) => (frame && epsg !== null ? gcpLocal(q, epsg, frame) : null);
  const shift = surveyShift(
    f.points.map((q) => ({ point: q, local: place(q) })),
    photos,
    gsdCm,
  );
  return photosFor(p, predictions(p, place(p), photos, shift), photos);
}

/**
 * The photo to show after marking or skipping `from`: the next one in the list without a mark
 * (wrapping), else simply the next one. The list is the one after the action: a second mark
 * triangulates the point, which can add photos and reorder them.
 */
export function nextToMark(
  list: readonly { photo: MarkerPhoto }[],
  p: GcpPoint,
  from: string,
): string | null {
  const marked = new Set(p.marks.map((m) => m.photo));
  const i = Math.max(
    0,
    list.findIndex((x) => x.photo.id === from),
  );
  for (let k = 1; k <= list.length; k++) {
    const id = list[(i + k) % list.length]?.photo.id;
    if (id !== undefined && !marked.has(id)) return id;
  }
  return list[(i + 1) % Math.max(1, list.length)]?.photo.id ?? null;
}

// ---------------------------------------------------------------- pixels

/**
 * Marks use COLMAP's pixel convention, the one `photo.align` and `photo.georef` measure with
 * (G2 `gcp.py`) and the synthetic set's truth is written in (G8): the top-left corner of the image
 * is (0, 0), x runs right and y down, continuously, so the centre of pixel (i, j) is
 * (i + 0.5, j + 0.5) and the image centre is (width / 2, height / 2). The photo on screen may be
 * any size (a review copy, a zoom); positions scale with the original size.
 */
export function clickToPixel(
  client: readonly [number, number],
  rect: { left: number; top: number; width: number; height: number },
  size: readonly [number, number],
): [number, number] {
  const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  return [
    clamp(((client[0] - rect.left) / rect.width) * size[0], size[0]),
    clamp(((client[1] - rect.top) / rect.height) * size[1], size[1]),
  ];
}

/**
 * The loupe: the photo at `zoom` times the box width, placed so the original-image pixel position
 * `px` sits under the box centre (where the cross hair is drawn). CSS pixels.
 */
export function loupeBackground(
  px: readonly [number, number],
  size: readonly [number, number],
  box: number,
  zoom: number,
): { size: string; position: string } {
  const w = box * zoom;
  const h = (w * size[1]) / size[0];
  const x = box / 2 - (px[0] / size[0]) * w;
  const y = box / 2 - (px[1] / size[1]) * h;
  const f = (v: number) => `${String(Math.round(v * 100) / 100)}px`;
  return { size: `${f(w)} ${f(h)}`, position: `${f(x)} ${f(y)}` };
}

/**
 * `cameras-sfm.json` as the marker reads it: G2's first files carry no `schema` key (registered at
 * the integration) and are read as `aio.photo-cameras/1`; anything else that does not parse is null.
 */
export function readCamerasFile(raw: unknown): PhotoCamerasFile | null {
  const withSchema =
    raw && typeof raw === 'object' && !Array.isArray(raw) && !('schema' in raw)
      ? { schema: 'aio.photo-cameras/1', ...raw }
      : raw;
  const r = PhotoCamerasFile.safeParse(withSchema);
  return r.success ? r.data : null;
}

/** A refined camera of the run (`cameras-sfm.json`) as a marker photo, in the project's frame. */
export interface SfmPhoto extends MarkerPhoto {
  pos: Vec3;
  q: Quat;
}

/**
 * The run's refined cameras as marker photos: keyed as the run keys photos (`GcpMark.photo`),
 * posed in the open project's local frame (the file is measured from its own origin), and sized
 * by their calibration (the original image size, which marks are measured in).
 */
export function sfmPhotos(file: PhotoCamerasFile, origin: Vec3): Map<string, SfmPhoto> {
  const sizes = new Map(file.calibration.map((c) => [c.id, [c.width, c.height] as const]));
  const [de, dn, dh] = [
    file.origin[0] - origin[0],
    file.origin[1] - origin[1],
    file.origin[2] - origin[2],
  ];
  const out = new Map<string, SfmPhoto>();
  for (const c of file.cameras) {
    const s = c.camera ? sizes.get(c.camera) : undefined;
    const aspect = c.lens.aspect > 0 ? c.lens.aspect : 4 / 3;
    const size: [number, number] = s ? [s[0], s[1]] : [4000, Math.round(4000 / aspect)];
    const lens: LensModel | undefined =
      c.lens.model === 'pinhole' && c.lens.hfovDeg < 180
        ? { model: 'pinhole', hfovDeg: c.lens.hfovDeg, aspect }
        : undefined;
    out.set(c.photo, {
      id: c.photo,
      size,
      pos: [c.pos[0] + de, c.pos[1] + dh, c.pos[2] - dn],
      q: [c.q[0], c.q[1], c.q[2], c.q[3]],
      lens,
    });
  }
  return out;
}

/** Next index in a list, wrapping; -1 for an empty list. */
export function step(i: number, n: number, by: 1 | -1): number {
  if (n <= 0) return -1;
  return (((i + by) % n) + n) % n;
}
