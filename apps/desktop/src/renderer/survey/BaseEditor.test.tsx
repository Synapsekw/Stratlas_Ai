// @vitest-environment jsdom
// The custom base editor's Use ground here and Interpolate between, from the buttons and from a
// vertex row's right-click menu.
import { defaultSurveySettings, type BaseSpec, type SurveyMeasurement } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./measureStore', () => ({
  useMeasure: (sel: (s: unknown) => unknown) => sel({ settings: defaultSurveySettings() }),
}));

const { BaseEditor } = await import('./BaseEditor');

type Custom = Extract<BaseSpec, { kind: 'custom' }>;

const m = {
  id: 'm1',
  family: 'polygon',
  tool: 'volume',
  label: 'P1',
  points: [
    [0, 0, 10],
    [3, 0, 50],
    [6, 0, 50],
    [6, 6, 12],
    [0, 6, 10],
  ],
  items: [],
  results: [],
  scope: { kind: 'site' },
  createdAt: '2026-10-25T00:00:00Z',
} as unknown as SurveyMeasurement;

const base: Custom = {
  kind: 'custom',
  vertices: m.points.map((p) => ({ e: p[0], n: p[1], z: p[2] })),
};

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(onChange: (b: BaseSpec) => void) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<BaseEditor m={m} base={base} disabled={false} onChange={onChange} />);
  });
  return host;
}

const vertexButton = (k: number) => {
  const b = document.querySelector<HTMLButtonElement>(`[aria-label="Select vertex ${String(k)}"]`);
  if (!b) throw new Error(`no vertex ${String(k)}`);
  return b;
};

describe('the custom base editor', () => {
  it('interpolates a selected run between its neighbours from the button', () => {
    const onChange = vi.fn();
    mount(onChange);
    const interpolate = document.querySelector<HTMLButtonElement>(
      '[data-testid="survey-base-interpolate"]',
    );
    expect(interpolate?.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      vertexButton(2).click();
    });
    act(() => {
      vertexButton(3).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(interpolate?.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      interpolate?.click();
    });
    const next = onChange.mock.calls[0]?.[0] as Custom;
    // vertex 1 (z 10) to vertex 4 (z 12), 12 m along the edge: 3 m and 6 m in
    expect(next.vertices[1]?.z).toBeCloseTo(10.5, 9);
    expect(next.vertices[2]?.z).toBeCloseTo(11, 9);
  });

  it("offers Use ground here and Interpolate between on a row's right-click", () => {
    const onChange = vi.fn();
    mount(onChange);
    const row = vertexButton(2).closest('tr');
    act(() => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const menu = document.querySelector('[data-testid="survey-base-menu"]');
    const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
    expect(items.map((i) => i.textContent)).toEqual(['Use ground here', 'Interpolate between']);
    // the right-clicked vertex alone is one run with a vertex either side
    expect(items[1]?.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      (items[0] as HTMLButtonElement).click();
    });
    const next = onChange.mock.calls[0]?.[0] as Custom;
    expect(next.vertices[1]).toEqual({ e: 3, n: 0, offsetM: 0 });
    expect(next.vertices[0]).toEqual(base.vertices[0]);
  });
});
