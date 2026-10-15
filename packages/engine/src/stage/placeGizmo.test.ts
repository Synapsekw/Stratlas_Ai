// @vitest-environment jsdom
import { Group, Matrix4, PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { EngineStage } from '../types';
import {
  basisShape,
  composePlacement,
  createPlaceGizmo,
  decomposePlacement,
  placeOnBasis,
  placementOnBasis,
  splitPlacement,
} from './placeGizmo';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const apply = (t: readonly number[], p: [number, number, number]) =>
  new Vector3(...p).applyMatrix4(new Matrix4().fromArray([...t]));

/** A deterministic sequence in [0, 1). */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('composePlacement', () => {
  it('round-trips through decomposePlacement for random placements, Y up and Z up', () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const up = i % 2 ? 'z' : 'y';
      const x = {
        anchor: [r() * 2000 - 1000, r() * 100 - 50, r() * 2000 - 1000] as [number, number, number],
        headingDeg: r() * 359.9 - 179.9,
        tiltXDeg: r() * 80 - 40,
        tiltZDeg: r() * 80 - 40,
        scale: 0.1 + r() * 10,
        up,
      } as const;
      const back = decomposePlacement(composePlacement(x), up);
      expect(close(back.anchor[0], x.anchor[0])).toBe(true);
      expect(close(back.anchor[1], x.anchor[1])).toBe(true);
      expect(close(back.anchor[2], x.anchor[2])).toBe(true);
      expect(close(back.headingDeg, x.headingDeg)).toBe(true);
      expect(close(back.tiltXDeg, x.tiltXDeg)).toBe(true);
      expect(close(back.tiltZDeg, x.tiltZDeg)).toBe(true);
      expect(close(back.scale, x.scale)).toBe(true);
    }
  });

  it('turns clockwise from north: heading 90 takes model +X to the south (+Z)', () => {
    const t = composePlacement({
      anchor: [0, 0, 0],
      headingDeg: 90,
      tiltXDeg: 0,
      tiltZDeg: 0,
      scale: 1,
      up: 'y',
    });
    const x = apply(t, [1, 0, 0]);
    expect([x.x, x.y, x.z].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
    // model north (-Z) goes east
    const n = apply(t, [0, 0, -1]);
    expect(close(n.x, 1)).toBe(true);
  });

  it('stands a Z-up model upright: model +Z goes up', () => {
    const t = composePlacement({
      anchor: [5, 0, 0],
      headingDeg: 0,
      tiltXDeg: 0,
      tiltZDeg: 0,
      scale: 2,
      up: 'z',
    });
    const top = apply(t, [0, 0, 1]);
    expect([top.x, top.y, top.z].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([5, 2, 0]);
  });
});

function fakeStage() {
  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 1000);
  camera.position.set(0, 50, 50);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const claims: ((e: PointerEvent) => boolean)[] = [];
  const stage = {
    scene,
    camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    requestRender: vi.fn(),
    invalidateShadows: vi.fn(),
    claimClicks: (h: (e: PointerEvent) => boolean) => {
      claims.push(h);
      return () => claims.splice(claims.indexOf(h), 1);
    },
  };
  const layer = new Group();
  layer.name = 'layer:m1';
  layer.matrixAutoUpdate = false;
  scene.add(layer);
  return { stage: stage as unknown as EngineStage, raw: stage, layer, claims, canvas };
}

describe('createPlaceGizmo', () => {
  const start = composePlacement({
    anchor: [10, 0, -4],
    headingDeg: 30,
    tiltXDeg: 0,
    tiltZDeg: 0,
    scale: 1,
    up: 'y',
  });

  it('reports a drag only through onChange, and moves the layer with it', () => {
    const { stage, layer, canvas } = fakeStage();
    const g = createPlaceGizmo(stage);
    const seen: number[][] = [];
    g.onChange((t) => seen.push([...t]));
    g.attach('m1', start);
    expect(seen).toEqual([]);
    expect(layer.matrix.toArray().map((v) => Math.round(v * 1e9) / 1e9)).toEqual(
      start.map((v) => Math.round(v * 1e9) / 1e9),
    );
    // what TransformControls does while dragging: move the target, then say so
    g.target.position.x += 5;
    g.controls.dispatchEvent({ type: 'objectChange' });
    expect(seen).toHaveLength(1);
    const moved = decomposePlacement(seen[0] ?? [], 'y');
    expect(close(moved.anchor[0], 15)).toBe(true);
    expect(close(moved.headingDeg, 30)).toBe(true);
    expect(close(layer.matrix.elements[12], 15)).toBe(true);
    g.detach();
    expect(stage.scene.children.some((c) => c.name === 'engine:place-gizmo')).toBe(false);
    canvas.remove();
  });

  it('keeps scale uniform and limits rotate to the vertical, tilt to the level axes', () => {
    const { stage, canvas } = fakeStage();
    const g = createPlaceGizmo(stage);
    const seen: number[][] = [];
    g.onChange((t) => seen.push([...t]));
    g.attach('m1', start);
    g.setMode('scale');
    g.target.scale.set(1, 3, 1);
    g.controls.dispatchEvent({ type: 'objectChange' });
    expect(g.target.scale.toArray()).toEqual([3, 3, 3]);
    expect(close(decomposePlacement(seen[0] ?? [], 'y').scale, 3)).toBe(true);
    g.setMode('rotate');
    expect([g.controls.showX, g.controls.showY, g.controls.showZ]).toEqual([false, true, false]);
    g.setMode('tilt');
    expect([g.controls.showX, g.controls.showY, g.controls.showZ]).toEqual([true, false, true]);
    g.setMode('move');
    expect(g.controls.mode).toBe('translate');
    g.detach();
    canvas.remove();
  });

  it('keeps a mirrored, stretched or Z-up import as it is: edits act on top of it', () => {
    // mirrored in x, twice as tall, Z up, then placed
    const imported = new Matrix4()
      .fromArray(start)
      .multiply(new Matrix4().makeScale(-1, 2, 1))
      .multiply(new Matrix4().fromArray([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]))
      .toArray();
    const { placement, basis } = splitPlacement(imported);
    expect(placement.scale).toBe(1);
    const back = placeOnBasis(placement, basis);
    back.forEach((v, i) => {
      expect(close(v, imported[i] ?? NaN, 1e-9)).toBe(true);
    });
    // a turn and a doubled scale keep the mirroring and the stretch
    const turned = placeOnBasis({ ...placement, headingDeg: 75, scale: 2 }, basis);
    expect(new Matrix4().fromArray(turned).determinant()).toBeLessThan(0);
    expect(basisShape(basis)).toEqual({ mirrored: true, stretched: true });
    expect(basisShape(splitPlacement(start).basis)).toEqual({ mirrored: false, stretched: false });
    const p = placementOnBasis(turned, basis);
    expect(close(p.headingDeg, 75)).toBe(true);
    expect(close(p.scale, 2)).toBe(true);
  });

  it('a tilt drag leaves the heading, a turn leaves the tilts', () => {
    const { stage, canvas } = fakeStage();
    const g = createPlaceGizmo(stage);
    const seen: number[][] = [];
    g.onChange((t) => seen.push([...t]));
    g.attach('m1', start);
    g.setMode('tilt');
    g.controls.dispatchEvent({ type: 'dragging-changed', value: true });
    // a world-space turn about east and north that would also swing the heading
    g.target.rotateOnWorldAxis(new Vector3(1, 0, 0), 0.3);
    g.target.rotateOnWorldAxis(new Vector3(0, 1, 0), 0.4);
    g.controls.dispatchEvent({ type: 'objectChange' });
    const tilted = decomposePlacement(seen.at(-1) ?? [], 'y');
    expect(close(tilted.headingDeg, 30)).toBe(true);
    expect(Math.abs(tilted.tiltXDeg) + Math.abs(tilted.tiltZDeg)).toBeGreaterThan(1);
    g.controls.dispatchEvent({ type: 'dragging-changed', value: false });
    g.setMode('rotate');
    g.controls.dispatchEvent({ type: 'dragging-changed', value: true });
    g.target.rotateOnWorldAxis(new Vector3(0, 0, 1), 0.2);
    g.target.rotateOnWorldAxis(new Vector3(0, 1, 0), 0.5);
    g.controls.dispatchEvent({ type: 'objectChange' });
    const turned = decomposePlacement(seen.at(-1) ?? [], 'y');
    expect(close(turned.tiltXDeg, tilted.tiltXDeg)).toBe(true);
    expect(close(turned.tiltZDeg, tilted.tiltZDeg)).toBe(true);
    expect(close(turned.headingDeg, 30)).toBe(false);
    // no pointer on a handle here (a real drag sets the controls' axis): a click is not the handle's
    expect(g.busy()).toBe(false);
    g.controls.dispatchEvent({ type: 'dragging-changed', value: false });
    g.detach();
    canvas.remove();
  });

  it('stops the orbit while dragging and claims clicks on its handles', () => {
    const { stage, raw, claims, canvas } = fakeStage();
    const g = createPlaceGizmo(stage);
    g.attach('m1', start);
    g.controls.dispatchEvent({ type: 'dragging-changed', value: true });
    expect(raw.controls.enabled).toBe(false);
    g.controls.dispatchEvent({ type: 'dragging-changed', value: false });
    expect(raw.controls.enabled).toBe(true);
    expect(claims).toHaveLength(1);
    g.detach();
    expect(claims).toHaveLength(0);
    canvas.remove();
  });
});
