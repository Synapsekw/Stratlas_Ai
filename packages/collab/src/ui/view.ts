import { getActiveScene } from '@aio/engine';
import type { SavedView, Vec3 } from '@aio/schema';
import { workspace } from '@aio/workspace';

/** How far ahead of the camera the view's target sits when nothing is under the centre. */
const LOOK = 20;

/** The video clip on screen and the seconds into it, when one drives the clock. */
function clipTime(): { layer: string; time: number } | null {
  const ws = workspace.getState();
  const layer = ws.project?.manifest.layers.find((l) => l.id === ws.activeClip);
  if (layer?.kind !== 'video') return null;
  const start = layer.flight.startUtcMs + layer.offsetMs;
  const time = (ws.nowMs - start) / 1000;
  return time >= 0 ? { layer: layer.id, time: Math.round(time * 100) / 100 } : null;
}

/** Attach view: the 3D camera, what it looks at, and the clip time. Null without a 3D view. */
export function captureView(): SavedView | null {
  const scene = getActiveScene();
  if (!scene) return null;
  const cam = scene.camera;
  cam.updateMatrixWorld();
  const p = cam.position;
  const position: Vec3 = [p.x, p.y, p.z];
  const m = cam.matrixWorld.elements;
  // the camera looks down its local -Z axis
  const fwd: Vec3 = [-m[8], -m[9], -m[10]];
  const hit = scene.raycast(0, 0);
  const target: Vec3 = hit
    ? [hit.point.x, hit.point.y, hit.point.z]
    : [p.x + fwd[0] * LOOK, p.y + fwd[1] * LOOK, p.z + fwd[2] * LOOK];
  const clip = clipTime();
  return {
    camera: { position, target, fovDeg: Math.round(cam.fov * 10) / 10 },
    ...(clip ? { layer: clip.layer, time: clip.time } : {}),
  };
}

/** Fly to a saved view: the clip time first, then the camera. */
export function flyToView(view: SavedView): void {
  const ws = workspace.getState();
  if (view.layer && view.time !== undefined) {
    const layer = ws.project?.manifest.layers.find((l) => l.id === view.layer);
    if (layer?.kind === 'video') {
      ws.setActiveClip(layer.id);
      ws.setTime(layer.flight.startUtcMs + layer.offsetMs + view.time * 1000);
    }
  }
  const [px, py, pz] = view.camera.position;
  const [tx, ty, tz] = view.camera.target;
  const dir: Vec3 = [px - tx, py - ty, pz - tz];
  const distance = Math.hypot(...dir);
  ws.flyTo({ kind: 'point', p: view.camera.target, dir, distance: Math.max(distance, 0.5) });
}
