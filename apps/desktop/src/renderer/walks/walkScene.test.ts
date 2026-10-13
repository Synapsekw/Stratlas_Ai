// @vitest-environment jsdom
import { fitWalk } from '@aio/geo';
import type { EngineStage } from '@aio/engine';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  attachWalkScene,
  previewPoints,
  sceneRuns,
  WALK_PREVIEW_NAME,
  WALK_SCENE_GROUP,
} from './walkScene';

// jsdom has no PointerEvent: a MouseEvent carries every field these tests use
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {}
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventShim;
}

/** The slice of the stage the walk layer uses; the ray hits the ground at a set point. */
function fakeStage(hit: { x: number; y: number; z: number } | null) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const claims: ((e: PointerEvent) => boolean)[] = [];
  const camera = new PerspectiveCamera(60, 2, 0.1, 1000);
  camera.position.set(0, 50, 0);
  // looking straight down: up must not be parallel to the view
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const stage = {
    scene: new Scene(),
    camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    raycast: vi.fn(() => (hit ? { point: new Vector3(hit.x, hit.y, hit.z), distance: 1 } : null)),
    claimClicks: (fn: (e: PointerEvent) => boolean) => {
      claims.push(fn);
      return () => claims.splice(claims.indexOf(fn), 1);
    },
    requestRender: vi.fn(),
  } as unknown as EngineStage;
  return { stage, canvas, claims };
}

const input = () => ({ hover: vi.fn(), click: vi.fn(), drag: vi.fn(), endDrag: vi.fn() });

describe('walk in the 3D view', () => {
  it('samples the fit at ground height', () => {
    const fit = fitWalk(
      null,
      {
        pins: [
          { t: 0, surface: '@model', at: [0, 0], y: 2 },
          { t: 10, surface: '@model', at: [10, 0], y: 4 },
        ],
        yawOffsetDeg: 0,
      },
      { drawing: () => null },
      10,
    );
    const runs = sceneRuns(fit, 10, 1, 0);
    const pts = runs.flatMap((r) => r.pts);
    expect(pts[0]).toEqual([0, 2, 0]);
    expect(pts.at(-1)?.[1]).toBeCloseTo(4);
  });

  it('spreads preview heights from start to cursor', () => {
    expect(
      previewPoints(
        [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        [0, 2],
        0,
      ).map((p) => p[1]),
    ).toEqual([0, 1, 2]);
    expect(
      previewPoints(
        [
          [0, 0],
          [1, 0],
        ],
        null,
        0,
      ).map((p) => p[1]),
    ).toEqual([0, 0]);
  });

  it('hover reports the ground point, null when the ray finds nothing', () => {
    const { stage, canvas } = fakeStage({ x: 3, y: 1, z: 4 });
    const view = attachWalkScene(stage);
    const inp = input();
    view.setPlacing({ walk: null, preview: null, handles: [], clicks: true }, inp);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    expect(inp.hover).toHaveBeenCalledWith([3, 4], 1);
    (stage.raycast as ReturnType<typeof vi.fn>).mockReturnValue(null);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    expect(inp.hover).toHaveBeenLastCalledWith(null);
    view.dispose();
  });

  it('claims clicks only while a click is wanted', () => {
    const { stage, claims } = fakeStage({ x: 1, y: 0, z: 2 });
    const view = attachWalkScene(stage);
    const inp = input();
    view.setPlacing({ walk: null, preview: null, handles: [], clicks: true }, inp);
    expect(claims[0]?.(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }))).toBe(true);
    expect(inp.click).toHaveBeenCalledWith([1, 2], 0);
    view.setPlacing({ walk: null, preview: null, handles: [], clicks: false }, inp);
    expect(claims[0]?.(new PointerEvent('pointerup'))).toBe(false);
    view.dispose();
    expect(claims).toHaveLength(0);
  });

  it('a press on a handle drags it with the orbit controls off; a release anywhere ends it', () => {
    const { stage, canvas } = fakeStage({ x: 5, y: 0, z: 5 });
    const view = attachWalkScene(stage);
    const inp = input();
    // the handle at the origin projects to the canvas centre (the camera looks straight down)
    view.setPlacing(
      { walk: null, preview: null, handles: [{ id: 'end', at: [0, 0, 0] }], clicks: false },
      inp,
    );
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    expect(stage.controls.enabled).toBe(false);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 50 }));
    expect(inp.drag).toHaveBeenCalledWith('end', [5, 5], 0);
    expect(inp.hover).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(stage.controls.enabled).toBe(true);
    expect(inp.endDrag).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('a short handle grab is not also a click, and the next click counts again', () => {
    const { stage, canvas, claims } = fakeStage({ x: 5, y: 0, z: 5 });
    const view = attachWalkScene(stage);
    const inp = input();
    view.setPlacing(
      { walk: null, preview: null, handles: [{ id: 'start', at: [0, 0, 0] }], clicks: true },
      inp,
    );
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 101, clientY: 50, button: 0 }));
    // the stage reports the release as a click (it barely moved) before the window sees it
    expect(claims[0]?.(new PointerEvent('pointerup', { clientX: 102, clientY: 50 }))).toBe(true);
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(inp.click).not.toHaveBeenCalled();
    expect(inp.endDrag).toHaveBeenCalledTimes(1);
    expect(stage.controls.enabled).toBe(true);
    // a press away from the handles is an ordinary click
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
    expect(claims[0]?.(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }))).toBe(true);
    expect(inp.click).toHaveBeenCalledWith([5, 5], 0);
    view.dispose();
  });

  it.each([
    ['a cancelled pointer', () => window.dispatchEvent(new PointerEvent('pointercancel'))],
    ['the window losing focus', () => window.dispatchEvent(new Event('blur'))],
    ['Escape', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
  ])('%s ends a handle drag where it is', (_name, lose) => {
    const { stage, canvas } = fakeStage({ x: 5, y: 0, z: 5 });
    const view = attachWalkScene(stage);
    const inp = input();
    view.setPlacing(
      { walk: null, preview: null, handles: [{ id: 'end', at: [0, 0, 0] }], clicks: false },
      inp,
    );
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    expect(stage.controls.enabled).toBe(false);
    lose();
    expect(stage.controls.enabled).toBe(true);
    expect(inp.endDrag).toHaveBeenCalledTimes(1);
    // the drag is over: a later move hovers, a later release ends nothing
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 50 }));
    expect(inp.drag).not.toHaveBeenCalled();
    expect(inp.hover).toHaveBeenCalledWith([5, 5], 0);
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(inp.endDrag).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('Escape, blur and cancel do nothing without a drag, and nothing after dispose', () => {
    const { stage, canvas } = fakeStage({ x: 5, y: 0, z: 5 });
    const view = attachWalkScene(stage);
    const inp = input();
    view.setPlacing(
      { walk: null, preview: null, handles: [{ id: 'end', at: [0, 0, 0] }], clicks: false },
      inp,
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new Event('blur'));
    expect(inp.endDrag).not.toHaveBeenCalled();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    view.dispose();
    expect(inp.endDrag).toHaveBeenCalledTimes(1);
    stage.controls.enabled = false;
    window.dispatchEvent(new PointerEvent('pointercancel'));
    window.dispatchEvent(new Event('blur'));
    expect(stage.controls.enabled).toBe(false);
    expect(inp.endDrag).toHaveBeenCalledTimes(1);
  });

  it('a pointer leaving the view clears the hover, but not during a drag', () => {
    const { stage, canvas } = fakeStage({ x: 5, y: 0, z: 5 });
    const view = attachWalkScene(stage);
    const inp = input();
    view.setPlacing(
      { walk: null, preview: null, handles: [{ id: 'end', at: [0, 0, 0] }], clicks: false },
      inp,
    );
    canvas.dispatchEvent(new PointerEvent('pointerleave'));
    expect(inp.hover).toHaveBeenLastCalledWith(null);
    inp.hover.mockClear();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    canvas.dispatchEvent(new PointerEvent('pointerleave'));
    expect(inp.hover).not.toHaveBeenCalled();
    // ending the session mid drag gives the orbit controls back
    view.setPlacing(null, null);
    expect(stage.controls.enabled).toBe(true);
    expect(inp.endDrag).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('draws the preview above everything, and placed walks faintly', () => {
    const { stage } = fakeStage(null);
    const view = attachWalkScene(stage);
    view.setPlaced([
      {
        id: 'walk-b',
        colour: '#ff0000',
        runs: [
          {
            pts: [
              [0, 0, 0],
              [1, 0, 0],
            ],
            dashed: false,
          },
        ],
      },
    ]);
    view.setPlacing(
      {
        walk: null,
        preview: {
          pts: [
            [0, 0, 0],
            [5, 0, 0],
          ],
          ghost: true,
          tooClose: false,
        },
        handles: [],
        clicks: true,
      },
      input(),
    );
    const group = stage.scene.getObjectByName(WALK_SCENE_GROUP);
    const preview = stage.scene.getObjectByName(WALK_PREVIEW_NAME);
    expect(group?.renderOrder).toBeGreaterThanOrEqual(45);
    expect(preview?.visible).toBe(true);
    // overlays read clearly at any distance: no fog on the walk, its preview or its handles
    const fogged: unknown[] = [];
    group?.traverse((o) => {
      const m = (o as { material?: { fog?: boolean } | { fog?: boolean }[] }).material;
      for (const x of m ? (Array.isArray(m) ? m : [m]) : []) if (x.fog !== false) fogged.push(o);
    });
    expect(fogged).toEqual([]);
    view.setPlacing(null, null);
    expect(stage.scene.getObjectByName(WALK_PREVIEW_NAME)?.visible ?? false).toBe(false);
    view.dispose();
    expect(stage.scene.getObjectByName(WALK_SCENE_GROUP)).toBeUndefined();
  });
});
