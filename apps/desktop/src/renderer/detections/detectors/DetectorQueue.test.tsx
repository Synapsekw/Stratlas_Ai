// @vitest-environment jsdom
import type { DetectQueued } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  items: [] as unknown[],
  calls: [] as { channel: string; req: unknown }[],
  /** When set, every bridge answer waits for it. */
  gate: null as Promise<void> | null,
}));

vi.mock('../../shell', () => ({
  bridge: {
    call: (channel: string, req: unknown) => {
      h.calls.push({ channel, req });
      const value = channel === 'detect:queue' ? { items: h.items } : { ok: true };
      return (h.gate ?? Promise.resolve()).then(() => ({ ok: true, value }));
    },
  },
}));

import { DetectorQueue } from './DetectorQueue';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (e: { items: DetectQueued[]; failed?: { run: string; error: string } }) => void;
let listener: Listener | undefined;
let host: HTMLDivElement;
let root: Root;

const queued = (run: string, names: string[], photos: number): DetectQueued => ({
  run,
  layer: 'layer-1',
  photos,
  detectors: names,
  queuedAt: '2026-10-22T09:00:00Z',
});

beforeEach(() => {
  h.items = [];
  h.calls = [];
  h.gate = null;
  listener = undefined;
  (window as unknown as { aio: unknown }).aio = {
    on: (channel: string, fn: Listener) => {
      if (channel === 'detect:queue') listener = fn;
      return () => {
        listener = undefined;
      };
    },
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  Reflect.deleteProperty(window, 'aio');
});

async function show() {
  await act(() => {
    root.render(<DetectorQueue />);
    return Promise.resolve();
  });
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('DetectorQueue', () => {
  it('lists waiting runs with Cancel', async () => {
    h.items = [queued('run-a', ['Corrosion on metal'], 240)];
    await show();
    const row = host.querySelector('[data-testid="det-vlm-queued"]');
    expect(row?.textContent).toContain(
      'Waiting for the graphics card: Corrosion on metal, 240 photos',
    );
    await act(() => {
      button('Cancel')?.click();
      return Promise.resolve();
    });
    expect(h.calls).toContainEqual({ channel: 'detect:queueCancel', req: { run: 'run-a' } });
  });

  it('says 1 photo for a single photo', async () => {
    h.items = [queued('run-a', ['Rust'], 1)];
    await show();
    expect(host.textContent).toContain('Rust, 1 photo');
    expect(host.textContent).not.toContain('1 photos');
  });

  it('disables Cancel while the request is in flight, so a double click sends one call', async () => {
    h.items = [queued('run-a', ['Rust'], 2)];
    await show();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.gate = gate;
    await act(() => {
      button('Cancel')?.click();
      button('Cancel')?.click();
      return Promise.resolve();
    });
    expect(h.calls.filter((c) => c.channel === 'detect:queueCancel')).toHaveLength(1);
    expect(button('Cancel')?.disabled).toBe(true);
    await act(async () => {
      release();
      await gate;
    });
    expect(button('Cancel')?.disabled).toBe(false);
  });

  it('an event that arrives before a stale answer is not overwritten by it', async () => {
    h.items = [queued('run-old', ['Old'], 5)];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.gate = gate;
    await show();
    act(() => {
      listener?.({ items: [] });
    });
    await act(async () => {
      release();
      await gate;
    });
    expect(host.innerHTML).toBe('');
  });

  it('follows the detect:queue event', async () => {
    await show();
    expect(host.textContent).toBe('');
    act(() => {
      listener?.({ items: [queued('run-b', ['A', 'B'], 3)] });
    });
    expect(host.textContent).toContain('A, B, 3 photos');
    act(() => {
      listener?.({ items: [] });
    });
    expect(host.querySelector('[data-testid="det-vlm-queued"]')).toBeNull();
  });

  it('a failed waiting run shows its error until dismissed', async () => {
    await show();
    act(() => {
      listener?.({ items: [], failed: { run: 'run-a', error: 'The detector pack is missing.' } });
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'The detector pack is missing.',
    );
    // a later change without a failure does not clear it
    act(() => {
      listener?.({ items: [queued('run-c', ['X'], 1)] });
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    act(() => {
      button('Dismiss')?.click();
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders nothing when empty', async () => {
    await show();
    expect(host.innerHTML).toBe('');
  });
});
