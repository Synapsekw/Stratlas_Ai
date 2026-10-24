// @vitest-environment jsdom
import type { JobRecord, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

const stores = vi.hoisted(() => ({
  jobs: null as unknown as StoreApi<{
    jobs: JobRecord[];
    runtime: { found: boolean } | null;
  }>,
  shell: null as unknown as StoreApi<{
    pkg: unknown;
    settings: { autoPrepareSurfaces?: boolean };
  }>,
}));
vi.mock('../shell', async () => {
  const { createStore: make } = await import('zustand/vanilla');
  stores.jobs = make(() => ({ jobs: [] as JobRecord[], runtime: { found: true } }));
  stores.shell = make(() => ({ pkg: null, settings: {} }));
  return { jobs: stores.jobs, shell: stores.shell };
});

const { useSurfaceStates, usePrepareRunning, usePreparingSoon, preparedSurfaces } =
  await import('./surfaceStates');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'd1', label: 'One', date: '2026-01-01' },
    { id: 'd2', label: 'Two', date: '2026-02-01' },
  ],
  layers: [
    { kind: 'raster', id: 'dsm-d1', role: 'dsm', capture: 'd1', name: 'DSM 1' },
    { kind: 'raster', id: 'dsm-d2', role: 'dsm', capture: 'd2', name: 'DSM 2' },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 'j1',
  pipeline: 'survey.prepare',
  project: 'E:/p',
  params: {
    surfaces: [
      { id: 'dsm-d2', name: 'x', source: { kind: 'dsm', layer: 'dsm-d2' }, capture: 'd2' },
    ],
  },
  status: 'running',
  progress: 0.5,
  steps: [],
  artifacts: [],
  createdAt: '',
  updatedAt: '',
  ...over,
});

let host: HTMLDivElement;
let root: Root | undefined;
const seen: { states: unknown[]; running: boolean[]; soon: boolean[] } = {
  states: [],
  running: [],
  soon: [],
};

function Probe() {
  seen.states.push(useSurfaceStates());
  seen.running.push(usePrepareRunning());
  seen.soon.push(usePreparingSoon());
  return null;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
  preparedSurfaces.setState({ projectId: 'p', surfaces: [] });
  stores.jobs.setState({ jobs: [], runtime: { found: true } });
  stores.shell.setState({ pkg: null, settings: {} });
  seen.states = [];
  seen.running = [];
  seen.soon = [];
  root = createRoot(host);
  act(() => {
    root?.render(<Probe />);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

describe('useSurfaceStates', () => {
  it('an unrelated job update neither re-renders nor changes the states', () => {
    act(() => {
      stores.jobs.setState({ jobs: [job({ pipeline: 'odm.run' as JobRecord['pipeline'] })] });
    });
    const renders = seen.states.length;
    const before = seen.states.at(-1);
    // an ODM progress tick, and a prepare job of another project
    act(() => {
      stores.jobs.setState({
        jobs: [
          job({ pipeline: 'odm.run' as JobRecord['pipeline'], progress: 0.7 }),
          job({ id: 'j2', project: 'E:/other' }),
        ],
      });
    });
    expect(seen.states.length).toBe(renders);
    expect(seen.states.at(-1)).toBe(before);
  });

  it("a prepare job's progress tick on the project updates the date's percentage", () => {
    act(() => {
      stores.jobs.setState({ jobs: [job({ progress: 0.2 })] });
    });
    expect((seen.states.at(-1) as Map<string, unknown>).get('d2')).toEqual({
      kind: 'preparing',
      pct: 20,
    });
    act(() => {
      stores.jobs.setState({ jobs: [job({ progress: 0.4 })] });
    });
    expect((seen.states.at(-1) as Map<string, unknown>).get('d2')).toEqual({
      kind: 'preparing',
      pct: 40,
    });
    expect(seen.running.at(-1)).toBe(true);
  });
});

describe('usePreparingSoon', () => {
  it('is true while auto-prepare will start a job', () => {
    expect(seen.running.at(-1)).toBe(false);
    expect(seen.soon.at(-1)).toBe(true);
  });

  it('is false with the setting off, in a package or without the pipeline Python', () => {
    act(() => {
      stores.shell.setState({ settings: { autoPrepareSurfaces: false } });
    });
    expect(seen.soon.at(-1)).toBe(false);
    act(() => {
      stores.shell.setState({ settings: {}, pkg: { id: 'x' } });
    });
    expect(seen.soon.at(-1)).toBe(false);
    act(() => {
      stores.shell.setState({ pkg: null });
      stores.jobs.setState({ runtime: { found: false } });
    });
    expect(seen.soon.at(-1)).toBe(false);
  });

  it('is false after a prepare job on the project was cancelled or failed, true while one runs', () => {
    act(() => {
      stores.jobs.setState({ jobs: [job({ status: 'cancelled' })] });
    });
    expect(seen.soon.at(-1)).toBe(false);
    act(() => {
      stores.jobs.setState({ jobs: [job({ status: 'failed' })] });
    });
    expect(seen.soon.at(-1)).toBe(false);
    act(() => {
      stores.shell.setState({ settings: { autoPrepareSurfaces: false } });
      stores.jobs.setState({ jobs: [job({ status: 'failed' }), job({ id: 'j3' })] });
    });
    expect(seen.soon.at(-1)).toBe(true);
  });
});
