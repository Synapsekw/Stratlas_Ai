// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  shell: { getState: () => ({ stageMode: 'split' }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge' }) },
  useShell: () => undefined,
}));
vi.mock('../author', () => ({ authorName: () => '' }));

const { MeasureBar, saveRoadMeasure } = await import('./RoadTools');
const { roadStore, setRoad } = await import('./store');
const { measureStore } = await import('../survey/measureStore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINE: [number, number][] = [
  [8.0, 45.0],
  [8.002, 45.001],
];

function project(captures: number) {
  return {
    id: 'p1',
    manifest: {
      crs: { epsg: 32632 },
      origin: [440_000, 4_988_000, 0],
      layers: [],
      captures: Array.from({ length: captures }, (_, i) => ({ id: `c${String(i)}` })),
    },
  } as never;
}

let root: Root | null = null;
const save = () => document.querySelector('[data-testid="measure-save"]');

function open(opts: { captures: number; readOnly: boolean }) {
  workspace.setState({ project: project(opts.captures) });
  measureStore.setState({
    projectId: 'p1',
    status: 'ready',
    readOnly: opts.readOnly,
    autosave: false,
    file: { schema: 'aio.measurements/1', measurements: [] },
  });
  setRoad({ measure: { mode: 'line', vertices: LINE } });
  root = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => {
    root?.render(<MeasureBar />);
  });
}

beforeEach(() => {
  roadStore.setState(roadStore.getInitialState());
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
  workspace.setState({ project: null });
});

describe('the road measure bar', () => {
  it('save appears only in a writable project with surveys', () => {
    open({ captures: 1, readOnly: false });
    expect(document.querySelector('[data-testid="measure-card"]')).not.toBeNull();
    expect(save()).not.toBeNull();
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = '';

    open({ captures: 0, readOnly: false });
    expect(save()).toBeNull();
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = '';

    open({ captures: 1, readOnly: true });
    expect(save()).toBeNull();
  });

  it('saved road measurement is a site-scoped distance', () => {
    open({ captures: 1, readOnly: false });
    act(() => {
      save()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const saved = measureStore.getState().file.measurements;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      tool: 'distance',
      family: 'line',
      scope: { kind: 'site' },
    });
    expect(saved[0]?.points).toHaveLength(2);
    // placed in the project frame (UTM metres), not as degrees
    expect(saved[0]?.points[0]?.[0]).toBeGreaterThan(1000);
    // the measure goes on with a fresh line
    expect(roadStore.getState().measure.vertices).toEqual([]);
    expect(saveRoadMeasure()).toBeNull();
  });
});
