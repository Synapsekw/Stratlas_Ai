import { getActiveScene, isEngineStage, onActiveScene, type SceneHandle } from '@aio/engine';
import type { Sighting, Vec3 } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Raycaster,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { cloudBoxSighting, cloudPointSighting, pickCloudPoint } from './cloud';
import { drapedShapes, mapToLocal, type MapToLocal } from './drape';
import {
  initialMeshDraw,
  issuePins,
  meshDrawReducer,
  meshSightingFromDraw,
  pickSurface,
  type IssuePin,
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

// ---- issue pins in 3D ----

const PIN_PX = 7;

function labelSprite(text: string, color: string): Sprite | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const font = '600 22px "IBM Plex Mono", Consolas, monospace';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 20;
  canvas.width = w;
  canvas.height = 34;
  ctx.font = font;
  ctx.fillStyle = 'rgba(20, 24, 30, 0.85)';
  ctx.fillRect(0, 0, w, 34);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 4, 34);
  ctx.fillStyle = '#eef1f5';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 11, 18);
  const tex = new CanvasTexture(canvas);
  const sprite = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.userData.aspect = w / 34;
  sprite.center.set(-0.15, 0.5);
  sprite.renderOrder = 1001;
  return sprite;
}

function disposeTree(o: Object3D) {
  o.traverse((c) => {
    const m = c as Mesh | Sprite;
    if ('geometry' in m) m.geometry.dispose();
    const mat = (m as Mesh).material as MeshBasicMaterial | SpriteMaterial | undefined;
    if (mat && 'map' in mat) mat.map?.dispose();
    mat?.dispose();
  });
}

type DrapeIssues = Parameters<typeof drapedShapes>[0];
type DrapeModels = Parameters<typeof drapedShapes>[1];

/** Height of draped map shapes above the ground plane, metres. */
const DRAPE_Y = 0.05;

/**
 * Issues' polygon map sightings draped on the ground (y = 0): outlines and a light fill in the
 * severity colour, the selected issue outlined in white on top. Drawn without depth test so the
 * ortho tiles never hide them.
 */
function createDrape(handle: SceneHandle) {
  const group = new Group();
  group.name = 'annotate-map-shapes';
  handle.scene.add(group);
  const lineMat = new LineBasicMaterial({
    vertexColors: true,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const fillMat = new MeshBasicMaterial({
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.2,
    side: DoubleSide,
  });
  const selMat = new LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
  let lines: LineSegments | null = null;
  let fill: Mesh | null = null;
  let sel: LineSegments | null = null;
  let faceIssue: string[] = [];
  const clear = (o: LineSegments | Mesh | null) => {
    if (!o) return;
    group.remove(o);
    o.geometry.dispose();
  };
  return {
    /** Every shape again (issues or project changed). */
    shapes(issues: DrapeIssues, models: DrapeModels, toLocal: MapToLocal | null) {
      clear(lines);
      clear(fill);
      lines = null;
      fill = null;
      faceIssue = [];
      if (!toLocal) return;
      const d = drapedShapes(issues, models, null, toLocal, DRAPE_Y);
      if (d.lines.positions.length) {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(d.lines.positions, 3));
        g.setAttribute('color', new BufferAttribute(d.lines.colors, 3));
        lines = new LineSegments(g, lineMat);
        lines.renderOrder = 901;
        lines.frustumCulled = false;
        group.add(lines);
      }
      if (d.fill.indices.length) {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(d.fill.positions, 3));
        g.setAttribute('color', new BufferAttribute(d.fill.colors, 3));
        g.setIndex(d.fill.indices);
        g.computeBoundingSphere();
        fill = new Mesh(g, fillMat);
        fill.renderOrder = 900;
        faceIssue = d.fill.faceIssue;
        group.add(fill);
      }
      handle.requestRender();
    },
    /** Outline the selected issue (or nothing). */
    select(issue: DrapeIssues[number] | null, models: DrapeModels, toLocal: MapToLocal | null) {
      clear(sel);
      sel = null;
      if (issue && toLocal) {
        const d = drapedShapes([issue], models, issue.id, toLocal, DRAPE_Y);
        if (d.selected) {
          const g = new BufferGeometry();
          g.setAttribute('position', new BufferAttribute(d.selected.positions, 3));
          sel = new LineSegments(g, selMat);
          sel.renderOrder = 902;
          sel.frustumCulled = false;
          group.add(sel);
        }
      }
      handle.requestRender();
    },
    /** The issue whose draped fill is under the ray, if any. */
    pick(rc: Raycaster): string | null {
      if (!fill) return null;
      const hit = rc.intersectObject(fill, false)[0];
      const face = hit?.faceIndex;
      return face !== undefined && face !== null ? (faceIssue[face] ?? null) : null;
    },
    dispose() {
      clear(lines);
      clear(fill);
      clear(sel);
      handle.scene.remove(group);
      lineMat.dispose();
      fillMat.dispose();
      selMat.dispose();
    },
  };
}

/**
 * Draw every issue with a 3D anchor as a pin (severity colour, code label) in the active scene,
 * keep pins a constant size on screen, and select an issue when its pin is clicked. Follows the
 * active scene through `onActiveScene`. Returns an uninstall function.
 */
export function installIssueOverlay(store: StoreApi<Workspace>): () => void {
  let detach: (() => void) | null = null;

  const attach = (handle: SceneHandle) => {
    const group = new Group();
    group.name = 'annotate-issue-pins';
    handle.scene.add(group);
    const sphere = new SphereGeometry(1, 16, 12);
    let pins: IssuePin[] = [];
    let pinPoints: Vector3[] = [];
    // component callouts keep their plates off the pins and codes
    const offObstacles = isEngineStage(handle) ? handle.addLabelObstacles(() => pinPoints) : null;
    const drape = createDrape(handle);
    let toLocal: MapToLocal | null = null;
    const drapeAll = () => {
      const s = store.getState();
      const m = s.project?.manifest;
      toLocal = m ? mapToLocal(m.crs, m.origin) : null;
      drape.shapes(s.issues, m?.severityModels ?? [], toLocal);
    };
    const drapeSelection = () => {
      const s = store.getState();
      const id = s.selection?.kind === 'issue' ? s.selection.id : null;
      drape.select(
        s.issues.find((x) => x.id === id) ?? null,
        s.project?.manifest.severityModels ?? [],
        toLocal,
      );
    };

    const rebuild = () => {
      for (const c of [...group.children]) {
        group.remove(c);
        disposeTree(c);
      }
      const s = store.getState();
      const sel = s.selection?.kind === 'issue' ? s.selection.id : null;
      pins = issuePins(s.issues, s.project?.manifest.severityModels ?? [], sel);
      pinPoints = pins.map((p) => new Vector3(...p.p));
      for (const pin of pins) {
        const node = new Group();
        node.position.set(...pin.p);
        node.userData.issueId = pin.issueId;
        node.userData.selected = pin.selected;
        const ball = new Mesh(
          sphere,
          new MeshBasicMaterial({
            color: pin.color,
            depthTest: false,
            transparent: true,
            opacity: pin.draft ? 0.7 : 1,
          }),
        );
        ball.renderOrder = 1000;
        ball.userData.issueId = pin.issueId;
        node.add(ball);
        const label = labelSprite(pin.code, pin.color);
        if (label) node.add(label);
        group.add(node);
      }
      handle.requestRender();
    };

    const v = new Vector3();
    const offFrame = handle.onFrame(() => {
      const cam = handle.camera;
      const h = handle.renderer.domElement.clientHeight || 1;
      const perPx = (d: number) => (2 * d * Math.tan((cam.fov * Math.PI) / 360)) / h;
      for (const node of group.children) {
        const d = v.copy(node.position).distanceTo(cam.position);
        const px = perPx(d);
        const sel = node.userData.selected === true;
        const ball = node.children[0];
        ball?.scale.setScalar(px * (sel ? PIN_PX * 1.5 : PIN_PX));
        const label = node.children[1] as Sprite | undefined;
        if (label) {
          const aspect = (label.userData as { aspect?: number }).aspect ?? 3;
          label.scale.set(px * 17 * aspect, px * 17, 1);
          label.position.set(0, 0, 0);
        }
      }
    });

    const unsub = store.subscribe((s, prev) => {
      if (
        s.issues !== prev.issues ||
        s.selection !== prev.selection ||
        s.project !== prev.project
      ) {
        rebuild();
      }
      if (s.issues !== prev.issues || s.project !== prev.project) drapeAll();
      if (s.issues !== prev.issues || s.selection !== prev.selection || s.project !== prev.project)
        drapeSelection();
    });

    const el = handle.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    const rc = new Raycaster();
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) {
        down = null;
        return;
      }
      down = null;
      const [x, y] = ndcOf(e, el);
      rc.setFromCamera(new Vector2(x, y), handle.camera);
      const hit = rc.intersectObjects(group.children, true).find((h) => h.object.userData.issueId);
      const id = (hit?.object.userData.issueId as string | undefined) ?? drape.pick(rc);
      if (id) store.getState().select({ kind: 'issue', id });
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    rebuild();
    drapeAll();
    drapeSelection();

    detach = () => {
      unsub();
      offFrame();
      offObstacles?.();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      handle.scene.remove(group);
      disposeTree(group);
      drape.dispose();
      sphere.dispose();
      handle.requestRender();
    };
  };

  const off = onActiveScene((h) => {
    detach?.();
    detach = null;
    if (h) attach(h);
  });
  const current = getActiveScene();
  if (current) attach(current);
  return () => {
    off();
    detach?.();
    detach = null;
  };
}
