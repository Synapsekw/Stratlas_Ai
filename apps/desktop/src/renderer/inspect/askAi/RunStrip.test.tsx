// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskRun } from './runs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  stop: vi.fn(),
  retry: vi.fn(),
  clear: vi.fn(),
  readOnly: false,
  queue: [] as unknown[],
}));

vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => h.readOnly }));
vi.mock('./runs', async () => {
  const { createStore } = await import('zustand/vanilla');
  const { useStore } = await import('zustand');
  const askAiRun = createStore<{ run: AskRun | null }>(() => ({ run: null }));
  return {
    askAiRun,
    useAskAiRun: <T,>(sel: (s: { run: AskRun | null }) => T) => useStore(askAiRun, sel),
    stopAskRun: h.stop,
    retryAskRun: h.retry,
    clearAskRun: h.clear,
  };
});

vi.mock('../../shell', () => ({
  bridge: {
    call: (channel: string) =>
      Promise.resolve({ ok: true, value: channel === 'detect:queue' ? { items: h.queue } : {} }),
  },
}));

const { RunStrip } = await import('./RunStrip');
const { askAiRun } = await import('./runs');
const { inspectUi } = await import('../inspectUi');

const run = (over: Partial<AskRun> = {}): AskRun => ({
  runIds: ['r1'],
  projectId: 'proj',
  backend: 'cloud',
  what: 'Corrosion',
  frames: false,
  total: 10,
  done: 4,
  found: 3,
  phase: 'running',
  remaining: [],
  ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  h.stop.mockReset();
  h.retry.mockReset();
  h.retry.mockResolvedValue(undefined);
  h.clear.mockReset();
  h.readOnly = false;
  h.queue = [];
  askAiRun.setState({ run: null });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const set = (r: AskRun | null) => {
  act(() => {
    askAiRun.setState({ run: r });
  });
};
const click = (id: string) => {
  act(() => {
    q(id)?.click();
  });
};

describe('RunStrip', () => {
  it('shows nothing without a run', () => {
    act(() => {
      root.render(<RunStrip />);
    });
    expect(q('ask-ai-run')).toBeNull();
  });

  it('shows the run, stops it, and offers the photos left after a failure', () => {
    act(() => {
      root.render(<RunStrip />);
    });
    set(run());
    expect(q('ask-ai-run')?.textContent).toContain(
      'AI is checking 10 photos for Corrosion · 4 done · suggestions appear as they arrive',
    );
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('4');
    expect(bar?.getAttribute('aria-valuemax')).toBe('10');
    expect(q('ask-ai-retry')).toBeNull();
    click('ask-ai-stop');
    expect(h.stop).toHaveBeenCalled();

    const left = [1, 2, 3, 4, 5, 6].map((k) => ({
      kind: 'photo' as const,
      layer: 'photos',
      photo: `p${String(k)}`,
    }));
    set(run({ phase: 'failed', error: 'The provider is busy.', remaining: left }));
    expect(q('ask-ai-run')?.textContent).toContain('The AI run stopped: The provider is busy.');
    expect(q('ask-ai-stop')).toBeNull();
    expect(q('ask-ai-retry')?.textContent).toBe('Try the 6 left again');
    click('ask-ai-retry');
    expect(h.retry).toHaveBeenCalled();
  });

  it('says why a retry failed', async () => {
    h.retry.mockRejectedValue(new Error('The review could not be read.'));
    act(() => {
      root.render(<RunStrip />);
    });
    set(run({ phase: 'failed', remaining: [{ kind: 'photo', layer: 'photos', photo: 'p9' }] }));
    expect(q('ask-ai-run-error')).toBeNull();
    await act(async () => {
      q('ask-ai-retry')?.click();
      await Promise.resolve();
    });
    expect(q('ask-ai-run-error')?.textContent).toBe(
      'The AI run stopped: The review could not be read.',
    );
  });

  it('says where a stopped run ended', () => {
    act(() => {
      root.render(<RunStrip />);
    });
    set(run({ phase: 'stopped', remaining: [{ kind: 'photo', layer: 'photos', photo: 'p9' }] }));
    expect(q('ask-ai-run')?.textContent).toContain('Stopped after 4 of 10.');
    expect(q('ask-ai-retry')?.textContent).toBe('Try the 1 left again');
  });

  it('counts frames for a frame run, and says when it waits for the detector', () => {
    act(() => {
      root.render(<RunStrip />);
    });
    set(run({ frames: true, total: 1, done: 0 }));
    expect(q('ask-ai-run')?.textContent).toContain('AI is checking 1 frame for Corrosion');
    set(run({ phase: 'queued' }));
    expect(q('ask-ai-run')?.textContent).toContain('Waiting for the local detector to be free');
    expect(q('ask-ai-stop')).not.toBeNull();
  });

  it('opens the queue from Review n suggestions', () => {
    act(() => {
      root.render(<RunStrip />);
    });
    set(run({ phase: 'done', done: 10 }));
    expect(q('ask-ai-run')?.textContent).toContain('AI checked 10 photos and found 3.');
    expect(q('ask-ai-review')?.textContent).toBe('Review 3 suggestions');
    click('ask-ai-review');
    expect(inspectUi.getState().panel).toBe('queue');
    click('ask-ai-run-close');
    expect(h.clear).toHaveBeenCalled();
  });

  it('offers no review when nothing was found', () => {
    act(() => {
      root.render(<RunStrip />);
    });
    set(run({ phase: 'done', done: 10, found: 0 }));
    expect(q('ask-ai-review')).toBeNull();
  });

  it('does not try again in a read-only package', () => {
    h.readOnly = true;
    act(() => {
      root.render(<RunStrip />);
    });
    set(run({ phase: 'failed', remaining: [{ kind: 'photo', layer: 'photos', photo: 'p9' }] }));
    const retry = q('ask-ai-retry');
    // focusable, so its tip can say why
    expect(retry?.disabled).toBe(false);
    expect(retry?.getAttribute('aria-disabled')).toBe('true');
    click('ask-ai-retry');
    expect(h.retry).not.toHaveBeenCalled();
  });

  it('says stopping, not stopped, until a stopped run has ended', () => {
    act(() => {
      root.render(<RunStrip />);
    });
    set(run({ phase: 'stopping' }));
    expect(q('ask-ai-run')?.textContent).toContain('Stopping after 4 of 10.');
    expect(q('ask-ai-run')?.textContent).not.toContain('Stopped');
    expect(q('ask-ai-stop')).toBeNull();
    expect(q('ask-ai-run-close')).toBeNull();
  });

  it('counts frames, not photos, when a frame run is done', () => {
    act(() => {
      root.render(<RunStrip />);
    });
    set(run({ frames: true, phase: 'done', done: 3, total: 3, found: 2 }));
    expect(q('ask-ai-run')?.textContent).toContain('AI checked 3 frames and found 2.');
  });

  it('lists the detector runs waiting for the graphics card, without an Ask AI run', async () => {
    h.queue = [
      { run: 'run-a', layer: 'l', photos: 3, detectors: ['Rust'], queuedAt: '2026-10-24T09:00Z' },
    ];
    await act(async () => {
      root.render(<RunStrip />);
      await Promise.resolve();
    });
    expect(q('ask-ai-run')).toBeNull();
    expect(q('ask-ai-queued')?.textContent).toContain(
      'Waiting for the graphics card: Rust, 3 photos',
    );
  });
});
