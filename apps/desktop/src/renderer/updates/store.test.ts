import type { WebsiteUpdateStatus } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Bridge } from '../bridge';
import { createWebsiteUpdateStore } from './store';

const idle: WebsiteUpdateStatus = {
  accountEmail: 'engineer@example.test',
  phase: 'idle',
  currentAppVersion: '0.24.0',
  currentPipelineVersion: '0.19.0',
  app: null,
  pipeline: null,
  error: null,
  restartAvailable: false,
  restartReason: null,
  recoveryAvailable: false,
  unsupportedReason: null,
};

describe('website update status session', () => {
  it('keeps live download progress when the initial snapshot arrives late', async () => {
    let answer: ((value: unknown) => void) | undefined;
    const bridge = {
      call: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    } as Bridge;
    let event: ((status: WebsiteUpdateStatus) => void) | undefined;
    const store = createWebsiteUpdateStore(bridge, (listener) => {
      event = listener;
      return () => {
        event = undefined;
      };
    });
    const stop = store.getState().start();
    event?.({
      ...idle,
      phase: 'downloading',
      app: { version: '0.25.0', notes: '', received: 25, total: 100, verified: false },
    });
    answer?.({ ok: true, value: idle });
    await Promise.resolve();
    expect(store.getState().status?.app?.received).toBe(25);
    stop();
  });

  it('retains ready status for screens mounted later and ignores events after session cleanup', async () => {
    const bridge = { call: () => Promise.resolve({ ok: true, value: idle }) } as Bridge;
    let event: ((status: WebsiteUpdateStatus) => void) | undefined;
    let stopped = false;
    const store = createWebsiteUpdateStore(bridge, (listener) => {
      event = listener;
      return () => {
        stopped = true;
      };
    });
    const stop = store.getState().start();
    await Promise.resolve();
    event?.({ ...idle, phase: 'ready', restartAvailable: true });
    expect(store.getState().status?.restartAvailable).toBe(true);
    stop();
    event?.(idle);
    expect(stopped).toBe(true);
    expect(store.getState().status?.phase).toBe('ready');
  });

  it('shows a restart refusal while preserving the verified ready stage', async () => {
    const bridge = {
      call: (channel: string) =>
        Promise.resolve(
          channel === 'websiteUpdate:status'
            ? { ok: true, value: { ...idle, phase: 'ready', restartAvailable: true } }
            : {
                ok: true,
                value: { ok: false, error: 'Wait for processing to finish, then try again.' },
              },
        ),
    } as Bridge;
    const store = createWebsiteUpdateStore(bridge);
    const stop = store.getState().start();
    await Promise.resolve();
    await store.getState().command('restart');
    expect(store.getState().error).toContain('processing');
    expect(store.getState().status?.phase).toBe('ready');
    expect(store.getState().busy).toBe(false);
    stop();
  });
});
