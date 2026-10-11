// @vitest-environment jsdom
import type { JobRecord } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the container reads from the app: the job index, the open project, a package or not. */
const app = { jobs: [] as JobRecord[], root: null as string | null, pkg: false };

vi.mock('../shell', () => ({
  useJobs: (selector: (s: { jobs: JobRecord[] }) => unknown) => selector({ jobs: app.jobs }),
  useShell: (selector: (s: { pkg: object | null }) => unknown) =>
    selector({ pkg: app.pkg ? {} : null }),
}));
vi.mock('@aio/workspace', () => {
  const state = () => ({ project: app.root === null ? null : { root: app.root } });
  return {
    useWorkspace: (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    workspace: { getState: state },
  };
});

import { ChipView, chipText, ProcessingChip } from './ProcessingChip';
import { processing } from './store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'D:\\Sites\\A';
const B = 'D:\\Sites\\B';

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  app.jobs = [];
  app.root = null;
  app.pkg = false;
  processing.setState({ open: false, picked: null, seen: {} });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.useRealTimers();
});

const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="processing-chip"]');

describe('what the chip says', () => {
  it('reads each state in plain words', () => {
    expect(chipText({ kind: 'idle' })).toBe('Processing');
    expect(chipText({ kind: 'one', pct: 40 })).toBe('Processing 40%');
    expect(chipText({ kind: 'many', count: 3 })).toBe('Processing · 3 running');
    expect(chipText({ kind: 'attention', count: 1 })).toBe('1 needs attention');
    expect(chipText({ kind: 'attention', count: 2 })).toBe('2 need attention');
    expect(chipText({ kind: 'elsewhere', count: 1 })).toBe('Processing · 1 running elsewhere');
  });
});

describe('the chip', () => {
  it('is not there when hidden', () => {
    act(() => {
      root = createRoot(host);
      root.render(<ChipView state={{ kind: 'hidden' }} open={false} onToggle={() => undefined} />);
    });
    expect(chip()).toBeNull();
  });

  it('is a button that says whether the drawer is open, and toggles it', () => {
    const onToggle = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(<ChipView state={{ kind: 'one', pct: 40 }} open={false} onToggle={onToggle} />);
    });
    expect(chip()?.textContent).toBe('Processing 40%');
    expect(chip()?.getAttribute('aria-expanded')).toBe('false');
    expect(chip()?.getAttribute('aria-controls')).toBe('processing-drawer');
    expect(chip()?.dataset.state).toBe('one');
    act(() => chip()?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('carries a warning mark when something needs attention', () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <ChipView
          state={{ kind: 'attention', count: 1 }}
          open={false}
          onToggle={() => undefined}
        />,
      );
    });
    expect(chip()?.dataset.state).toBe('attention');
    expect(chip()?.querySelector('svg')).not.toBeNull();
  });

  it('is named for the feature in every state, whatever the visible words', () => {
    const states = [
      [{ kind: 'idle' }, 'Processing'],
      [{ kind: 'one', pct: 40 }, 'Processing 40%'],
      [{ kind: 'many', count: 3 }, 'Processing · 3 running'],
      [{ kind: 'attention', count: 1 }, 'Processing: 1 needs attention'],
      [{ kind: 'attention', count: 2 }, 'Processing: 2 need attention'],
      [{ kind: 'elsewhere', count: 1 }, 'Processing · 1 running elsewhere'],
    ] as const;
    for (const [state, label] of states) {
      act(() => {
        root ??= createRoot(host);
        root.render(<ChipView state={state} open={false} onToggle={() => undefined} />);
      });
      expect(chip()?.getAttribute('aria-label')).toBe(label);
    }
    // the visible words stay as they were
    expect(chip()?.textContent).toBe('Processing · 1 running elsewhere');
    act(() => {
      root?.render(
        <ChipView
          state={{ kind: 'attention', count: 1 }}
          open={false}
          onToggle={() => undefined}
        />,
      );
    });
    expect(chip()?.textContent).toBe('1 needs attention');
  });

  it('has a tooltip that fits a project and what runs elsewhere', () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <ChipView
          state={{ kind: 'elsewhere', count: 1 }}
          open={false}
          onToggle={() => undefined}
        />,
      );
    });
    expect(chip()?.title).not.toContain('this project');
  });
});

let n = 0;
const job = (over: Partial<JobRecord>): JobRecord => ({
  id: `job-${String(++n)}`,
  pipeline: 'inspection.run',
  project: A,
  status: 'done',
  progress: 1,
  params: {},
  steps: [],
  artifacts: [],
  createdAt: '2026-10-11T08:00:00.000Z',
  updatedAt: '2026-10-11T08:05:00.000Z',
  ...over,
});

/** A moment `ms` after this session started, as the chip counts it. */
const afterStart = (ms: number) => new Date(Date.parse(processing.getState().start) + ms);

function mount() {
  act(() => {
    root ??= createRoot(host);
    root.render(<ProcessingChip />);
  });
}

describe('the chip of the open project', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  it('is idle in a project with nothing to report', () => {
    app.root = A;
    mount();
    expect(chip()?.dataset.state).toBe('idle');
    expect(chip()?.textContent).toBe('Processing');
  });

  it('counts a failure after the session started, and the drawer open clears it', () => {
    app.root = A;
    app.jobs = [job({ status: 'failed', updatedAt: afterStart(1000).toISOString() })];
    mount();
    expect(chip()?.dataset.state).toBe('attention');
    expect(chip()?.textContent).toBe('1 needs attention');
    vi.setSystemTime(afterStart(60_000));
    act(() => chip()?.click());
    expect(processing.getState().open).toBe(true);
    expect(chip()?.dataset.state).toBe('idle');
    // closed again: the look is later than the failure, so it stays quiet
    act(() => chip()?.click());
    expect(processing.getState().open).toBe(false);
    expect(chip()?.dataset.state).toBe('idle');
  });

  it('leaves a failure from before the session alone', () => {
    app.root = A;
    app.jobs = [job({ status: 'failed', updatedAt: afterStart(-60_000).toISOString() })];
    mount();
    expect(chip()?.dataset.state).toBe('idle');
  });

  it('keeps the look per project', () => {
    app.root = A;
    app.jobs = [
      job({ status: 'failed', updatedAt: afterStart(1000).toISOString() }),
      job({ project: B, status: 'failed', updatedAt: afterStart(2000).toISOString() }),
    ];
    mount();
    vi.setSystemTime(afterStart(60_000));
    act(() => chip()?.click());
    act(() => chip()?.click());
    expect(chip()?.dataset.state).toBe('idle');
    app.root = B;
    mount();
    expect(chip()?.dataset.state).toBe('attention');
  });

  it('shows the progress of the one job that runs', () => {
    app.root = A;
    app.jobs = [job({ status: 'running', progress: 0.4 })];
    mount();
    expect(chip()?.textContent).toBe('Processing 40%');
  });
});

describe('the chip with no project of its own', () => {
  it('is not there with no project open and nothing running', () => {
    mount();
    expect(chip()).toBeNull();
  });

  it('shows only what runs elsewhere with no project open', () => {
    app.jobs = [job({ project: B, status: 'running' })];
    mount();
    expect(chip()?.dataset.state).toBe('elsewhere');
  });

  it('is not there in a read-only package with nothing running', () => {
    app.root = A;
    app.pkg = true;
    app.jobs = [job({ status: 'failed', updatedAt: afterStart(1000).toISOString() })];
    mount();
    expect(chip()).toBeNull();
  });

  it('shows only "running elsewhere" in a read-only package, whatever its folder holds', () => {
    app.root = A;
    app.pkg = true;
    app.jobs = [
      job({ status: 'failed', updatedAt: afterStart(1000).toISOString() }),
      job({ status: 'running' }),
      job({ project: B, status: 'running' }),
    ];
    mount();
    expect(chip()?.dataset.state).toBe('elsewhere');
    expect(chip()?.textContent).toBe('Processing · 2 running elsewhere');
  });
});
