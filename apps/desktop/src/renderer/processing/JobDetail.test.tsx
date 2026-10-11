// @vitest-environment jsdom
import type { JobRecord } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const where = { root: 'D:\\Sites\\A' as string | null, pkg: false };
const logs: Record<string, { time: string; level: string; message: string }[]> = {};

vi.mock('../shell', () => ({
  jobs: { getState: () => ({ cancel: vi.fn(), start: vi.fn(), open: vi.fn() }) },
  useJobs: (selector: (s: { logs: typeof logs }) => unknown) => selector({ logs }),
  useShell: (selector: (s: { pkg: object | null }) => unknown) =>
    selector({ pkg: where.pkg ? {} : null }),
}));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (selector: (s: { project: { root: string } | null }) => unknown) =>
    selector({ project: where.root === null ? null : { root: where.root } }),
}));

import { JobDetail } from './JobDetail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const photoJob = (project: string): JobRecord => ({
  id: 'job-42',
  pipeline: 'photo.products',
  project,
  status: 'done',
  progress: 1,
  params: { run: 'run-1' },
  steps: [],
  artifacts: [],
  createdAt: '2026-10-11T08:00:00.000Z',
  updatedAt: '2026-10-11T08:05:00.000Z',
});

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  where.root = 'D:\\Sites\\A';
  where.pkg = false;
  for (const k of Object.keys(logs)) Reflect.deleteProperty(logs, k);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function show(job: JobRecord) {
  act(() => {
    root = createRoot(host);
    root.render(<JobDetail job={job} now={Date.parse('2026-10-11T09:00:00.000Z')} folded />);
  });
}
const openRun = () => host.querySelector('[data-testid="job-open-run"]');

describe('a job in the drawer (folded)', () => {
  it('folds the settings and the log away and shows the job id with the facts', () => {
    show(photoJob('D:\\Sites\\A'));
    expect(host.querySelector('.job-detail')?.getAttribute('data-form')).toBe('folded');
    expect(host.querySelectorAll('details.jd-fold')).toHaveLength(2);
    expect(host.querySelector('[data-testid="job-settings"]')?.textContent).toContain('job-42');
  });

  it('offers Open run for a photo job of the open project', () => {
    show(photoJob('d:/sites/a/'));
    expect(openRun()).not.toBeNull();
  });

  it('hides Open run for a photo job of another project', () => {
    show(photoJob('D:\\Sites\\B'));
    expect(openRun()).toBeNull();
  });

  it('hides Open run in a read-only package', () => {
    where.pkg = true;
    show(photoJob('D:\\Sites\\A'));
    expect(openRun()).toBeNull();
  });

  it('hides Open run with no project open', () => {
    where.root = null;
    show(photoJob('D:\\Sites\\A'));
    expect(openRun()).toBeNull();
  });

  it('renders the log lines only while the log fold is open', () => {
    logs['job-42'] = [{ time: '2026-10-11T08:00:01.000Z', level: 'info', message: 'hello' }];
    show(photoJob('D:\\Sites\\A'));
    expect(host.querySelector('.job-log')).toBeNull();
    const fold = host.querySelector<HTMLDetailsElement>('[data-testid="job-log-fold"]');
    act(() => {
      if (fold) fold.open = true;
      fold?.dispatchEvent(new Event('toggle'));
    });
    expect(host.querySelector('.job-log')?.textContent).toContain('hello');
  });
});
