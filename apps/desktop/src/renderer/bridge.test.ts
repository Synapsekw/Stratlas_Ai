import type { AioBridge } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { afterCall, beforeJobStart, createBridge } from './bridge';

const START = { pipeline: 'aik.cameras', project: 'E:\\p', params: {} } as const;

/** A window.aio that records the channels it was asked, in order. */
function fakeAio(log: string[]): AioBridge {
  return {
    invoke: (channel: string) => {
      log.push(channel);
      return Promise.resolve({ ok: true });
    },
    on: () => () => undefined,
  } as unknown as AioBridge;
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('checks before a job start', () => {
  it('finishes every check before main is asked to start the job', async () => {
    const log: string[] = [];
    const bridge = createBridge(fakeAio(log));
    stops.push(
      beforeJobStart(async () => {
        await new Promise((r) => setTimeout(r, 5));
        log.push('first check done');
        return null;
      }),
      beforeJobStart(() => {
        log.push('second check done');
        return Promise.resolve(null);
      }),
    );
    const r = await bridge.call('jobs:start', START);
    expect(r.ok).toBe(true);
    expect(log).toEqual(['first check done', 'second check done', 'jobs:start']);
  });

  it('does not start the job when a check refuses, and answers its sentence', async () => {
    const log: string[] = [];
    const bridge = createBridge(fakeAio(log));
    stops.push(beforeJobStart(() => Promise.resolve('The issues are not saved.')));
    const r = await bridge.call('jobs:start', START);
    expect(r).toEqual({ ok: false, error: 'The issues are not saved.' });
    expect(log).toEqual([]);
  });

  it('does not start the job when a check throws', async () => {
    const log: string[] = [];
    const bridge = createBridge(fakeAio(log));
    stops.push(beforeJobStart(() => Promise.reject(new Error('disk full'))));
    const r = await bridge.call('jobs:start', START);
    expect(r).toEqual({ ok: false, error: 'disk full' });
    expect(log).toEqual([]);
  });

  it('holds for every bridge of the window, and leaves other channels alone', async () => {
    const log: string[] = [];
    stops.push(beforeJobStart(() => Promise.resolve('Not saved.')));
    const other = createBridge(fakeAio(log));
    expect((await other.call('jobs:start', START)).ok).toBe(false);
    expect((await other.call('jobs:list', {})).ok).toBe(true);
    expect(log).toEqual(['jobs:list']);
  });

  it('starts as before once the check is taken away', async () => {
    const log: string[] = [];
    const stop = beforeJobStart(() => Promise.resolve('Not saved.'));
    stop();
    expect((await createBridge(fakeAio(log)).call('jobs:start', START)).ok).toBe(true);
    expect(log).toEqual(['jobs:start']);
  });
});

describe('after a call', () => {
  it('runs what follows a channel once main answered it, for every bridge of the window', async () => {
    const log: string[] = [];
    let saved = 0;
    stops.push(
      afterCall('ai:setKey', () => {
        saved++;
      }),
    );
    await createBridge(fakeAio(log)).call('ai:setKey', { provider: 'anthropic', key: 'k' });
    await createBridge(fakeAio(log)).call('ai:hasKey', { provider: 'anthropic' });
    expect(saved).toBe(1);
  });

  it('does not run it when the call failed, or once it is taken away', async () => {
    let saved = 0;
    const stop = afterCall('ai:setKey', () => {
      saved++;
    });
    const failing = {
      invoke: () => Promise.reject(new Error('vault locked')),
      on: () => () => undefined,
    } as unknown as AioBridge;
    const r = await createBridge(failing).call('ai:setKey', { provider: 'anthropic', key: 'k' });
    expect(r.ok).toBe(false);
    stop();
    await createBridge(fakeAio([])).call('ai:setKey', { provider: 'anthropic', key: 'k' });
    expect(saved).toBe(0);
  });
});
