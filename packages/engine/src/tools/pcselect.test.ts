// @vitest-environment jsdom
import { Matrix4, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import type { EngineStage } from '../types';
import { MAX_LASSO_VERTICES, PointSelectTool, rectPolygon, simplifyPath } from './pcselect';

// jsdom has no PointerEvent in some versions
if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = MouseEvent as never;
}

/** Distance from a point to the nearest segment of an open polyline. */
function distToPolyline(p: [number, number], line: readonly [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] ?? [0, 0];
    const b = line[i + 1] ?? [0, 0];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    const t =
      len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

describe('selection outlines', () => {
  it('makes a box from two corners in any order', () => {
    expect(rectPolygon([0.5, 0.5], [-0.5, -0.25])).toEqual([
      [-0.5, -0.25],
      [0.5, -0.25],
      [0.5, 0.5],
      [-0.5, 0.5],
    ]);
  });

  it('simplifies a 5000-sample lasso to at most 256 vertices near the drawn path', () => {
    // a wobbly circle drawn for several seconds, crossing itself at the end
    const pts: [number, number][] = Array.from({ length: 5000 }, (_, i) => {
      const a = (i / 4800) * Math.PI * 2;
      const r = 0.5 + 0.01 * Math.sin(i * 0.7);
      return [r * Math.cos(a), r * Math.sin(a)];
    });
    const out = simplifyPath(pts);
    expect(MAX_LASSO_VERTICES).toBe(256);
    expect(out.length).toBeLessThanOrEqual(MAX_LASSO_VERTICES);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const [x, y] of out) expect(Math.abs(Math.hypot(x, y) - 0.5)).toBeLessThan(0.02);
    // Every drawn sample stays close to the simplified outline. The hand tremor here spans 0.02
    // NDC peak to peak about every 9 samples, more than 256 vertices can follow, so the bound is
    // that span: an outline cutting corners across the tremor would exceed it.
    let worst = 0;
    for (const p of pts) worst = Math.max(worst, distToPolyline(p, out));
    expect(worst).toBeLessThan(0.02);
  });

  it('keeps a smooth self-crossing 5000-sample lasso within 0.01 NDC of every sample', () => {
    // a figure eight, drawn once and a little past its start
    const pts: [number, number][] = Array.from({ length: 5000 }, (_, i) => {
      const a = (i / 4800) * Math.PI * 2;
      return [0.8 * Math.sin(a), 0.4 * Math.sin(2 * a)];
    });
    const out = simplifyPath(pts);
    expect(out.length).toBeLessThanOrEqual(MAX_LASSO_VERTICES);
    expect(out.length).toBeGreaterThanOrEqual(3);
    let worst = 0;
    for (const p of pts) worst = Math.max(worst, distToPolyline(p, out));
    expect(worst).toBeLessThan(0.01);
  });

  it('respects a smaller vertex budget', () => {
    const pts: [number, number][] = Array.from({ length: 5000 }, (_, i) => {
      const a = (i / 5000) * Math.PI * 2;
      return [0.5 * Math.cos(a) + 0.01 * Math.sin(i), 0.5 * Math.sin(a)];
    });
    for (const max of [8, 32, 100]) {
      const out = simplifyPath(pts, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps a short path as it is, without repeated points', () => {
    expect(
      simplifyPath([
        [0, 0],
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });
});

function fakeStage() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }) as DOMRect;
  const camera = new PerspectiveCamera(60, 2, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  const stage = {
    camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    requestRender: () => undefined,
  } as unknown as EngineStage;
  return { stage, canvas };
}
const ev = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });

describe('PointSelectTool', () => {
  it('reports a box in NDC with the view at the time of drawing', () => {
    const { stage, canvas } = fakeStage();
    const got: unknown[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'box',
      onSelect: (s) => got.push(s),
      onCancel: () => got.push('cancel'),
    });
    const off = tool.attach();
    canvas.dispatchEvent(ev('pointerdown', 50, 25));
    expect(stage.controls.enabled).toBe(false);
    window.dispatchEvent(ev('pointermove', 150, 75));
    window.dispatchEvent(ev('pointerup', 150, 75));
    expect(stage.controls.enabled).toBe(true);
    expect(got).toHaveLength(1);
    const sel = got[0] as { shape: string; polygon: number[][]; viewProj: number[] };
    expect(sel.shape).toBe('box');
    expect(sel.polygon).toEqual([
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ]);
    const vp = new Matrix4().multiplyMatrices(
      stage.camera.projectionMatrix,
      stage.camera.matrixWorldInverse,
    );
    expect(sel.viewProj).toEqual(vp.toArray());
    off();
  });

  it('cancels on Escape and ignores a click without a drag', () => {
    const { stage, canvas } = fakeStage();
    const got: unknown[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'lasso',
      onSelect: (s) => got.push(s),
      onCancel: () => got.push('cancel'),
    });
    const off = tool.attach();
    canvas.dispatchEvent(ev('pointerdown', 10, 10));
    window.dispatchEvent(ev('pointermove', 60, 10));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(ev('pointerup', 60, 60));
    expect(got).toEqual(['cancel']);
    expect(stage.controls.enabled).toBe(true);
    canvas.dispatchEvent(ev('pointerdown', 10, 10));
    window.dispatchEvent(ev('pointerup', 11, 10));
    expect(got).toEqual(['cancel']);
    off();
  });

  it('draws a lasso and takes the press away from the stage', () => {
    const { stage, canvas } = fakeStage();
    const got: { shape: string; polygon: number[][] }[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'lasso',
      onSelect: (s) => got.push(s),
      onCancel: () => undefined,
    });
    const off = tool.attach();
    let stageSaw = 0;
    canvas.addEventListener('pointerdown', () => stageSaw++);
    canvas.dispatchEvent(ev('pointerdown', 20, 20));
    window.dispatchEvent(ev('pointermove', 120, 20));
    window.dispatchEvent(ev('pointermove', 120, 80));
    window.dispatchEvent(ev('pointerup', 20, 80));
    expect(stageSaw).toBe(0);
    expect(got).toHaveLength(1);
    expect(got[0]?.shape).toBe('lasso');
    expect(got[0]?.polygon).toHaveLength(4);
    off();
  });

  it('selects a closed lasso that ends where it started', () => {
    const { stage, canvas } = fakeStage();
    const got: { polygon: number[][] }[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'lasso',
      onSelect: (s) => got.push(s),
      onCancel: () => undefined,
    });
    const off = tool.attach();
    canvas.dispatchEvent(ev('pointerdown', 20, 20));
    window.dispatchEvent(ev('pointermove', 120, 20));
    window.dispatchEvent(ev('pointermove', 120, 80));
    window.dispatchEvent(ev('pointermove', 20, 80));
    window.dispatchEvent(ev('pointerup', 21, 21));
    expect(got).toHaveLength(1);
    expect(got[0]?.polygon.length).toBeGreaterThanOrEqual(3);
    off();
  });

  it('swallows another button pressed while drawing', () => {
    const { stage, canvas } = fakeStage();
    const got: unknown[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'box',
      onSelect: (s) => got.push(s),
      onCancel: () => got.push('cancel'),
    });
    const off = tool.attach();
    let stageSaw = 0;
    canvas.addEventListener('pointerdown', () => stageSaw++);
    canvas.dispatchEvent(ev('pointerdown', 10, 10));
    window.dispatchEvent(ev('pointermove', 100, 60));
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 50, clientY: 50, button: 2, bubbles: true }),
    );
    window.dispatchEvent(ev('pointerup', 100, 60));
    expect(stageSaw).toBe(0);
    expect(got).toHaveLength(1);
    const corner = (got[0] as { polygon: number[][] }).polygon[0] ?? [];
    expect(corner[0]).toBeCloseTo(-0.9);
    expect(corner[1]).toBeCloseTo(-0.2);
    off();
  });

  it('lets Escape reach other handlers when nothing is being drawn', () => {
    const { stage, canvas } = fakeStage();
    const got: unknown[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'lasso',
      onSelect: (s) => got.push(s),
      onCancel: () => got.push('cancel'),
    });
    const off = tool.attach();
    let others = 0;
    const other = () => others++;
    window.addEventListener('keydown', other, { capture: true });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(others).toBe(1);
    expect(got).toEqual(['cancel']);
    canvas.dispatchEvent(ev('pointerdown', 10, 10));
    window.dispatchEvent(ev('pointermove', 60, 10));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(others).toBe(1);
    expect(got).toEqual(['cancel', 'cancel']);
    window.removeEventListener('keydown', other, { capture: true });
    off();
  });

  it('aborts a drawing on pointercancel without selecting or cancelling the tool', () => {
    const { stage, canvas } = fakeStage();
    const got: unknown[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'box',
      onSelect: (s) => got.push(s),
      onCancel: () => got.push('cancel'),
    });
    const off = tool.attach();
    canvas.dispatchEvent(ev('pointerdown', 10, 10));
    window.dispatchEvent(ev('pointermove', 100, 60));
    window.dispatchEvent(ev('pointercancel', 100, 60));
    expect(stage.controls.enabled).toBe(true);
    window.dispatchEvent(ev('pointerup', 100, 60));
    expect(got).toEqual([]);
    off();
  });

  it('removes its overlay and listeners when detached', () => {
    const { stage, canvas } = fakeStage();
    const got: unknown[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'box',
      onSelect: (s) => got.push(s),
      onCancel: () => got.push('cancel'),
    });
    const off = tool.attach();
    expect(document.querySelector('[data-testid="pcselect-overlay"]')).not.toBeNull();
    canvas.dispatchEvent(ev('pointerdown', 10, 10));
    off();
    expect(stage.controls.enabled).toBe(true);
    expect(document.querySelector('[data-testid="pcselect-overlay"]')).toBeNull();
    window.dispatchEvent(ev('pointerup', 100, 60));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(got).toEqual([]);
  });
});
