import { correctPos, photoCorrection } from '@aio/geo';
import type { OrientationFile, PhotoCorrection, ProjectManifest, Vec3 } from '@aio/schema';

/*
 * Align to (spec section 6): move a block of photos in plan onto a target's centre and fix its
 * height only when it is implausible. The move is written as each photo's hand correction
 * (`offsetM`); the manifest, the GPS and the rotation corrections never change.
 */

/** The lowest photo lands this high above the target ground (eye height). */
export const EYE_HEIGHT_M = 1.6;
/** A block more than this above the target ground is implausible. */
export const MAX_ABOVE_GROUND_M = 300;
/** A total move under this is "Already in place". */
export const MIN_SHIFT_M = 1;

export interface AlignBox {
  min: Vec3;
  max: Vec3;
}

export interface AlignSource {
  layerId: string;
  photoId: string;
  pos: Vec3 | undefined;
  correction: PhotoCorrection | undefined;
}

/** Corrections by photo set id and photo id; null removes one. */
export type Fixes = Record<string, Record<string, PhotoCorrection | null>>;

export interface AlignPlan {
  shift: Vec3;
  /** Length of the shift, metres. */
  distance: number;
  moved: number;
  skipped: number;
  inPlace: boolean;
  fixes: Fixes;
  /** Each moved photo's correction before (null: it had none): the Undo. */
  before: Fixes;
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

/** The photos Align to moves: every photo of the named sets, or the picked photos. */
export function alignSources(
  m: ProjectManifest,
  o: OrientationFile | null,
  pick:
    { layerIds: readonly string[] } | { picks: readonly { layerId: string; photoId: string }[] },
): AlignSource[] {
  const out: AlignSource[] = [];
  const wanted =
    'picks' in pick ? new Set(pick.picks.map((p) => `${p.layerId}\n${p.photoId}`)) : null;
  const sets = 'picks' in pick ? [...new Set(pick.picks.map((p) => p.layerId))] : pick.layerIds;
  for (const id of sets) {
    const l = m.layers.find((x) => x.id === id);
    if (l?.kind !== 'photos') continue;
    for (const p of l.items) {
      if (wanted && !wanted.has(`${l.id}\n${p.id}`)) continue;
      out.push({
        layerId: l.id,
        photoId: p.id,
        pos: p.pos,
        correction: photoCorrection(o, l.id, p.id),
      });
    }
  }
  return out;
}

export function planAlign(
  sources: readonly AlignSource[],
  target: AlignBox,
  ground: number | null,
): AlignPlan {
  const placed = sources.flatMap((s) =>
    s.pos ? [{ s, at: correctPos(s.pos, s.correction) }] : [],
  );
  const skipped = sources.length - placed.length;
  const empty: AlignPlan = {
    shift: [0, 0, 0],
    distance: 0,
    moved: 0,
    skipped,
    inPlace: true,
    fixes: {},
    before: {},
  };
  if (placed.length === 0) return empty;
  const lo = (k: 0 | 1 | 2) => Math.min(...placed.map((p) => p.at[k]));
  const hi = (k: 0 | 1 | 2) => Math.max(...placed.map((p) => p.at[k]));
  const tx = (target.min[0] + target.max[0]) / 2;
  const tz = (target.min[2] + target.max[2]) / 2;
  const dx = tx - (lo(0) + hi(0)) / 2;
  const dz = tz - (lo(2) + hi(2)) / 2;
  const g = ground ?? target.min[1];
  const low = lo(1);
  const dy = low < g || low > g + MAX_ABOVE_GROUND_M ? g + EYE_HEIGHT_M - low : 0;
  const shift: Vec3 = [mm(dx), mm(dy), mm(dz)];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < MIN_SHIFT_M) return { ...empty, shift, distance, moved: 0 };
  const fixes: Fixes = {};
  const before: Fixes = {};
  for (const { s } of placed) {
    const c = s.correction;
    const o = c?.offsetM ?? [0, 0, 0];
    (fixes[s.layerId] ??= {})[s.photoId] = {
      yawDeg: c?.yawDeg ?? 0,
      pitchDeg: c?.pitchDeg ?? 0,
      rollDeg: c?.rollDeg ?? 0,
      offsetM: [mm(o[0] + shift[0]), mm(o[1] + shift[1]), mm(o[2] + shift[2])],
    };
    (before[s.layerId] ??= {})[s.photoId] = c ?? null;
  }
  return { shift, distance, moved: placed.length, skipped, inPlace: false, fixes, before };
}

/** `91.2 km` from 1 km up, `350 m` below. */
export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${String(Math.round(m))} m`;
}
