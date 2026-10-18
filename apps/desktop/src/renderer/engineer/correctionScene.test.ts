// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { monopoleModel } from '@aio/modelling';
import { Box3, Group, Matrix4, Mesh, Object3D, PerspectiveCamera, Scene, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armCorrectionPin,
  attachCorrectionComparison,
  correctionModelPoint,
  showCorrectionPin,
} from './correctionScene';

function fixture() {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.style.cursor = 'grab';
  canvas.getBoundingClientRect = () => ({
    x: 20,
    y: 30,
    left: 20,
    top: 30,
    right: 220,
    bottom: 130,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  });
  const claims = new Set<(e: PointerEvent) => boolean>();
  const camera = new PerspectiveCamera();
  camera.position.set(5, 6, 7);
  const target = new Vector3(0, 20, 0);
  const root = new Group();
  root.userData.layerId = 'model';
  const object = new Object3D();
  object.userData.component = 'radio-1';
  root.add(object);
  const hit = { point: new Vector3(12, 34, 56), distance: 9, object };
  const raycast = vi.fn((): typeof hit | null => hit);
  const frameCallbacks = new Set<(dt: number) => void>();
  const offTarget = vi.fn();
  const addRaycastTarget = vi.fn(() => offTarget);
  const restoreView = vi.fn();
  const stage = {
    scene: new Scene(),
    camera,
    renderer: { domElement: canvas },
    controls: { target },
    clippingPlanes: [],
    raycast,
    requestRender: vi.fn(),
    saveView: () => ({ position: camera.position.toArray(), target: target.toArray() }),
    restoreView,
    onFrame: (fn: (dt: number) => void) => {
      frameCallbacks.add(fn);
      return () => frameCallbacks.delete(fn);
    },
    claimClicks: (fn: (e: PointerEvent) => boolean) => {
      claims.add(fn);
      return () => claims.delete(fn);
    },
    addRaycastTarget,
  } as unknown as EngineStage;
  const click = (x = 120, y = 80) =>
    [...claims][0]?.(new MouseEvent('pointerup', { clientX: x, clientY: y }) as PointerEvent);
  return {
    stage,
    canvas,
    claims,
    click,
    root,
    object,
    hit,
    raycast,
    frameCallbacks,
    offTarget,
    addRaycastTarget,
    restoreView,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('correction location pin', () => {
  it('uses the inverse model transform, including rotation and translation', () => {
    const matrix = new Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 30, -4);
    const local = new Vector3(2, 4, 6);
    const world = local.clone().applyMatrix4(matrix).toArray();
    const result = correctionModelPoint(world, matrix);
    expect(result?.[0]).toBeCloseTo(2);
    expect(result?.[1]).toBeCloseTo(4);
    expect(result?.[2]).toBeCloseTo(6);
    expect(correctionModelPoint(world, matrix.elements)).toEqual(result);
    expect(correctionModelPoint(world, new Matrix4().makeScale(1, 0, 1))).toBeNull();
    expect(correctionModelPoint([NaN, 0, 0], matrix)).toBeNull();
    expect(correctionModelPoint(world, [1, 2, 3])).toBeNull();
  });

  it('records an actual allowed surface hit, camera and part, then releases its click', () => {
    const f = fixture();
    const onPin = vi.fn();
    const view = armCorrectionPin(f.stage, {
      modelToProject: new Matrix4().makeTranslation(10, 30, 50),
      allowedLayerIds: ['model'],
      onPin,
    });
    expect(f.canvas.style.cursor).toBe('crosshair');
    expect(f.click()).toBe(true);
    expect(f.raycast).toHaveBeenCalledWith(0, 0);
    expect(onPin).toHaveBeenCalledWith({
      point: [12, 34, 56],
      modelPoint: [2, 4, 6],
      layerId: 'model',
      componentId: 'radio-1',
      camera: { position: [5, 6, 7], target: [0, 20, 0] },
    });
    expect(f.claims.size).toBe(0);
    expect(f.canvas.style.cursor).toBe('grab');
    view.dispose();
  });

  it('rejects sky, synthetic ground, unrelated layers and non-finite hits without inventing a point', () => {
    const f = fixture();
    const onPin = vi.fn();
    const onMiss = vi.fn();
    const view = armCorrectionPin(f.stage, {
      modelToProject: new Matrix4(),
      allowedLayerIds: ['model'],
      onPin,
      onMiss,
    });
    f.raycast.mockReturnValueOnce(null);
    f.click();
    f.root.userData.aioGround = true;
    f.click();
    delete f.root.userData.aioGround;
    f.root.userData.layerId = 'other';
    f.click();
    f.root.userData.layerId = 'model';
    f.hit.point.set(NaN, 2, 3);
    f.click();
    expect(onPin).not.toHaveBeenCalled();
    expect(onMiss).toHaveBeenCalledTimes(4);
    expect(f.claims.size).toBe(1);
    view.dispose();
  });

  it('Escape cancels once, restores the cursor and unhooks both the keyboard and click handler', () => {
    const f = fixture();
    const onCancel = vi.fn();
    const view = armCorrectionPin(f.stage, {
      modelToProject: new Matrix4(),
      allowedLayerIds: ['model'],
      onPin: vi.fn(),
      onCancel,
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(f.claims.size).toBe(0);
    expect(f.canvas.style.cursor).toBe('grab');
    view.dispose();
  });

  it('dispose cancels input silently and cannot capture a later click or Escape', () => {
    const f = fixture();
    const onCancel = vi.fn();
    const onPin = vi.fn();
    const view = armCorrectionPin(f.stage, {
      modelToProject: new Matrix4(),
      allowedLayerIds: ['model'],
      onPin,
      onCancel,
    });
    view.dispose();
    f.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onPin).not.toHaveBeenCalled();
  });

  it('accepts a source-cloud hit without requiring it to have a component', () => {
    const f = fixture();
    f.root.userData.layerId = 'source-cloud';
    delete f.object.userData.component;
    const onPin = vi.fn();
    armCorrectionPin(f.stage, {
      modelToProject: new Matrix4(),
      allowedLayerIds: ['source-cloud'],
      onPin,
    });
    f.click();
    expect(onPin).toHaveBeenCalledWith(
      expect.objectContaining({ point: [12, 34, 56], layerId: 'source-cloud' }),
    );
    expect(onPin.mock.calls[0]?.[0]).not.toHaveProperty('componentId');
  });

  it('rejects a singular frame before taking control of input', () => {
    const f = fixture();
    expect(() =>
      armCorrectionPin(f.stage, {
        modelToProject: new Matrix4().makeScale(0, 1, 1),
        allowedLayerIds: ['model'],
        onPin: vi.fn(),
      }),
    ).toThrow('transform');
    expect(f.claims.size).toBe(0);
    expect(f.canvas.style.cursor).toBe('grab');
  });
});

describe('correction scene resources', () => {
  it('draws a pin at the exact project position and frees its resources on disposal', () => {
    const f = fixture();
    const marker = showCorrectionPin(f.stage, [12, 34, 56]);
    expect(marker.group.position.toArray()).toEqual([12, 34, 56]);
    expect(f.stage.scene.children).toContain(marker.group);
    const disposals: ReturnType<typeof vi.fn>[] = [];
    marker.group.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const dispose = vi.fn();
      (node as Mesh).geometry.addEventListener('dispose', dispose);
      disposals.push(dispose);
    });
    marker.dispose();
    marker.dispose();
    expect(f.stage.scene.children).not.toContain(marker.group);
    expect(f.frameCallbacks.size).toBe(0);
    expect(disposals.length).toBeGreaterThan(0);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('uses production geometry with explicit georeference, preserves IDs, and toggles without moving camera', () => {
    const f = fixture();
    const before = monopoleModel();
    const after = structuredClone(before);
    const base = after.assemblies.find((assembly) => assembly.kind === 'base');
    if (!base) throw new Error('Fixture needs a base');
    base.params.height += 1;
    const id = base.id;
    const transform = new Matrix4().makeRotationY(0.4).setPosition(120, -32.542, -84);
    const cameraBefore = f.stage.saveView();
    const view = attachCorrectionComparison(f.stage, {
      before,
      after,
      modelToProject: transform,
      changedIds: [id],
    });
    expect(view.group.matrix.elements).toEqual(transform.elements);
    expect(view.beforeGroup.children.some((n) => n.userData.component === id)).toBe(true);
    const changed = view.afterGroup.children.find((n) => n.userData.component === id);
    expect(changed?.userData.correctionChanged).toBe(true);
    expect(f.addRaycastTarget).not.toHaveBeenCalled();
    const original = view.beforeGroup.children.find((n) => n.userData.component === id);
    if (!changed || !original) throw new Error('Missing preview base');
    const delta =
      new Box3().setFromObject(changed).max.y - new Box3().setFromObject(original).max.y;
    expect(delta).toBeCloseTo(1);
    view.show('before');
    expect(view.beforeGroup.visible).toBe(true);
    expect(view.afterGroup.visible).toBe(false);
    view.show('after');
    expect(view.beforeGroup.visible).toBe(false);
    expect(view.afterGroup.visible).toBe(true);
    expect(f.stage.saveView()).toEqual(cameraBefore);
    expect(f.restoreView).not.toHaveBeenCalled();
    view.dispose();
    expect(f.stage.scene.children).not.toContain(view.group);
  });

  it('unregisters optional picking and disposes all comparison geometry and materials exactly once', () => {
    const f = fixture();
    const model = monopoleModel();
    const view = attachCorrectionComparison(f.stage, {
      before: model,
      after: model,
      modelToProject: new Matrix4(),
      changedIds: [],
      layerId: 'candidate',
      pickable: true,
    });
    const objects = new Set<{ addEventListener: (name: 'dispose', cb: () => void) => void }>();
    view.group.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const mesh = node as Mesh;
      objects.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        objects.add(material);
    });
    const disposals = [...objects].map((object) => {
      const fn = vi.fn();
      object.addEventListener('dispose', fn);
      return fn;
    });
    expect(f.addRaycastTarget).toHaveBeenCalledWith(view.group, 'candidate');
    view.dispose();
    view.dispose();
    expect(f.offTarget).toHaveBeenCalledTimes(1);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
  });
});
