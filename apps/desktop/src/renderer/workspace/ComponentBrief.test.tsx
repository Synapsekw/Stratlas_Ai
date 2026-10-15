// @vitest-environment jsdom
import type { ComponentInfo, EngineStage, PickEvent } from '@aio/engine';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComponentBrief, firstSentence, StageComponentBrief } from './ComponentBrief';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const light: ComponentInfo = {
  id: 'light-l1-2',
  name: 'Warning light 2',
  category: 'Lighting',
  description: 'Red obstruction light with a lens facing north. Seen in four photos.',
};
const brief = () => host.querySelector<HTMLElement>('[data-testid="component-brief"]');

describe('ComponentBrief', () => {
  it('shows the name, category, first sentence and how to select', () => {
    act(() => root?.render(<ComponentBrief info={light} x={100} y={100} />));
    const text = brief()?.textContent ?? '';
    expect(text).toContain('Warning light 2');
    expect(text).toContain('Lighting');
    expect(text).toContain('Red obstruction light with a lens facing north.');
    expect(text).not.toContain('Seen in four photos');
    expect(text).toContain('Click to select');
  });

  it('stays inside the window near its edges', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    act(() => root?.render(<ComponentBrief info={light} x={w - 2} y={h - 2} />));
    const el = brief();
    if (!el) throw new Error('no brief');
    expect(parseFloat(el.style.left)).toBeLessThanOrEqual(w - 8);
    expect(parseFloat(el.style.top)).toBeLessThanOrEqual(h - 8);
    act(() => root?.render(<ComponentBrief info={light} x={-50} y={-50} />));
    expect(parseFloat(el.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(el.style.top)).toBeGreaterThanOrEqual(8);
  });

  it('keeps a whole short description and cuts a long sentence', () => {
    expect(firstSentence('Steel flue')).toBe('Steel flue');
    expect(firstSentence('One. Two.')).toBe('One.');
    expect(firstSentence('x'.repeat(300)).length).toBeLessThanOrEqual(141);
  });
});

describe('StageComponentBrief', () => {
  function fakeStage() {
    const cbs = new Set<(e: PickEvent) => void>();
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const stage = {
      renderer: { domElement: canvas },
      onPick: (cb: (e: PickEvent) => void) => {
        cbs.add(cb);
        return () => cbs.delete(cb);
      },
    } as unknown as EngineStage;
    const emit = (e: PickEvent) => {
      act(() => {
        for (const cb of cbs) cb(e);
      });
    };
    return { stage, canvas, emit, listeners: () => cbs.size };
  }

  it('follows the hovered component and goes when the hover ends', () => {
    const { stage, canvas, emit, listeners } = fakeStage();
    act(() => root?.render(<StageComponentBrief engine={stage} />));
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: 150 }));
    emit({ kind: 'hover', pick: { node: 'light-l1-2', layerId: 'm', component: light } });
    expect(brief()?.textContent).toContain('Warning light 2');
    expect(parseFloat(brief()?.style.left ?? '0')).toBeGreaterThan(200);
    // a selection change leaves the brief alone; a node without a record shows none
    emit({ kind: 'select', pick: null });
    expect(brief()).not.toBeNull();
    emit({ kind: 'hover', pick: { node: 'Pipe_3', layerId: 'm' } });
    expect(brief()).toBeNull();
    emit({ kind: 'hover', pick: { node: 'light-l1-2', layerId: 'm', component: light } });
    emit({ kind: 'hover', pick: null });
    expect(brief()).toBeNull();
    act(() => root?.render(<StageComponentBrief engine={null} />));
    expect(listeners()).toBe(0);
    canvas.remove();
  });
});
