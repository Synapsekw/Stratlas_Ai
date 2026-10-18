// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StageList } from './StageList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const rows = () =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="eng-stage"]')].map((r) => [
    r.dataset.stage,
    r.dataset.status,
  ]);
const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

describe('StageList', () => {
  it('shows the six stages, pending until reached, with Cancel while one runs', () => {
    const onCancel = vi.fn();
    act(() =>
      root?.render(
        <StageList
          stages={{
            inspect: { status: 'done' },
            estimate: { status: 'running', message: 'Measuring the shaft' },
          }}
          onCancel={onCancel}
          onRetry={() => undefined}
        />,
      ),
    );
    expect(rows()).toEqual([
      ['inspect', 'done'],
      ['estimate', 'running'],
      ['identify', 'pending'],
      ['generate', 'pending'],
      ['validate', 'pending'],
      ['review', 'pending'],
    ]);
    expect(host.textContent).toContain('Measuring the shaft');
    expect(host.querySelector('[aria-current="step"]')?.getAttribute('data-stage')).toBe(
      'estimate',
    );
    expect(q('eng-retry')).toBeNull();
    act(() => q('eng-cancel')?.click());
    expect(onCancel).toHaveBeenCalled();
  });

  it('offers Retry after a failure or a cancel, with the reason', () => {
    const onRetry = vi.fn();
    act(() =>
      root?.render(
        <StageList
          stages={{
            inspect: { status: 'done' },
            estimate: { status: 'done' },
            identify: { status: 'failed', message: 'The provider refused the request.' },
          }}
          onCancel={() => undefined}
          onRetry={onRetry}
        />,
      ),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('refused');
    expect(q('eng-cancel')).toBeNull();
    act(() => q('eng-retry')?.click());
    expect(onRetry).toHaveBeenCalled();
    act(() =>
      root?.render(
        <StageList
          stages={{ inspect: { status: 'cancelled' } }}
          onCancel={() => undefined}
          onRetry={onRetry}
        />,
      ),
    );
    expect(q('eng-retry')).not.toBeNull();
  });

  it('follows the store: a stage left running by a closed app offers Retry, not Cancel', () => {
    const onRetry = vi.fn();
    act(() =>
      root?.render(
        <StageList
          stages={{ inspect: { status: 'done' }, estimate: { status: 'running' } }}
          busy={false}
          onCancel={() => undefined}
          onRetry={onRetry}
        />,
      ),
    );
    expect(q('eng-cancel')).toBeNull();
    act(() => q('eng-retry')?.click());
    expect(onRetry).toHaveBeenCalled();
  });

  it('offers an explicit AI pass after a measured-only draft without starting it automatically', () => {
    const onRetry = vi.fn();
    act(() =>
      root?.render(
        <StageList
          stages={{
            inspect: { status: 'done' },
            estimate: { status: 'done' },
            identify: { status: 'skipped', message: 'Nothing was sent: the send was declined.' },
            generate: { status: 'done' },
            validate: { status: 'done' },
            review: { status: 'done' },
          }}
          busy={false}
          onCancel={() => undefined}
          onRetry={onRetry}
        />,
      ),
    );
    expect(onRetry).not.toHaveBeenCalled();
    expect(q('eng-run-ai')?.textContent).toBe('Run AI pass');
    expect(q('eng-cancel')).toBeNull();
    expect(q('eng-retry')).toBeNull();
    act(() => q('eng-run-ai')?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'skipped' as const, busy: true, error: null },
    { status: 'done' as const, busy: false, error: null },
    { status: 'skipped' as const, busy: false, error: 'Offline' },
  ])('does not offer a separate AI pass for $status, busy=$busy, error=$error', (state) => {
    act(() =>
      root?.render(
        <StageList
          stages={{ identify: { status: state.status } }}
          busy={state.busy}
          error={state.error}
          onCancel={() => undefined}
          onRetry={() => undefined}
        />,
      ),
    );
    expect(q('eng-run-ai')).toBeNull();
  });

  it('a run stopped with a reason (photos alone, offline) offers Retry', () => {
    act(() =>
      root?.render(
        <StageList
          stages={{
            inspect: { status: 'done' },
            estimate: { status: 'done' },
            identify: { status: 'skipped', message: 'Offline' },
          }}
          busy={false}
          error="Offline"
          onCancel={() => undefined}
          onRetry={() => undefined}
        />,
      ),
    );
    expect(q('eng-retry')).not.toBeNull();
    // while the store is at work, Cancel only
    act(() =>
      root?.render(
        <StageList
          stages={{ inspect: { status: 'pending' } }}
          busy
          onCancel={() => undefined}
          onRetry={() => undefined}
        />,
      ),
    );
    expect(q('eng-cancel')).not.toBeNull();
    expect(q('eng-retry')).toBeNull();
  });
});
