/**
 * The point cloud clip box gizmo (cleanup, FUS-9): a wire box, six face handles that drag along
 * their normals (the size snaps to 0.1 m, the opposite face stays put), a ring above the top face
 * that turns the box about the vertical axis, all in the local frame (x east, y up, z south). The
 * app owns the box (world coordinates in the recipe) and converts; this file only edits.
 */
import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  SphereGeometry,
  Vector2,
  Vector3,
  type Camera,
} from 'three';
import type { EngineStage } from '../types';

export interface ClipBoxLocal {
  center: [number, number, number];
  /** Along the box's east, north and up axes, metres. */
  size: [number, number, number];
  /** Radians about up, east toward north (the recipe's yaw). */
  yaw: number;
}
export type BoxFace = 'east' | 'west' | 'north' | 'south' | 'top' | 'bottom';
export type BoxHandle = BoxFace | 'ring';

export const SNAP_M = 0.1;
export const MIN_SIZE_M = 0.1;
const FACES: readonly BoxFace[] = ['east', 'west', 'north', 'south', 'top', 'bottom'];
const AXIS: Record<BoxFace, 0 | 1 | 2> = {
  east: 0,
  west: 0,
  north: 1,
  south: 1,
  top: 2,
  bottom: 2,
};
const SIGN: Record<BoxFace, 1 | -1> = {
  east: 1,
  west: -1,
  north: 1,
  south: -1,
  top: 1,
  bottom: -1,
};

export function boxAxes(yaw: number): { east: Vector3; north: Vector3; up: Vector3 } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // world east (c, s) and north (-s, c) in E, N; local x = E, z = -N
  return { east: new Vector3(c, 0, -s), north: new Vector3(-s, 0, -c), up: new Vector3(0, 1, 0) };
}

export function faceNormal(face: BoxFace, yaw: number): Vector3 {
  const a = boxAxes(yaw);
  const axis = [a.east, a.north, a.up][AXIS[face]] ?? a.up;
  return axis.multiplyScalar(SIGN[face]);
}

export function faceCentre(box: ClipBoxLocal, face: BoxFace): Vector3 {
  const half = box.size[AXIS[face]] / 2;
  return new Vector3(...box.center).addScaledVector(faceNormal(face, box.yaw), half);
}

/** Where along the line p + s d a ray o + t r passes closest; null when they are parallel. */
export function closestOnLine(p: Vector3, d: Vector3, o: Vector3, r: Vector3): number | null {
  const w = p.clone().sub(o);
  const a = d.dot(d);
  const b = d.dot(r);
  const c = r.dot(r);
  const dd = d.dot(w);
  const e = r.dot(w);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-9) return null;
  return (b * e - c * dd) / den;
}

/** The box with one face moved `along` metres outward (negative: inward), snapped. */
export function dragFace(start: ClipBoxLocal, face: BoxFace, along: number): ClipBoxLocal {
  const axis = AXIS[face];
  const raw = start.size[axis] + along;
  const size = Math.max(MIN_SIZE_M, Math.round(raw / SNAP_M) * SNAP_M);
  const grow = size - start.size[axis];
  const c = new Vector3(...start.center).addScaledVector(faceNormal(face, start.yaw), grow / 2);
  const next: [number, number, number] = [...start.size];
  next[axis] = size;
  return { center: [c.x, c.y, c.z], size: next, yaw: start.yaw };
}

/** Heading of `at` seen from `center` on the horizontal plane, east toward north. */
export function headingOf(center: Vector3, at: Vector3): number {
  return Math.atan2(-(at.z - center.z), at.x - center.x);
}

const projected = new Vector3();

/** Handles closer together on screen than this count as one spot: the nearer to the eye wins. */
const TIE_PX = 0.5;

/**
 * The handle nearest to the pointer on screen, within `radiusPx` CSS pixels. Handles that overlap
 * on screen (top and bottom seen from straight above) go to the one nearer the camera.
 */
export function pickHandle(
  points: readonly { id: BoxHandle; at: Vector3 }[],
  camera: Camera,
  ndc: { x: number; y: number },
  size: { w: number; h: number },
  radiusPx = 14,
): BoxHandle | null {
  let best: BoxHandle | null = null;
  let bestD = Infinity;
  let bestZ = Infinity;
  for (const p of points) {
    projected.copy(p.at).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const dx = ((projected.x - ndc.x) * size.w) / 2;
    const dy = ((projected.y - ndc.y) * size.h) / 2;
    const d = Math.hypot(dx, dy);
    if (d > radiusPx) continue;
    if (d < bestD - TIE_PX || (d <= bestD + TIE_PX && projected.z < bestZ)) {
      bestD = d;
      bestZ = projected.z;
      best = p.id;
    }
  }
  return best;
}

export function formatBoxSize(box: ClipBoxLocal): [string, string, string] {
  return [box.size[0].toFixed(1), box.size[1].toFixed(1), box.size[2].toFixed(1)];
}

/** Turn a yaw into (-pi, pi], so a ring dragged round several times stays a tidy number. */
function wrapYaw(yaw: number): number {
  const t = yaw - 2 * Math.PI * Math.floor((yaw + Math.PI) / (2 * Math.PI));
  return t === -Math.PI ? Math.PI : t;
}

const COLOUR = 0xffb020;

export class ClipBoxTool {
  readonly group = new Group();
  private box: ClipBoxLocal;
  private readonly wire: LineSegments;
  private readonly ring: LineLoop;
  private readonly ball = new SphereGeometry(1, 12, 8);
  private readonly lineMat: LineBasicMaterial;
  private readonly knobMat: MeshBasicMaterial;
  private readonly knobs = new Map<BoxFace, Mesh>();
  private drag:
    | { kind: 'face'; face: BoxFace; start: ClipBoxLocal; t0: number }
    | { kind: 'ring'; start: ClipBoxLocal; h0: number }
    | null = null;
  private readonly ray = new Raycaster();

  constructor(
    private readonly stage: EngineStage,
    private readonly opts: { box: ClipBoxLocal; onChange(box: ClipBoxLocal, done: boolean): void },
  ) {
    this.box = opts.box;
    this.group.name = 'engine:clipbox';
    this.group.renderOrder = 31;
    this.lineMat = new LineBasicMaterial({ color: COLOUR, depthTest: false, transparent: true });
    this.wire = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), this.lineMat);
    const pts = Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return new Vector3(Math.cos(a), 0, Math.sin(a));
    });
    this.ring = new LineLoop(new BufferGeometry().setFromPoints(pts), this.lineMat);
    this.knobMat = new MeshBasicMaterial({ color: COLOUR, depthTest: false, transparent: true });
    for (const f of FACES) {
      const m = new Mesh(this.ball, this.knobMat);
      m.name = `engine:clipbox:${f}`;
      this.knobs.set(f, m);
      this.group.add(m);
    }
    this.group.add(this.wire, this.ring);
    for (const o of [this.wire, this.ring, ...this.knobs.values()]) {
      o.raycast = () => undefined;
      o.frustumCulled = false;
      o.renderOrder = 31;
    }
    this.sync();
  }

  setBox(box: ClipBoxLocal): void {
    this.box = box;
    this.sync();
  }

  /** Screen position (client pixels) of a handle, for the e2e specs. */
  handleScreen(h: BoxHandle): { x: number; y: number } | null {
    const at = h === 'ring' ? this.ringPoint() : faceCentre(this.box, h);
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const p = at.project(this.stage.camera);
    if (p.z < -1 || p.z > 1) return null;
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  attach(): () => void {
    const canvas = this.stage.renderer.domElement;
    this.stage.scene.add(this.group);
    const offFrame = this.stage.onFrame(() => {
      this.scaleKnobs();
    });
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const ndc = this.ndc(e);
      const r = canvas.getBoundingClientRect();
      const hit = pickHandle(this.handles(), this.stage.camera, ndc, { w: r.width, h: r.height });
      if (!hit) return;
      this.ray.setFromCamera(new Vector2(ndc.x, ndc.y), this.stage.camera);
      if (hit === 'ring') {
        const at = this.onTopPlane();
        this.drag = at
          ? { kind: 'ring', start: this.box, h0: headingOf(new Vector3(...this.box.center), at) }
          : null;
      } else {
        const t0 = closestOnLine(
          faceCentre(this.box, hit),
          faceNormal(hit, this.box.yaw),
          this.ray.ray.origin,
          this.ray.ray.direction,
        );
        // null: the face's normal points along the view ray, so the pointer cannot move it
        this.drag = t0 === null ? null : { kind: 'face', face: hit, start: this.box, t0 };
      }
      if (!this.drag) return;
      // The handle takes the press: neither the orbit controls nor the stage's click see it.
      e.stopImmediatePropagation();
      this.stage.controls.enabled = false;
    };
    const move = (e: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      const ndc = this.ndc(e);
      this.ray.setFromCamera(new Vector2(ndc.x, ndc.y), this.stage.camera);
      if (d.kind === 'face') {
        const t = closestOnLine(
          faceCentre(d.start, d.face),
          faceNormal(d.face, d.start.yaw),
          this.ray.ray.origin,
          this.ray.ray.direction,
        );
        if (t === null) return;
        this.setBox(dragFace(d.start, d.face, t - d.t0));
      } else {
        const at = this.onTopPlane(d.start);
        if (!at) return;
        const h = headingOf(new Vector3(...d.start.center), at);
        this.setBox({ ...d.start, yaw: wrapYaw(d.start.yaw + (h - d.h0)) });
      }
      this.opts.onChange(this.box, false);
      this.stage.requestRender();
    };
    const up = () => {
      if (!this.drag) return;
      this.drag = null;
      this.stage.controls.enabled = true;
      this.opts.onChange(this.box, true);
    };
    canvas.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.stage.requestRender();
    return () => {
      canvas.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      offFrame();
      if (this.drag) this.stage.controls.enabled = true;
      this.drag = null;
      this.group.removeFromParent();
      this.wire.geometry.dispose();
      this.ring.geometry.dispose();
      this.ball.dispose();
      this.lineMat.dispose();
      this.knobMat.dispose();
      this.stage.requestRender();
    };
  }

  private ndc(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -((e.clientY - r.top) / r.height) * 2 + 1,
    };
  }

  private ringRadius(box: ClipBoxLocal): number {
    return Math.max(box.size[0], box.size[1]) * 0.6;
  }

  /** The ring's handle: on the ring, over the box's east axis. */
  private ringPoint(): Vector3 {
    const top = faceCentre(this.box, 'top');
    return top.addScaledVector(boxAxes(this.box.yaw).east, this.ringRadius(this.box));
  }

  private handles(): { id: BoxHandle; at: Vector3 }[] {
    return [
      ...FACES.map((f) => ({ id: f, at: faceCentre(this.box, f) })),
      { id: 'ring' as const, at: this.ringPoint() },
    ];
  }

  /** The pointer ray on the horizontal plane through the top face of `box`. */
  private onTopPlane(box: ClipBoxLocal = this.box): Vector3 | null {
    const top = faceCentre(box, 'top');
    const plane = new Plane(new Vector3(0, 1, 0), -top.y);
    return this.ray.ray.intersectPlane(plane, new Vector3());
  }

  private sync(): void {
    const [cx, cy, cz] = this.box.center;
    this.wire.position.set(cx, cy, cz);
    // rotation.y = yaw turns local +x toward -z (north), as boxAxes does
    this.wire.rotation.set(0, this.box.yaw, 0);
    // BoxGeometry x is east, y up, z south: size [east, north, up] -> scale [east, up, north]
    this.wire.scale.set(this.box.size[0], this.box.size[2], this.box.size[1]);
    this.ring.position.copy(faceCentre(this.box, 'top'));
    this.ring.scale.setScalar(this.ringRadius(this.box));
    for (const f of FACES) this.knobs.get(f)?.position.copy(faceCentre(this.box, f));
    this.scaleKnobs();
    this.stage.requestRender();
  }

  /** Handles keep about 7 pixels on screen whatever the distance. */
  private scaleKnobs(): void {
    const cam = this.stage.camera;
    const h = this.stage.renderer.domElement.clientHeight || 1;
    const perPx = (d: number) => (2 * d * Math.tan((cam.fov * Math.PI) / 360)) / h;
    for (const m of this.knobs.values())
      m.scale.setScalar(perPx(cam.position.distanceTo(m.position)) * 7);
  }
}
