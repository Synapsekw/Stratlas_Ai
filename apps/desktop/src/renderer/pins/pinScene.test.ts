// @vitest-environment jsdom
import type { SceneHandle } from '@aio/engine';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { DrawnPin } from './pinModel';
import {
  attachPinScene,
  PIN_ARROW_NAME,
  PIN_RING_NAME,
  PIN_SCENE_GROUP,
  PIN_STEM_NAME,
} from './pinScene';

// jsdom has no PointerEvent: a MouseEvent carries every field these tests use
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {}
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventShim;
}

function fakeStage(hit: { x: number; y: number; z: number }) {
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
  const camera = new PerspectiveCamera(60, 2, 0.1, 1000);
  camera.position.set(0, 50, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const controls = { enabled: true };
  const stage = {
    scene: new Scene(),
    camera,
    renderer: { domElement: canvas },
    controls,
    setViewPreset: vi.fn(),
    setTool: vi.fn(),
    raycast: vi.fn(() => ({ point: new Vector3(hit.x, hit.y, hit.z), distance: 1 })),
    claimClicks: vi.fn(() => () => undefined),
    requestRender: vi.fn(),
  };
  return { stage: stage as unknown as SceneHandle, canvas, controls };
}

const pin = (id: string, x: number, headingDeg?: number): DrawnPin => ({
  key: { kind: 'photo', layerId: 'l', itemId: id },
  name: id,
  ground: [x, 0, 0],
  eye: [x, 1.6, 0],
  headingDeg,
  linedUp: headingDeg !== undefined,
});

const named = (stage: SceneHandle, name: string) =>
  stage.scene.getObjectByName(PIN_SCENE_GROUP)?.children.filter((c) => c.name === name) ?? [];

describe('pins in the 3D view', () => {
  it('draws a ring and a stem per pin and an arrow only for a pin with a heading', () => {
    const { stage } = fakeStage({ x: 0, y: 0, z: 0 });
    const view = attachPinScene(stage, { onArrowDrop: vi.fn() });
    view.update([pin('a', 0, 40), pin('b', 5)], null);
    expect(named(stage, PIN_RING_NAME)).toHaveLength(2);
    expect(named(stage, PIN_STEM_NAME)).toHaveLength(2);
    expect(named(stage, PIN_ARROW_NAME)).toHaveLength(1);
  });

  it('points the arrow along the heading (90 is east, +x)', () => {
    const { stage } = fakeStage({ x: 0, y: 0, z: 0 });
    const view = attachPinScene(stage, { onArrowDrop: vi.fn() });
    view.update([pin('a', 0, 90)], null);
    const [arrow] = named(stage, PIN_ARROW_NAME);
    const dir = (arrow?.localToWorld(new Vector3(0, 0, -1)) ?? new Vector3()).sub(
      arrow?.localToWorld(new Vector3(0, 0, 0)) ?? new Vector3(),
    );
    expect(dir.x).toBeCloseTo(1);
    expect(dir.z).toBeCloseTo(0);
  });

  it('empties on no pins and leaves the scene on dispose', () => {
    const { stage } = fakeStage({ x: 0, y: 0, z: 0 });
    const view = attachPinScene(stage, { onArrowDrop: vi.fn() });
    view.update([pin('a', 0, 40)], 'photo:l:a');
    view.update([], null);
    expect(stage.scene.getObjectByName(PIN_SCENE_GROUP)?.children).toHaveLength(0);
    view.dispose();
    expect(stage.scene.getObjectByName(PIN_SCENE_GROUP)).toBeUndefined();
  });

  it('drops the dragged heading and turns orbit back on at the window pointer up', () => {
    const { stage, canvas, controls } = fakeStage({ x: 5, y: 0, z: 0 });
    const onArrowDrop = vi.fn();
    const view = attachPinScene(stage, { onArrowDrop });
    view.update([pin('a', 0, 0)], null);
    // the arrow sits under the view centre (the camera looks straight down at the pin)
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0, bubbles: true }),
    );
    expect(controls.enabled).toBe(false);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 160, clientY: 50 }));
    expect(onArrowDrop).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 160, clientY: 50 }));
    expect(onArrowDrop).toHaveBeenCalledWith({ kind: 'photo', layerId: 'l', itemId: 'a' }, 90);
    expect(controls.enabled).toBe(true);
    view.dispose();
  });

  it('ignores a press away from any arrow', () => {
    const { stage, canvas, controls } = fakeStage({ x: 5, y: 0, z: 0 });
    const view = attachPinScene(stage, { onArrowDrop: vi.fn() });
    view.update([pin('a', 0, 0)], null);
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, bubbles: true }),
    );
    expect(controls.enabled).toBe(true);
    view.dispose();
  });
});
