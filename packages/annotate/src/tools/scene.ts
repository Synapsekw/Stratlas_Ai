import type { SceneHandle } from '@aio/engine';
import type { Sighting, Vec3 } from '@aio/schema';
import {
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import { cloudBoxSighting, cloudPointSighting, pickCloudPoint } from './cloud';
import {
  initialMeshDraw,
  meshDrawReducer,
  meshSightingFromDraw,
  pickSurface,
  type MeshDrawState,
} from './mesh';

export type SceneTool = 'point' | 'polyline' | 'polygon' | 'cloud-point' | 'cloud-box';

const DRAG_PX = 4;

/** Normalised device coordinates of a pointer event over an element. */
export function ndcOf(e: { clientX: number; clientY: number }, el: Element): [number, number] {
  const r = el.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
}

/**
 * Start a 3D annotation tool on a scene: clicks (not drags, so orbiting still works) place mesh
 * points, polylines and polygons through `handle.raycast`, or cloud points and boxes. Enter or a
 * double-click finishes a line or polygon, Backspace removes the last vertex, Esc cancels.
 * Returns a function that stops the tool.
 */
export function startSceneTool(
  handle: SceneHandle,
  tool: SceneTool,
  onDone: (s: Sighting, at: { x: number; y: number }) => void,
): () => void {
  const el = handle.renderer.domElement;
  const meshMode = tool === 'point' || tool === 'polyline' || tool === 'polygon';
  let draw: MeshDrawState = initialMeshDraw(meshMode ? tool : 'point');
  let cloud: { layer: string; p: Vec3 }[] = [];
  let down: { x: number; y: number } | null = null;
  let last = { x: 0, y: 0 };

  const preview = new Group();
  preview.name = 'annotate-tool-preview';
  preview.renderOrder = 999;
  const lineMat = new LineBasicMaterial({ color: 0x5fe0c0, depthTest: false });
  const dotMat = new PointsMaterial({
    color: 0x5fe0c0,
    size: 7,
    sizeAttenuation: false,
    depthTest: false,
  });
  handle.scene.add(preview);

  const redraw = () => {
    for (const c of [...preview.children]) {
      preview.remove(c);
      (c as Line | Points).geometry.dispose();
    }
    const pts = meshMode ? draw.points : cloud.map((c) => c.p);
    if (pts.length) {
      const g = new BufferGeometry().setFromPoints(pts.map((p) => new Vector3(...p)));
      preview.add(new Points(g, dotMat));
      if (pts.length > 1) {
        const first = pts[0];
        const closed = tool === 'polygon' && first ? [...pts, first] : pts;
        preview.add(
          new Line(
            new BufferGeometry().setFromPoints(closed.map((p) => new Vector3(...p))),
            lineMat,
          ),
        );
      }
    }
    handle.requestRender();
  };

  const emitMesh = () => {
    const s = meshSightingFromDraw(draw);
    if (s) onDone(s, last);
    draw = initialMeshDraw(draw.mode);
    redraw();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX;
    down = null;
    if (moved) return;
    last = { x: e.clientX, y: e.clientY };
    const [x, y] = ndcOf(e, el);
    if (meshMode) {
      const hit = handle.raycast(x, y);
      if (!hit || (hit.object as { isPoints?: boolean }).isPoints) return;
      const s = pickSurface(handle, x, y);
      if (!s) return;
      draw = meshDrawReducer(draw, { type: 'pick', ...s });
      if (draw.done) emitMesh();
      else redraw();
      return;
    }
    const p = pickCloudPoint(handle, x, y);
    if (!p) return;
    if (tool === 'cloud-point') {
      onDone(cloudPointSighting(p.layer, p.p), last);
      return;
    }
    cloud = [...cloud, p];
    const [a, b] = cloud;
    if (a && b) {
      onDone(cloudBoxSighting(a.layer, a.p, b.p, 0.1), last);
      cloud = [];
    }
    redraw();
  };
  const onDblClick = () => {
    if (!meshMode) return;
    draw = meshDrawReducer(draw, { type: 'finish' });
    if (draw.done) emitMesh();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') {
      draw = initialMeshDraw(draw.mode);
      cloud = [];
    } else if (e.key === 'Backspace') {
      draw = meshDrawReducer(draw, { type: 'undo' });
      cloud = cloud.slice(0, -1);
    } else if (e.key === 'Enter' && meshMode) {
      draw = meshDrawReducer(draw, { type: 'finish' });
      if (draw.done) {
        emitMesh();
        return;
      }
    } else {
      return;
    }
    redraw();
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('dblclick', onDblClick);
  window.addEventListener('keydown', onKey);
  const prevCursor = el.style.cursor;
  el.style.cursor = 'crosshair';
  return () => {
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('dblclick', onDblClick);
    window.removeEventListener('keydown', onKey);
    el.style.cursor = prevCursor;
    handle.scene.remove(preview);
    for (const c of preview.children) (c as Line | Points).geometry.dispose();
    lineMat.dispose();
    dotMat.dispose();
    handle.requestRender();
  };
}

// Issue pins in 3D live in ./overlay.
export { installIssueOverlay } from './overlay';
