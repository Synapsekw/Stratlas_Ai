// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn<(req: unknown) => Promise<string | null>>(() => Promise.resolve(null));

vi.mock('../shell', () => ({
  bridge: { call: vi.fn(() => Promise.resolve({ ok: false, error: 'no dialog' })) },
  jobs: { getState: () => ({ start, selected: 'job-1' }) },
  useJobs: (selector: (s: { runtime: { found: boolean } }) => unknown) =>
    selector({ runtime: { found: true } }),
}));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (
    selector: (s: { project: { root: string; manifest: { type: string } } }) => unknown,
  ) => selector({ project: { root: 'D:\\Sites\\A', manifest: { type: 'inspection' } } }),
}));

import { PipelineForm } from './PipelineForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  start.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const settle = () => act(() => Promise.resolve());

describe('the pipeline form', () => {
  it('offers the pipeline and the project folder when it is free', () => {
    act(() => {
      root = createRoot(host);
      root.render(<PipelineForm />);
    });
    expect(host.querySelector('#job-pipeline')).not.toBeNull();
    expect(host.querySelector('#job-f-project')).not.toBeNull();
  });

  it('fixed to one pipeline of the open project, asks for neither and starts there', async () => {
    const onStarted = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(
        <PipelineForm
          fixed
          draft={{ pipeline: 'inspection.run', project: 'D:\\Sites\\A', values: {} }}
          onStarted={onStarted}
          onClose={onClose}
        />,
      );
    });
    expect(host.querySelector('#job-pipeline')).toBeNull();
    expect(host.querySelector('#job-f-project')).toBeNull();
    expect(host.querySelector('#job-f-detections')).not.toBeNull();
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="job-start"]')?.click();
    });
    await settle();
    expect(start).toHaveBeenCalledWith({
      pipeline: 'inspection.run',
      project: 'D:\\Sites\\A',
      params: {},
    });
    expect(onStarted).toHaveBeenCalledWith('job-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the form open and says why when the job does not start', async () => {
    start.mockResolvedValueOnce('The processing tools are missing.');
    const onStarted = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(
        <PipelineForm
          fixed
          draft={{ pipeline: 'inspection.run', project: 'D:\\Sites\\A', values: {} }}
          onStarted={onStarted}
        />,
      );
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="job-start"]')?.click();
    });
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The processing tools are missing.',
    );
    expect(onStarted).not.toHaveBeenCalled();
  });
});
