import { Z_UP, upAxisOf, type UpAxis } from '@aio/geo';
import type { Mat4, Vec3 } from '@aio/schema';
import { Euler, MathUtils, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { EngineStage } from '../types';

/**
 * Place model: a move, turn, tilt and scale handle on a mesh layer in the 3D view, and the maths
 * between a layer transform and the numbers a person types (anchor, heading, tilts, scale).
 *
 * The local frame is x east, y up, z south. Heading is the clockwise turn of the model's north
 * (-z) from grid north, seen from above; tilts turn about the model's own x and z axes after the
 * heading; the scale is uniform. A Z-up model (survey and photogrammetry exports) is stood upright
 * first, as `withUpAxis` does.
 */
export type GizmoMode = 'move' | 'rotate' | 'tilt' | 'scale';

export interface Placement {
  /** Where the model origin sits, in the local frame. */
  anchor: Vec3;
  headingDeg: number;
  tiltXDeg: number;
  tiltZDeg: number;
  scale: number;
}

export interface PlaceGizmo {
  attach(layerId: string, transform: Mat4): void;
  setMode(m: GizmoMode): void;
  onChange(cb: (t: Mat4) => void): () => void;
  detach(): void;
}

/** The gizmo with what the Place model panel and tests use beside the interface. */
export interface PlaceGizmoHandle extends PlaceGizmo {
  /** Show a transform typed in the panel (moves the model and the handle; no onChange). */
  set(transform: Mat4): void;
  /** A drag on a handle starts (true) or ends (false): one Undo step per drag. */
  onDrag(cb: (dragging: boolean) => void): () => void;
  /** The object the handle drags (a stand-in for the layer, at its placement). */
  readonly target: Object3D;
  /** The three.js handle while attached. */
  readonly controls: TransformControls;
}

const UP_MATRIX: Record<UpAxis, Matrix4> = {
  y: new Matrix4(),
  z: new Matrix4().fromArray(Z_UP),
};
const UP_INVERSE: Record<UpAxis, Matrix4> = {
  y: new Matrix4(),
  z: new Matrix4().fromArray(Z_UP).invert(),
};

/** (-180, 180]. */
function wrapDeg(d: number): number {
  let h = d % 360;
  if (h <= -180) h += 360;
  if (h > 180) h -= 360;
  return h;
}

function rotationOf(p: Pick<Placement, 'headingDeg' | 'tiltXDeg' | 'tiltZDeg'>): Quaternion {
  // three's YXZ order is Ry * Rx * Rz; a clockwise heading is a negative turn about +y
  return new Quaternion().setFromEuler(
    new Euler(
      MathUtils.degToRad(p.tiltXDeg),
      MathUtils.degToRad(-p.headingDeg),
      MathUtils.degToRad(p.tiltZDeg),
      'YXZ',
    ),
  );
}

/** The layer transform of a placement: anchor, then heading, tilts and uniform scale. */
export function composePlacement(o: Placement & { up: UpAxis }): Mat4 {
  const m = new Matrix4().compose(
    new Vector3(...o.anchor),
    rotationOf(o),
    new Vector3(o.scale, o.scale, o.scale),
  );
  return m.multiply(UP_MATRIX[o.up]).toArray();
}

/** The placement of a layer transform (`up`: the model's up axis, `upAxisOf` by default). */
export function decomposePlacement(t: Mat4, up: UpAxis = upAxisOf(t)): Placement {
  const m = new Matrix4().fromArray([...t]).multiply(UP_INVERSE[up]);
  const pos = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(pos, q, s);
  const e = new Euler().setFromQuaternion(q, 'YXZ');
  return {
    anchor: [pos.x, pos.y, pos.z],
    headingDeg: wrapDeg(-MathUtils.radToDeg(e.y)),
    tiltXDeg: MathUtils.radToDeg(e.x),
    tiltZDeg: MathUtils.radToDeg(e.z),
    scale: (s.x + s.y + s.z) / 3,
  };
}

interface StageExtras {
  invalidateShadows(): void;
}

/**
 * A TransformControls handle for one mesh layer at a time: move along east, north and up; turn
 * about the vertical; tilt about the level axes; scale uniformly. The camera stops orbiting while
 * a handle is dragged, and a click on a handle is not a selection. Every change moves the layer
 * at once and is reported through `onChange`; nothing is saved here.
 */
export function createPlaceGizmo(stage: EngineStage): PlaceGizmoHandle {
  const listeners = new Set<(t: Mat4) => void>();
  const dragListeners = new Set<(dragging: boolean) => void>();
  const target = new Object3D();
  target.name = 'engine:place-target';
  let controls: TransformControls | null = null;
  let layer: Object3D | null = null;
  let up: UpAxis = 'y';
  let mode: GizmoMode = 'move';
  let unclaim: (() => void) | null = null;
  let lastScale = 1;

  const transformOf = (): Mat4 => {
    target.updateMatrix();
    return target.matrix.clone().multiply(UP_MATRIX[up]).toArray();
  };
  let layerName = '';
  /** The layer's group; a layer loaded again (after a save) is a new group, found by name. */
  const layerObject = (): Object3D | null => {
    if (!layer?.parent) layer = layerName ? (stage.scene.getObjectByName(layerName) ?? null) : null;
    return layer;
  };
  const show = (t: Mat4) => {
    const group = layerObject();
    if (!group) return;
    group.matrix.fromArray([...t]);
    group.updateMatrixWorld(true);
    (stage as unknown as Partial<StageExtras>).invalidateShadows?.();
    stage.requestRender();
  };
  const place = (t: Mat4) => {
    const p = decomposePlacement(t, up);
    target.position.set(...p.anchor);
    target.quaternion.copy(rotationOf(p));
    target.scale.setScalar(p.scale);
    lastScale = p.scale;
    target.updateMatrixWorld(true);
  };
  const applyMode = () => {
    if (!controls) return;
    const c = controls;
    c.showX = mode !== 'rotate';
    c.showY = mode !== 'tilt';
    c.showZ = mode !== 'rotate';
    if (mode === 'move') {
      c.setMode('translate');
      c.setSpace('world');
    } else if (mode === 'rotate') {
      c.setMode('rotate');
      c.setSpace('world');
    } else if (mode === 'tilt') {
      c.setMode('rotate');
      c.setSpace('local');
    } else {
      c.setMode('scale');
      c.setSpace('local');
    }
    stage.requestRender();
  };
  const onObjectChange = () => {
    if (mode === 'scale') {
      // uniform: the axis the person pulled sets all three
      const s = target.scale;
      const pulled = [s.x, s.y, s.z].reduce((a, b) =>
        Math.abs(b - lastScale) > Math.abs(a - lastScale) ? b : a,
      );
      const v = Math.max(1e-6, Math.abs(pulled));
      s.setScalar(v);
      lastScale = v;
    }
    const t = transformOf();
    show(t);
    for (const l of listeners) l(t);
  };
  const onDragging = (e: { value: unknown }) => {
    const dragging = e.value === true;
    stage.controls.enabled = !dragging;
    for (const l of dragListeners) l(dragging);
  };
  const onRender = () => {
    stage.requestRender();
  };

  const handle: PlaceGizmoHandle = {
    get target() {
      return target;
    },
    get controls() {
      if (!controls) throw new Error('The place gizmo is not attached');
      return controls;
    },
    attach(layerId, transform) {
      handle.detach();
      layerName = `layer:${layerId}`;
      layer = stage.scene.getObjectByName(layerName) ?? null;
      up = upAxisOf(transform);
      place(transform);
      stage.scene.add(target);
      const c = new TransformControls(stage.camera, stage.renderer.domElement);
      controls = c;
      c.addEventListener('objectChange', onObjectChange);
      c.addEventListener('dragging-changed', onDragging);
      c.addEventListener('change', onRender);
      c.attach(target);
      const helper = c.getHelper();
      helper.name = 'engine:place-gizmo';
      stage.scene.add(helper);
      unclaim = stage.claimClicks(() => c.axis !== null || c.dragging);
      applyMode();
      show(transform);
    },
    set(transform) {
      place(transform);
      show(transform);
    },
    setMode(m) {
      mode = m;
      applyMode();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    onDrag(cb) {
      dragListeners.add(cb);
      return () => {
        dragListeners.delete(cb);
      };
    },
    detach() {
      unclaim?.();
      unclaim = null;
      if (controls) {
        const c = controls;
        c.removeEventListener('objectChange', onObjectChange);
        c.removeEventListener('dragging-changed', onDragging);
        c.removeEventListener('change', onRender);
        c.detach();
        stage.scene.remove(c.getHelper());
        c.dispose();
        controls = null;
        stage.controls.enabled = true;
      }
      stage.scene.remove(target);
      layer = null;
      layerName = '';
      stage.requestRender();
    },
  };
  return handle;
}
