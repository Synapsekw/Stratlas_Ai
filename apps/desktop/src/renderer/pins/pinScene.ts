import { isEngineStage, markersHit, type SceneHandle } from '@aio/engine';
import { bearingDeg } from '@aio/geo';
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  type Material,
  Mesh,
  MeshBasicMaterial,
  Vector2,
  Vector3,
} from 'three';
import { type DrawnPin, keyString, type MediaKey } from './pinModel';

/*
 * Pinned media in the 3D view: per pin a ground ring, a stem up to eye height and, once the pin
 * has a heading, a flat arrow on the ground the person can drag to turn it. Drawn over the model
 * (no depth test). Positions come in already in the drawn frame (`drawnPins`), never shifted here.
 * The orbit controls go off while an arrow is held, as in `walks/walkScene.ts`.
 */

export const PIN_SCENE_GROUP = 'aio-media-pins';
export const PIN_RING_NAME = 'aio-pin-ring';
export const PIN_STEM_NAME = 'aio-pin-stem';
export const PIN_ARROW_NAME = 'aio-pin-arrow';

const RING_RADIUS_M = 0.3;
const ARROW_LENGTH_M = 1.2;
const ARROW_HALF_WIDTH_M = 0.25;
const LIFT_M = 0.05;
const RING_SEGMENTS = 32;
/** A press this close to an arrow (screen px) grabs it. */
const GRAB_PX = 12;
const COLOUR = '#ffffff';
const COLOUR_SELECTED = '#ffcf4a';
const ORDER = 47;

export interface PinSceneCallbacks {
  onArrowDrop(key: MediaKey, headingDeg: number): void;
}
export interface PinSceneView {
  /** Draw `pins`; `selected` is a `keyString` drawn in the accent colour, or null. */
  update(pins: readonly DrawnPin[], selected: string | null): void;
  dispose(): void;
}

function arrowMesh(hex: string): Mesh {
  // a flat arrow lying on the ground, pointing north (-z) in its own frame
  const L = ARROW_LENGTH_M;
  const w = ARROW_HALF_WIDTH_M;
  const s = w * 0.3;
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        0,
        0,
        -L,
        -w,
        0,
        -L * 0.55,
        w,
        0,
        -L * 0.55,
        -s,
        0,
        -L * 0.55,
        s,
        0,
        -L * 0.55,
        -s,
        0,
        0,
        s,
        0,
        0,
      ],
      3,
    ),
  );
  g.setIndex([0, 1, 2, 3, 5, 4, 4, 5, 6]);
  return new Mesh(
    g,
    new MeshBasicMaterial({
      color: new Color(hex),
      depthTest: false,
      fog: false,
      transparent: true,
      opacity: 0.9,
      side: DoubleSide,
    }),
  );
}

const lineMaterial = (hex: string): LineBasicMaterial =>
  new LineBasicMaterial({ color: new Color(hex), depthTest: false, fog: false, transparent: true });

export function attachPinScene(scene: SceneHandle, cb: PinSceneCallbacks): PinSceneView {
  const stage = isEngineStage(scene) ? scene : null;
  const group = new Group();
  group.name = PIN_SCENE_GROUP;
  group.renderOrder = ORDER;
  scene.scene.add(group);
  const canvas = scene.renderer.domElement;

  let pins: readonly DrawnPin[] = [];
  let selected: string | null = null;
  let drag: { pin: DrawnPin; deg: number | null } | null = null;

  const clear = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const o = c as unknown as { geometry?: BufferGeometry; material?: Material | Material[] };
      o.geometry?.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    }
  };

  const headingOf = (p: DrawnPin): number | undefined =>
    drag && drag.deg !== null && keyString(drag.pin.key) === keyString(p.key)
      ? drag.deg
      : p.headingDeg;

  const redraw = () => {
    clear();
    for (const p of pins) {
      const id = keyString(p.key);
      const hex = id === selected ? COLOUR_SELECTED : COLOUR;
      const ring: number[] = [];
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * Math.PI * 2;
        ring.push(
          p.ground[0] + Math.cos(a) * RING_RADIUS_M,
          p.ground[1] + LIFT_M,
          p.ground[2] + Math.sin(a) * RING_RADIUS_M,
        );
      }
      const rg = new BufferGeometry();
      rg.setAttribute('position', new Float32BufferAttribute(ring, 3));
      const r = new LineLoop(rg, lineMaterial(hex));
      r.name = PIN_RING_NAME;
      const sg = new BufferGeometry();
      sg.setAttribute('position', new Float32BufferAttribute([...p.ground, ...p.eye], 3));
      const s = new Line(sg, lineMaterial(hex));
      s.name = PIN_STEM_NAME;
      for (const o of [r, s]) {
        o.renderOrder = ORDER;
        o.userData.key = id;
        group.add(o);
      }
      const deg = headingOf(p);
      if (p.linedUp && deg !== undefined) {
        const a = arrowMesh(hex);
        a.name = PIN_ARROW_NAME;
        a.renderOrder = ORDER;
        a.userData.key = id;
        a.position.set(p.ground[0], p.ground[1] + LIFT_M, p.ground[2]);
        // heading runs clockwise from north (-z) seen from above: a turn of -heading about +y
        a.rotation.y = (-deg * Math.PI) / 180;
        a.updateMatrixWorld(true);
        group.add(a);
      }
    }
    scene.requestRender();
  };

  const tmp = new Vector3();
  const screenOf = (v: Vector3): Vector2 | null => {
    tmp.copy(v).project(scene.camera);
    if (tmp.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return new Vector2(r.left + ((tmp.x + 1) / 2) * r.width, r.top + ((1 - tmp.y) / 2) * r.height);
  };
  const distToSegment = (p: Vector2, a: Vector2, b: Vector2): number => {
    const ab = b.clone().sub(a);
    const len2 = ab.lengthSq();
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2));
    return p.distanceTo(a.clone().add(ab.multiplyScalar(t)));
  };
  /** The pin whose arrow the press is on (nearest within GRAB_PX), or null. */
  const arrowAt = (e: { clientX: number; clientY: number }): DrawnPin | null => {
    const at = new Vector2(e.clientX, e.clientY);
    let best: DrawnPin | null = null;
    let bestD = GRAB_PX;
    for (const o of group.children) {
      if (o.name !== PIN_ARROW_NAME) continue;
      const p = pins.find((x) => keyString(x.key) === o.userData.key);
      if (!p) continue;
      o.updateMatrixWorld(true);
      const a = screenOf(o.localToWorld(new Vector3(0, 0, 0)));
      const b = screenOf(o.localToWorld(new Vector3(0, 0, -ARROW_LENGTH_M)));
      if (!a || !b) continue;
      const d = distToSegment(at, a, b);
      if (d <= bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };
  const groundAt = (e: { clientX: number; clientY: number }): Vector3 | null => {
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    const hit = scene.raycast(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    return hit ? hit.point : null;
  };

  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const hit = groundAt(e);
    if (!hit) return;
    const deg = bearingDeg(drag.pin.ground, [hit.x, hit.y, hit.z]);
    if (deg === null) return;
    drag.deg = deg;
    redraw();
  };
  /** End a drag; a release drops the heading, a cancel or lost focus keeps the old one. */
  function end(drop: boolean) {
    const d = drag;
    if (!d) return;
    drag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onCancel);
    if (stage) stage.controls.enabled = true;
    redraw();
    if (drop && d.deg !== null) cb.onArrowDrop(d.pin.key, d.deg);
  }
  function onUp() {
    end(true);
  }
  function onCancel() {
    end(false);
  }
  const onDown = (e: PointerEvent) => {
    // a photo or 360 marker over the arrow keeps its click (a pin's 360 marker stands on it)
    if (e.button !== 0 || markersHit(canvas, e.clientX, e.clientY)) return;
    const p = arrowAt(e);
    if (!p) return;
    drag = { pin: p, deg: null };
    if (stage) stage.controls.enabled = false;
    e.stopImmediatePropagation();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  };
  // the stage reports a grab that barely moved as a click before the window sees the release
  const offClaim = stage?.claimClicks(() => drag !== null);
  canvas.addEventListener('pointerdown', onDown, { capture: true });
  window.addEventListener('pointerup', onUp);

  return {
    update: (next, sel) => {
      pins = next;
      selected = sel;
      redraw();
    },
    dispose: () => {
      end(false);
      offClaim?.();
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointerup', onUp);
      clear();
      scene.scene.remove(group);
      scene.requestRender();
    },
  };
}
