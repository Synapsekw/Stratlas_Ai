// @vitest-environment jsdom
import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import type { EngineStage } from '../types';
import { MAX_LASSO_VERTICES, type PointSelection } from './pcselect';
import { PolygonClickTool } from './pcpolygon';

if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = MouseEvent as never;
}

function setup() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }) as DOMRect;
  const camera = new PerspectiveCamera(60, 2, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  const claims = new Set<(e: PointerEvent) => boolean>();
  const stage = {
    camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    requestRender: () => undefined,
    claimClicks: (h: (e: PointerEvent) => boolean) => {
      claims.add(h);
      return () => claims.delete(h);
    },
  } as unknown as EngineStage;
  const events: (PointSelection | 'cancel')[] = [];
  const counts: number[] = [];
  const tool = new PolygonClickTool(stage, {
    onClose: (s) => events.push(s),
    onCancel: () => events.push('cancel'),
    onChange: (n) => counts.push(n),
  });
  const click = (x: number, y: number) => {
    const e = new PointerEvent('pointerup', { clientX: x, clientY: y, button: 0 });
    for (const c of claims) if (c(e)) return;
  };
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  return { tool, canvas, events, counts, click, key, claims };
}

describe('PolygonClickTool', () => {
  it('closes three clicks on Enter with a 16-number viewProj', () => {
    const { tool, events, click, key } = setup();
    const off = tool.attach();
    click(50, 25);
    click(150, 25);
    click(100, 80);
    key('Enter');
    expect(events).toHaveLength(1);
    const sel = events[0] as PointSelection;
    expect(sel.shape).toBe('lasso');
    expect(sel.polygon).toHaveLength(3);
    expect(sel.polygon[0]).toEqual([-0.5, 0.5]);
    expect(sel.viewProj).toHaveLength(16);
    off();
  });

  it('closes on a double-click, and ignores the repeat click of the same spot', () => {
    const { tool, canvas, events, click } = setup();
    const off = tool.attach();
    click(50, 25);
    click(150, 25);
    click(100, 80);
    click(100, 80);
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect((events[0] as PointSelection).polygon).toHaveLength(3);
    off();
  });

  it('closes through close() and does nothing with two vertices', () => {
    const { tool, events, click, key } = setup();
    const off = tool.attach();
    click(50, 25);
    click(150, 25);
    key('Enter');
    tool.close();
    expect(events).toEqual([]);
    click(100, 80);
    tool.close();
    expect(events).toHaveLength(1);
    off();
  });

  it('drops the last vertex on Backspace and undo()', () => {
    const { tool, events, counts, click, key } = setup();
    const off = tool.attach();
    click(50, 25);
    click(150, 25);
    click(100, 80);
    key('Backspace');
    key('Enter');
    expect(events).toEqual([]);
    click(100, 80);
    tool.undo();
    expect(counts.at(-1)).toBe(2);
    off();
  });

  it('leaves Enter and Backspace to a focused text field, select or editable element', () => {
    const { events, counts, click, tool } = setup();
    const off = tool.attach();
    click(50, 25);
    click(150, 25);
    click(100, 80);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not compute isContentEditable from the attribute
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    const fields = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editable,
    ];
    for (const el of fields) {
      document.body.append(el);
      for (const k of ['Enter', 'Backspace']) {
        const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
        el.dispatchEvent(e);
      }
      el.remove();
    }
    expect(events).toEqual([]);
    expect(counts.at(-1)).toBe(3);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(events).toHaveLength(1);
    off();
  });

  it('cancels on Escape and clears the vertices', () => {
    const { tool, events, click, key } = setup();
    const off = tool.attach();
    click(50, 25);
    key('Escape');
    expect(events).toEqual(['cancel']);
    click(150, 25);
    click(100, 80);
    key('Enter');
    expect(events).toEqual(['cancel']);
    off();
  });

  it('keeps at most MAX_LASSO_VERTICES vertices', () => {
    const { tool, events, click } = setup();
    const off = tool.attach();
    for (let i = 0; i < MAX_LASSO_VERTICES + 10; i++)
      click(i % 200, 10 + ((i * 7) % 80) + (i % 2) * 5);
    tool.close();
    expect((events[0] as PointSelection).polygon.length).toBeLessThanOrEqual(MAX_LASSO_VERTICES);
    off();
  });

  it('draws an overlay with vertex dots and removes it, the claim and the key listener on detach', () => {
    const { tool, events, claims, click, key } = setup();
    const off = tool.attach();
    expect(claims.size).toBe(1);
    click(50, 25);
    click(150, 25);
    const svg = document.querySelector('[data-testid="pcpolygon-overlay"]');
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll('circle')).toHaveLength(2);
    off();
    expect(document.querySelector('[data-testid="pcpolygon-overlay"]')).toBeNull();
    expect(claims.size).toBe(0);
    key('Escape');
    expect(events).toEqual([]);
  });
});
