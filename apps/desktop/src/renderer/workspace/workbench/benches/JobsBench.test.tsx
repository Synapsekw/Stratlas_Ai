// @vitest-environment jsdom
import type { JobRecord } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processing } from '../../../processing/store';
import { jobs } from '../../../shell';
import { threeDates } from '../../__fixtures__/threeDates';
import { JobsBench } from './JobsBench';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const job = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
  id,
  pipeline: 'photo.products',
  project: '/p',
  status: 'running',
  progress: 0.4,
  params: {},
  steps: [
    { name: 'align', title: 'Align photos', state: 'done' },
    { name: 'mesh', title: 'Build the mesh', state: 'running' },
  ],
  artifacts: [],
  createdAt: '2026-10-11T08:00:00.000Z',
  updatedAt: '2026-10-11T08:05:00.000Z',
  ...over,
});

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root = createRoot(host);
  act(() => root?.render(<JobsBench />));
};
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-job]')];
const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name);

beforeEach(() => {
  jobs.setState({ jobs: [], logs: {} });
  processing.setState({ open: false, picked: null });
  workspace.getState().openProject({ id: 'p', root: '/p', manifest: threeDates });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('JobsBench', () => {
  it('says so when nothing runs', () => {
    render();
    expect(host.textContent).toContain('No jobs running');
    expect(rows()).toHaveLength(0);
  });

  it('lists two running jobs as two rows in the one tab, and leaves finished ones out', () => {
    jobs.setState({
      jobs: [
        job('j2', { createdAt: '2026-10-11T08:10:00.000Z' }),
        job('j1'),
        job('j0', { status: 'done', progress: 1 }),
      ],
    });
    render();
    expect(rows().map((r) => r.dataset.job)).toEqual(['j1', 'j2']);
    expect(host.querySelectorAll('.row[data-kind="tree"]')).toHaveLength(2);
  });

  it('lists a quiet job too', () => {
    jobs.setState({ jobs: [job('j1', { quiet: true } as Partial<JobRecord>), job('j2')] });
    render();
    expect(rows().map((r) => r.dataset.job)).toEqual(['j1', 'j2']);
  });

  it('shows the ring, the steps and the log of each job', () => {
    jobs.setState({
      jobs: [job('j1')],
      logs: {
        j1: [{ time: '2026-10-11T08:01:02.000Z', level: 'info', message: 'Matching pairs' }],
      },
    });
    render();
    const row = rows()[0];
    expect(row?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
    expect(row?.textContent).toContain('Build the mesh');
    expect(row?.textContent).toContain('Matching pairs');
  });

  it('cancels one job', () => {
    const cancel = vi.fn(() => Promise.resolve(null));
    jobs.setState({ jobs: [job('j1'), job('j2')], cancel });
    render();
    const target = rows().find((r) => r.dataset.job === 'j2');
    act(() => {
      if (target) button(target, 'Cancel')?.click();
    });
    expect(cancel).toHaveBeenCalledWith('j2');
  });

  it('opens the job in the drawer, on its details', () => {
    jobs.setState({ jobs: [job('j1')] });
    render();
    act(() => {
      button(rows()[0] ?? host, 'Open the job')?.click();
    });
    expect(processing.getState()).toMatchObject({ open: true, picked: 'j1' });
  });
});
