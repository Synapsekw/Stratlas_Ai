// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { error: null as string | null };

vi.mock('../shell', () => ({
  bridge: { call: vi.fn(() => Promise.resolve({ ok: false, error: 'no dialog' })) },
  jobs: { getState: () => ({ refresh: vi.fn(), start: vi.fn(), select: vi.fn() }) },
  useJobs: (selector: (s: unknown) => unknown) =>
    selector({ jobs: [], selected: null, runtime: { found: true }, error: state.error }),
  useShell: (selector: (s: { library: null }) => unknown) => selector({ library: null }),
}));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (selector: (s: { project: null }) => unknown) => selector({ project: null }),
}));

import { AdvancedPipelines } from './AdvancedPipelines';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  state.error = null;
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function show() {
  act(() => {
    root = createRoot(host);
    root.render(<AdvancedPipelines />);
  });
  const fold = host.querySelector<HTMLDetailsElement>('[data-testid="job-advanced"]');
  act(() => {
    if (fold) fold.open = true;
    fold?.dispatchEvent(new Event('toggle'));
  });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Settings, Advanced: all jobs on this computer', () => {
  it('says so when no job has run yet', () => {
    show();
    expect(q('jobs-none')?.textContent).toBe('No job has run on this computer yet.');
    expect(q('jobs-error')).toBeNull();
  });

  it('shows why the list could not be read instead of saying no job has run', () => {
    state.error = 'The job index could not be read.';
    show();
    expect(q('jobs-error')?.textContent).toBe('The job index could not be read.');
    expect(q('jobs-error')?.classList.contains('nj-err')).toBe(true);
    expect(q('jobs-none')).toBeNull();
  });
});
