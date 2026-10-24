// @vitest-environment jsdom
import { type HeightTiles, type JobRecord, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobs } from '../shell';
import type { JobEntry } from '../jobs';
import { PreparingCard } from './PreparingCard';
import { preparedSurfaces } from './surfaceStates';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32633 },
  origin: [500000, 4500000, 0],
  captures: [
    { id: 'c1', label: 'Survey', date: '2020-12-31' },
    { id: 'c2', label: 'Survey', date: '2021-01-10' },
    { id: 'c3', label: 'Survey', date: '2021-02-10' },
  ],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

const surface = (capture: string) => ({
  id: `s-${capture}`,
  name: capture,
  source: { kind: 'cloud', layer: `pc-${capture}` },
  capture,
});

const prepJob = (
  status: JobRecord['status'],
  progress: number,
  captures: string[],
  quiet = true,
): JobEntry => ({
  id: 'jp',
  pipeline: 'survey.prepare',
  project: 'C:/p',
  params: { surfaces: captures.map(surface) },
  status,
  progress,
  steps: [],
  artifacts: [],
  createdAt: '',
  updatedAt: '',
  ...(quiet ? { quiet: true as const } : {}),
});

const ready = (...captures: string[]) => {
  preparedSurfaces.setState({
    projectId: 'p',
    surfaces: captures.map(surface) as unknown as HeightTiles[],
  });
};

let host: HTMLDivElement;
let root: Root | undefined;
const card = () => document.querySelector<HTMLElement>('[data-testid="preparing-card"]');
const rows = () =>
  [...(card()?.querySelectorAll<HTMLElement>('[data-testid="preparing-row"]') ?? [])].map((r) => ({
    id: r.dataset.capture,
    status: r.querySelector('.prep-status')?.textContent ?? '',
  }));

beforeEach(() => {
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  host = document.createElement('div');
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(<PreparingCard />);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  jobs.setState({ jobs: [] });
  preparedSurfaces.setState({ projectId: null, surfaces: [] });
  workspace.getState().closeProject();
  host.remove();
  vi.useRealTimers();
});

describe('PreparingCard', () => {
  it('shows nothing while no date is preparing', () => {
    expect(card()).toBeNull();
    act(() => {
      ready('c1');
    });
    expect(card()).toBeNull();
  });

  it('the card lists each date as ready or its percentage, with "Preparing 1 of 2" and the started-on-open line', () => {
    // a first job prepares 10 Jan, then a second takes 31 Dec
    act(() => {
      jobs.setState({ jobs: [prepJob('running', 0.3, ['c2'])] });
    });
    act(() => {
      jobs.setState({ jobs: [prepJob('running', 0.62, ['c1'])] });
      ready('c2');
    });
    expect(card()).not.toBeNull();
    expect(card()?.textContent).toContain('Preparing survey surfaces');
    expect(card()?.textContent).toContain('Preparing 1 of 2');
    expect(card()?.textContent).toContain(
      'Started on its own when the project opened. You can keep working.',
    );
    // oldest first; the date no job touched is not listed
    expect(rows()).toEqual([
      { id: 'c1', status: '62 %' },
      { id: 'c2', status: 'ready' },
    ]);
    expect(card()?.textContent).toContain('31 Dec 2020');
  });

  it('a job the person started is not said to have started on open', () => {
    act(() => {
      jobs.setState({ jobs: [prepJob('running', 0.1, ['c1'], false)] });
    });
    expect(card()).not.toBeNull();
    expect(card()?.textContent).not.toContain('Started on its own');
  });

  it('the card hides 2 s after the job ends', () => {
    vi.useFakeTimers();
    act(() => {
      jobs.setState({ jobs: [prepJob('running', 0.5, ['c1', 'c2'])] });
    });
    expect(rows()).toEqual([
      { id: 'c1', status: '50 %' },
      { id: 'c2', status: '50 %' },
    ]);
    act(() => {
      jobs.setState({ jobs: [prepJob('done', 1, ['c1', 'c2'])] });
      ready('c1', 'c2');
    });
    // still there, every date ready
    expect(card()?.textContent).toContain('Preparing 2 of 2');
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(card()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(card()).toBeNull();
  });

  it('a new run after the card closed lists only its own dates', () => {
    vi.useFakeTimers();
    act(() => {
      jobs.setState({ jobs: [prepJob('running', 0.5, ['c1'])] });
    });
    act(() => {
      jobs.setState({ jobs: [prepJob('done', 1, ['c1'])] });
      ready('c1');
    });
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(card()).toBeNull();
    act(() => {
      jobs.setState({ jobs: [prepJob('running', 0.2, ['c3'])] });
    });
    expect(rows()).toEqual([{ id: 'c3', status: '20 %' }]);
    expect(card()?.textContent).toContain('Preparing 0 of 1');
  });
});
