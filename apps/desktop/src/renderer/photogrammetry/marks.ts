/**
 * Marking ground control points on photos (G4): where each point should be in each photo (the
 * prediction), and the state of each mark. A mark the software proposes (a prediction taken as is,
 * or a target detector's) is a `draft` until a person confirms it; a person can skip a photo (the
 * target is hidden or blurred). Pure functions over `GcpFile`, so the marker view and the tests
 * share them.
 */
import { worldToPixel } from '@aio/annotate';
import { fromWgs84, projectToLocal, toWgs84 } from '@aio/geo';
import type { GcpFile, GcpMark, GcpPoint, LensModel, Quat, Vec3 } from '@aio/schema';

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

/**
 * Where the point should appear in each photo, from the photos' poses. The run's own predictions
 * (`predicted`, written by `photo.align` from the calibrated cameras) win when present.
 */
export function predictions(
  p: GcpPoint,
  local: Vec3 | null,
  photos: readonly MarkerPhoto[],
): GcpPrediction[] {
  if (p.predicted?.length) return p.predicted;
  if (!local) return [];
  const out: GcpPrediction[] = [];
  for (const ph of photos) {
    if (!ph.pos || !ph.q || !ph.lens) continue;
    const px = worldToPixel({ pos: ph.pos, q: ph.q }, ph.lens, local, ph.size);
    if (px) out.push({ photo: ph.id, px: [px[0], px[1]], radiusPx: GNSS_RADIUS_PX });
  }
  return out;
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

/** Next index in a list, wrapping; -1 for an empty list. */
export function step(i: number, n: number, by: 1 | -1): number {
  if (n <= 0) return -1;
  return (((i + by) % n) + n) % n;
}
