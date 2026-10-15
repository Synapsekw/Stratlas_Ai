// @vitest-environment jsdom
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineStage } from '../types';
import {
  ClipBoxTool,
  boxAxes,
  closestOnLine,
  dragFace,
  faceCentre,
  faceNormal,
  formatBoxSize,
  headingOf,
  pickHandle,
  type ClipBoxLocal,
} from './clipbox';

const box: ClipBoxLocal = { center: [0, 5, 0], size: [10, 20, 4], yaw: 0 };

describe('clip box handle maths', () => {
  it('turns the box axes with the yaw (east toward north, local z is south)', () => {
    const a = boxAxes(Math.PI / 2);
    expect(a.east.x).toBeCloseTo(0, 9);
    expect(a.east.z).toBeCloseTo(-1, 9); // east turned a quarter points north
    expect(a.north.x).toBeCloseTo(-1, 9); // north turned a quarter points west
    expect(a.up.y).toBe(1);
  });

  it('puts face handles at the face centres', () => {
    expect(faceCentre(box, 'east').toArray()).toEqual([5, 5, 0]);
    expect(faceCentre(box, 'north').toArray()).toEqual([0, 5, -10]);
    expect(faceCentre(box, 'top').toArray()).toEqual([0, 7, 0]);
  });

  it('drags a face along its normal, snapping to 0.1 m, the opposite face fixed', () => {
    const b = dragFace(box, 'east', 1.234);
    expect(b.size[0]).toBeCloseTo(11.2, 9);
    expect(b.center[0]).toBeCloseTo(0.6, 9);
    expect(faceCentre(b, 'west').x).toBeCloseTo(-5, 9);
    const top = dragFace(box, 'top', -3);
    expect(top.size[2]).toBeCloseTo(1, 9);
    expect(top.center[1]).toBeCloseTo(3.5, 9);
  });

  it('never shrinks a face below 0.1 m', () => {
    expect(dragFace(box, 'south', -50).size[1]).toBeCloseTo(0.1, 9);
  });

  it('finds where a pointer ray passes closest to a handle line', () => {
    // the line is the x axis; a ray straight down through x = 3
    const t = closestOnLine(
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(3, 10, 0),
      new Vector3(0, -1, 0),
    );
    expect(t).toBeCloseTo(3, 9);
    expect(
      closestOnLine(
        new Vector3(),
        new Vector3(1, 0, 0),
        new Vector3(0, 1, 0),
        new Vector3(1, 0, 0),
      ),
    ).toBeNull();
  });

  it('measures headings east toward north', () => {
    const c = new Vector3(0, 0, 0);
    expect(headingOf(c, new Vector3(1, 0, 0))).toBeCloseTo(0, 9);
    expect(headingOf(c, new Vector3(0, 0, -1))).toBeCloseTo(Math.PI / 2, 9); // north
  });

  it('picks the nearest handle within the radius', () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const pts = [
      { id: 'east' as const, at: new Vector3(0, 0, 0) },
      { id: 'west' as const, at: new Vector3(3, 0, 0) },
    ];
    expect(pickHandle(pts, camera, { x: 0.01, y: 0 }, { w: 500, h: 500 })).toBe('east');
    expect(pickHandle(pts, camera, { x: 0.9, y: 0.9 }, { w: 500, h: 500 })).toBeNull();
  });

  it('gives handles on top of each other on screen to the one nearer the camera', () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const near = { id: 'top' as const, at: new Vector3(0, 0, 2) };
    const far = { id: 'bottom' as const, at: new Vector3(0, 0, -2) };
    const size = { w: 500, h: 500 };
    expect(pickHandle([far, near], camera, { x: 0, y: 0 }, size)).toBe('top');
    expect(pickHandle([near, far], camera, { x: 0, y: 0 }, size)).toBe('top');
  });

  it('reads the size in metres with one decimal', () => {
    expect(formatBoxSize({ ...box, size: [12.04, 8.46, 4] })).toEqual(['12.0', '8.5', '4.0']);
  });
});

const OPPOSITE = {
  east: 'west',
  west: 'east',
  north: 'south',
  south: 'north',
  top: 'bottom',
  bottom: 'top',
} as const;

describe('clip box on a turned box', () => {
  const turned: ClipBoxLocal = { center: [1, 2, 3], size: [6, 4, 2], yaw: Math.PI / 6 };

  it('points each face normal out of its face and opposite its partner', () => {
    for (const face of ['east', 'north', 'top'] as const) {
      const n = faceNormal(face, turned.yaw);
      expect(n.length()).toBeCloseTo(1, 9);
      expect(n.dot(faceNormal(OPPOSITE[face], turned.yaw))).toBeCloseTo(-1, 9);
      const out = faceCentre(turned, face).sub(new Vector3(...turned.center));
      expect(out.normalize().dot(n)).toBeCloseTo(1, 9);
    }
  });

  it('keeps the opposite face where it was when a turned face is dragged', () => {
    for (const face of ['east', 'west', 'north', 'south', 'top', 'bottom'] as const) {
      const before = faceCentre(turned, OPPOSITE[face]);
      const after = dragFace(turned, face, 0.73);
      expect(faceCentre(after, OPPOSITE[face]).distanceTo(before)).toBeLessThan(1e-9);
      // the dragged face moved outward by the snapped 0.7 m along its normal
      const moved = faceCentre(after, face).sub(faceCentre(turned, face));
      expect(moved.dot(faceNormal(face, turned.yaw))).toBeCloseTo(0.7, 9);
      expect(after.yaw).toBe(turned.yaw);
    }
  });

  it('measures headings the way the box axes turn', () => {
    const c = new Vector3(4, 0, -2);
    const yaw = 1.1;
    expect(headingOf(c, c.clone().add(boxAxes(yaw).east))).toBeCloseTo(yaw, 9);
    expect(headingOf(c, c.clone().add(boxAxes(yaw).north))).toBeCloseTo(yaw + Math.PI / 2, 9);
  });
});

/** A stage seen straight from above, north up the screen, on an 800 x 600 canvas. */
function fakeStage() {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) as DOMRect;
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  camera.position.set(0, 60, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const scene = new Scene();
  const controls = { enabled: true };
  const stage = {
    renderer: { domElement: canvas },
    camera,
    scene,
    controls,
    onFrame: () => () => undefined,
    requestRender: () => undefined,
  } as unknown as EngineStage;
  return { stage, canvas, camera, scene, controls };
}

const pointer = (type: string, at: { x: number; y: number }) =>
  new MouseEvent(type, { clientX: at.x, clientY: at.y, button: 0, bubbles: true });

function screenOf(camera: PerspectiveCamera, p: Vector3): { x: number; y: number } {
  const q = p.clone().project(camera);
  return { x: ((q.x + 1) / 2) * 800, y: ((1 - q.y) / 2) * 600 };
}

function lastChange(onChange: ReturnType<typeof vi.fn>): [ClipBoxLocal, boolean] {
  const call = onChange.mock.calls.at(-1);
  if (!call) throw new Error('onChange was not called');
  return call as [ClipBoxLocal, boolean];
}

describe('the clip box tool', () => {
  const start: ClipBoxLocal = { center: [0, 5, 0], size: [10, 20, 4], yaw: 0 };
  let detach: (() => void) | null = null;
  afterEach(() => {
    detach?.();
    detach = null;
  });

  it('drags the east face with the pointer and reports the end on release', () => {
    const { stage, canvas, camera, scene, controls } = fakeStage();
    const onChange = vi.fn();
    const tool = new ClipBoxTool(stage, { box: start, onChange });
    detach = tool.attach();
    expect(scene.children).toContain(tool.group);

    const other = vi.fn();
    canvas.addEventListener('pointerdown', other);
    const from = tool.handleScreen('east');
    if (!from) throw new Error('east handle off screen');
    canvas.dispatchEvent(pointer('pointerdown', from));
    expect(other).not.toHaveBeenCalled(); // the handle took the press
    expect(controls.enabled).toBe(false);

    // 2 m further east, on the knob's line (y 5, z 0)
    const to = screenOf(camera, new Vector3(7, 5, 0));
    window.dispatchEvent(pointer('pointermove', to));
    expect(lastChange(onChange)[1]).toBe(false);
    window.dispatchEvent(pointer('pointerup', to));
    const [box, done] = lastChange(onChange);
    expect(done).toBe(true);
    expect(controls.enabled).toBe(true);
    expect(box.size[0]).toBeCloseTo(12, 6);
    expect(box.center[0]).toBeCloseTo(1, 6);
    expect(faceCentre(box, 'west').x).toBeCloseTo(-5, 6);
    canvas.removeEventListener('pointerdown', other);
  });

  it('lets a press away from the handles through to the stage', () => {
    const { stage, canvas, controls } = fakeStage();
    const onChange = vi.fn();
    detach = new ClipBoxTool(stage, { box: start, onChange }).attach();
    const other = vi.fn();
    canvas.addEventListener('pointerdown', other);
    canvas.dispatchEvent(pointer('pointerdown', { x: 5, y: 5 }));
    window.dispatchEvent(pointer('pointermove', { x: 50, y: 50 }));
    window.dispatchEvent(pointer('pointerup', { x: 50, y: 50 }));
    expect(other).toHaveBeenCalledOnce();
    expect(controls.enabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    canvas.removeEventListener('pointerdown', other);
  });

  it('lets a press on a handle that points at the eye through (top, seen from above)', () => {
    const { stage, canvas, controls } = fakeStage();
    const onChange = vi.fn();
    const tool = new ClipBoxTool(stage, { box: start, onChange });
    detach = tool.attach();
    const other = vi.fn();
    canvas.addEventListener('pointerdown', other);
    const from = tool.handleScreen('top');
    if (!from) throw new Error('top handle off screen');
    canvas.dispatchEvent(pointer('pointerdown', from));
    expect(other).toHaveBeenCalledOnce();
    expect(controls.enabled).toBe(true);
    canvas.removeEventListener('pointerdown', other);
  });

  it('turns the box with the ring, east toward north for a positive yaw', () => {
    const { stage, canvas, camera } = fakeStage();
    const onChange = vi.fn();
    const tool = new ClipBoxTool(stage, { box: start, onChange });
    detach = tool.attach();
    const from = tool.handleScreen('ring');
    if (!from) throw new Error('ring handle off screen');
    canvas.dispatchEvent(pointer('pointerdown', from));
    // 30 degrees round toward north (local -z) on the ring's plane, the top face at y 7
    const a = Math.PI / 6;
    const to = screenOf(camera, new Vector3(Math.cos(a) * 12, 7, -Math.sin(a) * 12));
    window.dispatchEvent(pointer('pointermove', to));
    window.dispatchEvent(pointer('pointerup', to));
    const [box, done] = lastChange(onChange);
    expect(done).toBe(true);
    expect(box.yaw).toBeCloseTo(a, 6);
    expect(box.center).toEqual(start.center);
    expect(box.size).toEqual(start.size);
  });

  it('keeps the yaw within (-pi, pi] when the ring goes past west', () => {
    const { stage, canvas, camera } = fakeStage();
    const onChange = vi.fn();
    const tool = new ClipBoxTool(stage, { box: { ...start, yaw: 3 }, onChange });
    detach = tool.attach();
    const from = tool.handleScreen('ring');
    if (!from) throw new Error('ring handle off screen');
    canvas.dispatchEvent(pointer('pointerdown', from));
    const a = 3.4; // past pi
    const to = screenOf(camera, new Vector3(Math.cos(a) * 12, 7, -Math.sin(a) * 12));
    window.dispatchEvent(pointer('pointermove', to));
    window.dispatchEvent(pointer('pointerup', to));
    expect(lastChange(onChange)[0].yaw).toBeCloseTo(3.4 - 2 * Math.PI, 6);
  });

  it('draws the wire box where the face handles are, for a turned box', () => {
    const { stage } = fakeStage();
    const box: ClipBoxLocal = { center: [2, 5, -1], size: [10, 6, 4], yaw: 0.7 };
    const tool = new ClipBoxTool(stage, { box, onChange: () => undefined });
    const wire = tool.group.children.find((o) => o.type === 'LineSegments');
    if (!wire) throw new Error('no wire');
    wire.updateMatrixWorld(true);
    // the unit box's +x, +z and +y face centres, carried into the local frame by the wire
    const at = (x: number, y: number, z: number) =>
      new Vector3(x, y, z).applyMatrix4(wire.matrixWorld);
    expect(at(0.5, 0, 0).distanceTo(faceCentre(box, 'east'))).toBeLessThan(1e-9);
    expect(at(0, 0, 0.5).distanceTo(faceCentre(box, 'south'))).toBeLessThan(1e-9);
    expect(at(0, 0.5, 0).distanceTo(faceCentre(box, 'top'))).toBeLessThan(1e-9);
  });

  it('takes itself out of the scene and gives the controls back on detach', () => {
    const { stage, canvas, scene, controls } = fakeStage();
    const tool = new ClipBoxTool(stage, { box: start, onChange: () => undefined });
    const off = tool.attach();
    const from = tool.handleScreen('north');
    if (!from) throw new Error('north handle off screen');
    canvas.dispatchEvent(pointer('pointerdown', from));
    expect(controls.enabled).toBe(false);
    off();
    expect(controls.enabled).toBe(true);
    expect(scene.children).not.toContain(tool.group);
  });
});
