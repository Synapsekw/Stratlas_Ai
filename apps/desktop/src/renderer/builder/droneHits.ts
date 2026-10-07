import type { SceneHandle } from '@aio/engine';
import type { Layer, PoseSample, Vec3 } from '@aio/schema';
import { Plane, Raycaster, Vector2, Vector3, type Object3D } from 'three';

/*
 * What is under the cursor in the 3D view for the drone tools: the drone, its frustum and frame
 * plane, a flight path, or the ground. The stage's own picking leaves the video rig out.
 */

type VideoLayer = Extract<Layer, { kind: 'video' }>;

export type RigHit =
  | { kind: 'drone' }
  | { kind: 'frame'; point: Vec3 }
  | { kind: 'path'; layerId: string; point: Vec3 };

/** A ray through client point (x, y) of the 3D pane. */
export function paneRay(h: SceneHandle, pane: HTMLElement, x: number, y: number): Raycaster {
  const r = (pane.querySelector('canvas') ?? pane).getBoundingClientRect();
  const ndc = new Vector2(((x - r.left) / r.width) * 2 - 1, -(((y - r.top) / r.height) * 2 - 1));
  const ray = new Raycaster();
  ray.setFromCamera(ndc, h.camera);
  ray.camera = h.camera;
  return ray;
}

function shown(o: Object3D | null): boolean {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function named(o: Object3D | null, names: readonly string[]): string | null {
  for (let x = o; x; x = x.parent) if (names.includes(x.name)) return x.name;
  return null;
}

/** The video rig object under client point (x, y), nearest first, or null. */
export function rigHit(h: SceneHandle, pane: HTMLElement, x: number, y: number): RigHit | null {
  const rig = h.scene.getObjectByName('VideoRig');
  if (!rig) return null;
  const ray = paneRay(h, pane, x, y);
  // lines are hit within a few pixels at any zoom
  const target = (h as SceneHandle & { controls?: { target?: Vector3 } }).controls?.target;
  const dist = target ? h.camera.position.distanceTo(target) : 100;
  ray.params.Line = { threshold: Math.max(0.05, dist * 0.012) };
  for (const hit of ray.intersectObject(rig, true)) {
    if (!shown(hit.object)) continue;
    const name = named(hit.object, ['Drone', 'DroneBeacon', 'DroneFrustum', 'DirectionFrame']);
    const p: Vec3 = [hit.point.x, hit.point.y, hit.point.z];
    if (name === 'DirectionFrame') return { kind: 'frame', point: p };
    if (name) return { kind: 'drone' };
    const layerId = (hit.object.userData as { videoLayer?: unknown }).videoLayer;
    if (typeof layerId === 'string') return { kind: 'path', layerId, point: p };
  }
  return null;
}

/** The frame plane under client point (x, y), if the cursor is on it. */
export function frameHit(h: SceneHandle, pane: HTMLElement, x: number, y: number): boolean {
  const plane = h.scene.getObjectByName('DirectionFrame');
  if (!plane || !shown(plane)) return false;
  return paneRay(h, pane, x, y).intersectObject(plane, false).length > 0;
}

/** A surface under client point (x, y): the scene, else the ground plane y = 0. */
export function groundHit(h: SceneHandle, pane: HTMLElement, x: number, y: number): Vec3 | null {
  const r = (pane.querySelector('canvas') ?? pane).getBoundingClientRect();
  const hit = h.raycast(((x - r.left) / r.width) * 2 - 1, -(((y - r.top) / r.height) * 2 - 1));
  if (hit) return [hit.point.x, hit.point.y, hit.point.z];
  const p = paneRay(h, pane, x, y).ray.intersectPlane(
    new Plane(new Vector3(0, 1, 0), 0),
    new Vector3(),
  );
  return p ? [p.x, p.y, p.z] : null;
}

/** Flight time of the sample nearest to `p` in plan (x, z). */
export function nearestSampleMs(samples: readonly PoseSample[], p: Vec3): number | null {
  let best: number | null = null;
  let gap = Infinity;
  for (const s of samples) {
    const d = (s.pos[0] - p[0]) ** 2 + (s.pos[2] - p[2]) ** 2;
    if (d < gap) {
      gap = d;
      best = s.t;
    }
  }
  return best;
}

/**
 * The clip of a flight that covers flight time `flightMs` (clips cut from one log share it):
 * the one whose window holds it, else the nearest by start.
 */
export function clipAtFlightTime(
  clips: readonly VideoLayer[],
  flightMs: number,
  durationMs: (id: string) => number | null,
): VideoLayer | null {
  let best: VideoLayer | null = null;
  let gap = Infinity;
  for (const c of clips) {
    const d = durationMs(c.id) ?? 0;
    if (flightMs >= c.offsetMs && flightMs <= c.offsetMs + d) return c;
    const g = Math.abs(flightMs - c.offsetMs);
    if (g < gap) {
      gap = g;
      best = c;
    }
  }
  return best;
}
