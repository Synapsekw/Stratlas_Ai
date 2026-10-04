import type { SectionState } from '@aio/engine';
import { Vector3, type Box3, type Material, type Mesh, type Object3D } from 'three';

const DEG = Math.PI / 180;

/** Is `p` inside the box, with the box shrunk by `inset` (a fraction of its size) on every side? */
export function insideAsset(p: Vector3, box: Box3, inset = 0.04): boolean {
  if (box.isEmpty()) return false;
  const size = box.getSize(new Vector3()).multiplyScalar(inset);
  return (
    p.x > box.min.x + size.x &&
    p.x < box.max.x - size.x &&
    p.y > box.min.y + size.y &&
    p.y < box.max.y - size.y &&
    p.z > box.min.z + size.z &&
    p.z < box.max.z - size.z
  );
}

/** Compass bearing of the horizontal direction from `from` to `to` (clockwise from north, -Z). */
export function bearingDeg(from: Vector3, to: Vector3): number {
  return (((Math.atan2(to.x - from.x, -(to.z - from.z)) / DEG) % 360) + 360) % 360;
}

export type Cut = Pick<SectionState, 'enabled' | 'mode' | 'bearingDeg' | 'offset' | 'flip'>;

/**
 * The vertical section that opens the asset toward the viewer: it removes the half between the
 * camera and the drone, `margin` metres in front of the drone, so the drone and the walls it
 * films stay. Offsets are measured from the engine's section origin.
 */
export function cutawayFor(drone: Vector3, camera: Vector3, origin: Vector3, margin = 0.6): Cut {
  const b = Math.round(bearingDeg(drone, camera));
  const toward = new Vector3(Math.sin(b * DEG), 0, -Math.cos(b * DEG));
  const offset = drone.clone().sub(origin).dot(toward) + margin;
  return { enabled: true, mode: 'vertical', bearingDeg: b % 360, offset, flip: false };
}

/** Is the section already (close to) this cut? Avoids re-applying it every frame. */
export function sameCut(s: SectionState, c: Cut): boolean {
  const db = Math.abs(((((s.bearingDeg - c.bearingDeg) % 360) + 540) % 360) - 180);
  return (
    s.enabled === c.enabled &&
    s.mode === c.mode &&
    s.flip === c.flip &&
    db < 3 &&
    Math.abs(s.offset - c.offset) < 0.08
  );
}

/**
 * A view from outside the cut, behind and above the drone, looking the way the drone looks, so
 * the drone and the walls its video is projected on are both in frame.
 */
export function insideViewPose(
  drone: Vector3,
  look: Vector3,
  distance: number,
): { position: Vector3; target: Vector3 } {
  const h = new Vector3(look.x, 0, look.z);
  if (h.lengthSq() < 1e-6) h.set(0, 0, -1);
  h.normalize();
  const target = drone.clone().addScaledVector(h, Math.min(1.5, distance * 0.25));
  const position = drone
    .clone()
    .addScaledVector(h, -distance)
    .add(new Vector3(0, distance * 0.35, 0));
  return { position, target };
}

/* ----------------------------------------------------------------------- modes */

/**
 * How the asset is opened to see the drone inside it, chosen by hand (never automatic): drawn
 * solid, cut open toward the viewer, or drawn see-through.
 */
export type CutawayMode = 'off' | 'cut' | 'transparent';

export const CUTAWAY_MODES: readonly CutawayMode[] = ['off', 'cut', 'transparent'];

export interface CutawayPref {
  mode: CutawayMode;
  /** Opacity of the asset in Transparent mode, 0.05..0.95. */
  opacity: number;
}

export const DEFAULT_CUTAWAY: CutawayPref = { mode: 'off', opacity: 0.3 };

export const MIN_OPACITY = 0.05;
export const MAX_OPACITY = 0.95;

export function clampOpacity(o: number): number {
  return Number.isFinite(o) ? Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, o)) : 0.3;
}

/** A remembered choice read back from storage, or null when it is not one. */
export function parseCutawayPref(v: unknown): CutawayPref | null {
  if (!v || typeof v !== 'object') return null;
  const { mode, opacity } = v as Record<string, unknown>;
  if (typeof mode !== 'string' || !CUTAWAY_MODES.includes(mode as CutawayMode)) return null;
  return {
    mode: mode as CutawayMode,
    opacity: typeof opacity === 'number' ? clampOpacity(opacity) : DEFAULT_CUTAWAY.opacity,
  };
}

/* ----------------------------------------------------------------------- see-through */

/** The material fields Transparent mode changes, as they were. */
interface SavedLook {
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
}

export interface SeeThrough {
  /** Materials made see-through. */
  readonly count: number;
  setOpacity(opacity: number): void;
  /** Puts every material back exactly as it was. */
  restore(): void;
}

function isMesh(o: Object3D): o is Mesh {
  return 'isMesh' in o;
}

/**
 * Draw every mesh under `root` see-through: blended at `opacity` times its own opacity and without
 * writing depth, so the drone, its flight path and the video projected on the far walls show
 * through the near walls. `restore()` undoes exactly what was changed.
 */
export function makeSeeThrough(root: Object3D, opacity: number): SeeThrough {
  const saved = new Map<Material, SavedLook>();
  root.traverse((o) => {
    if (!isMesh(o)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!saved.has(m))
        saved.set(m, { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
    }
  });
  const apply = (o: number) => {
    const k = clampOpacity(o);
    for (const [m, was] of saved) m.opacity = was.opacity * k;
  };
  for (const m of saved.keys()) {
    m.transparent = true;
    m.depthWrite = false;
    m.needsUpdate = true;
  }
  apply(opacity);
  let restored = false;
  return {
    count: saved.size,
    setOpacity: (o) => {
      if (!restored) apply(o);
    },
    restore: () => {
      if (restored) return;
      restored = true;
      for (const [m, was] of saved) {
        m.transparent = was.transparent;
        m.opacity = was.opacity;
        m.depthWrite = was.depthWrite;
        m.needsUpdate = true;
      }
    },
  };
}
