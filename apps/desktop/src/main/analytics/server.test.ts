import { ANALYTICS_PACK_SCHEMA, VlmServerState, type AnalyticsPackManifest } from '@aio/schema';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsPack } from './pack';
import { VLM_HEALTH_TIMEOUT_MS, VlmServer, type ChildLike, type ServerDeps } from './server';

const SHA = 'c'.repeat(64);
const KEY = '0123456789abcdef0123456789abcdef';

const manifest: AnalyticsPackManifest = {
  schema: ANALYTICS_PACK_SCHEMA,
  version: '1.0.0',
  appRange: '>=0.25.0 <2.0.0',
  platform: 'win-x64',
  createdAt: '2026-10-01T00:00:00.000Z',
  runtime: { name: 'llama.cpp', release: 'b1', executable: 'llama/llama-server.exe' },
  model: { id: 'qwen-vl', licence: 'Apache-2.0', gguf: 'm.gguf', mmproj: 'p.gguf', sha256: SHA },
  detectors: [],
  files: {},
};
const pack = (dir = 'D:/data/runtime/analytics-pack-1.0.0'): AnalyticsPack => ({
  version: '1.0.0',
  dir,
  manifest,
  server: `${dir}/llama/llama-server.exe`,
  gguf: `${dir}/m.gguf`,
  mmproj: `${dir}/p.gguf`,
});

/** The item at `i` (negative from the end); throws when there is none. */
function at<T>(xs: readonly T[], i: number): T {
  const v = xs.at(i);
  if (v === undefined) throw new Error(`nothing at ${String(i)}`);
  return v;
}

class FakeChild extends EventEmitter implements ChildLike {
  killed = false;
  constructor(readonly pid: number) {
    super();
  }
  kill() {
    this.killed = true;
  }
}

function harness(health: () => number = () => 200) {
  const children: FakeChild[] = [];
  const spawned: { exe: string; args: string[]; env: Record<string, string> }[] = [];
  const states: (VlmServerState | null)[] = [];
  const killed: (number | undefined)[] = [];
  let deletedSync = 0;
  const asked: { url: string; auth: string | null }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return Promise.resolve(new Response('{}', { status: health() }));
  };
  const deps: ServerDeps = {
    spawn: (exe, args, env) => {
      spawned.push({ exe, args, env });
      const c = new FakeChild(4000 + children.length);
      children.push(c);
      return c;
    },
    fetch,
    freePort: () => Promise.resolve(51234),
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return {
        clear: () => {
          clearTimeout(t);
        },
      };
    },
    writeState: (s) => {
      states.push(s);
      return Promise.resolve();
    },
    killTree: (pid) => {
      killed.push(pid);
    },
    deleteStateSync: () => {
      deletedSync += 1;
    },
    randomKey: () => KEY,
  };
  return {
    server: new VlmServer(deps),
    children,
    spawned,
    states,
    killed,
    asked,
    deletedSync: () => deletedSync,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('VlmServer', () => {
  it('starts once and reuses', async () => {
    const h = harness();
    const a = await h.server.ensure(pack(), 0);
    const b = await h.server.ensure(pack(), 0);
    expect(a.ok && b.ok).toBe(true);
    expect(h.spawned).toHaveLength(1);
    const { exe, args, env } = at(h.spawned, 0);
    expect(exe).toBe('D:/data/runtime/analytics-pack-1.0.0/llama/llama-server.exe');
    expect(args).toEqual([
      '--model',
      'D:/data/runtime/analytics-pack-1.0.0/m.gguf',
      '--mmproj',
      'D:/data/runtime/analytics-pack-1.0.0/p.gguf',
      '--host',
      '127.0.0.1',
      '--port',
      '51234',
      '--ctx-size',
      '8192',
      '-ngl',
      '99',
      '--parallel',
      '1',
      '--no-ui',
      '--api-key',
      KEY,
    ]);
    expect(env).toEqual({ CUDA_VISIBLE_DEVICES: '0' });
    expect(h.server.serves(pack().dir)).toBe(true);
  });

  it('two ensures at once share one start', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.server.ensure(pack(), null),
      h.server.ensure(pack(), null),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.spawned).toHaveLength(1);
    expect(at(h.spawned, 0).env).toEqual({});
  });

  it('waits for health then writes state', async () => {
    let ready = false;
    const h = harness(() => (ready ? 200 : 503));
    const p = h.server.ensure(pack(), 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.states).toEqual([]);
    ready = true;
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(r.ok).toBe(true);
    const state = h.states.at(-1);
    expect(VlmServerState.parse(state)).toEqual({
      url: 'http://127.0.0.1:51234',
      pid: 4000,
      apiKey: KEY,
      modelSha256: SHA,
      startedAt: expect.any(String) as string,
    });
    if (r.ok) expect(r.state).toEqual(state);
    expect(at(h.asked, -1)).toEqual({
      url: 'http://127.0.0.1:51234/health',
      auth: `Bearer ${KEY}`,
    });
  });

  it('health never ok kills and fails with reason', async () => {
    const h = harness(() => 503);
    const p = h.server.ensure(pack(), 0);
    await vi.advanceTimersByTimeAsync(VLM_HEALTH_TIMEOUT_MS + 2_000);
    const r = await p;
    expect(r).toEqual({ ok: false, error: expect.stringContaining('120 s') as string });
    expect(h.killed).toEqual([4000]);
    expect(h.states.filter((s) => s !== null)).toEqual([]);
    expect(h.server.serves(pack().dir)).toBe(false);
  });

  it('a server that exits while loading fails with its exit code', async () => {
    const h = harness(() => 503);
    const p = h.server.ensure(pack(), 0);
    await vi.advanceTimersByTimeAsync(1_000);
    at(h.children, 0).emit('exit', 3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toEqual({ ok: false, error: expect.stringContaining('3') as string });
  });

  it('idle stops at once and deletes state', async () => {
    const h = harness();
    await h.server.ensure(pack(), 0);
    h.server.busy();
    h.server.idle();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.killed).toEqual([4000]);
    expect(h.states.at(-1)).toBeNull();
    expect(h.server.serves(pack().dir)).toBe(false);
    // the next run starts it again
    await h.server.ensure(pack(), 0);
    expect(h.spawned).toHaveLength(2);
  });

  it('does not stop while a queued run waits', async () => {
    let ready = false;
    const h = harness(() => (ready ? 200 : 503));
    // a queued run is going through the gate: its ensure is still loading the model
    const p = h.server.ensure(pack(), 0);
    await vi.advanceTimersByTimeAsync(1_000);
    h.server.idle();
    ready = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).ok).toBe(true);
    expect(h.killed).toEqual([]);
    // and nothing else stops it: no idle timer
    h.server.busy();
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(h.killed).toEqual([]);
    expect(h.server.serves(pack().dir)).toBe(true);
  });

  it('stopSync kills the child', async () => {
    const h = harness();
    await h.server.ensure(pack(), 0);
    h.server.stopSync();
    expect(h.killed).toEqual([4000]);
    expect(h.deletedSync()).toBe(1);
    expect(h.server.serves(pack().dir)).toBe(false);
  });

  it('a crash clears state so the next ensure restarts', async () => {
    const h = harness();
    await h.server.ensure(pack(), 0);
    at(h.children, 0).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states.at(-1)).toBeNull();
    const r = await h.server.ensure(pack(), 0);
    expect(r.ok).toBe(true);
    expect(h.spawned).toHaveLength(2);
    expect(h.states.at(-1)).toMatchObject({ pid: 4001 });
  });

  it('another pack restarts the server', async () => {
    const h = harness();
    await h.server.ensure(pack(), 0);
    await h.server.ensure(pack('D:/data/runtime/analytics-pack-1.1.0'), 0);
    expect(h.killed).toEqual([4000]);
    expect(h.spawned).toHaveLength(2);
  });

  it('holds a pack folder off while it is changed', async () => {
    const h = harness();
    await h.server.ensure(pack(), 0);
    // in use: no hold on it, nor on every pack
    expect(h.server.hold(pack().dir)).toBeNull();
    expect(h.server.hold()).toBeNull();
    // another folder may be changed
    const other = h.server.hold('D:/data/runtime/analytics-pack-0.9.0');
    expect(other).not.toBeNull();
    other?.();
    await h.server.stop();
    const release = h.server.hold(pack().dir);
    expect(release).not.toBeNull();
    // the server does not start from a folder being removed
    expect(await h.server.ensure(pack(), 0)).toEqual({
      ok: false,
      error: expect.stringContaining('Analytics pack') as string,
    });
    release?.();
    expect((await h.server.ensure(pack(), 0)).ok).toBe(true);
  });

  it('attach writes a state file for a server it did not start', async () => {
    const h = harness();
    const s = await h.server.attach('http://127.0.0.1:40000', SHA);
    expect(VlmServerState.parse(s)).toMatchObject({ url: 'http://127.0.0.1:40000', apiKey: KEY });
    expect(h.states.at(-1)).toEqual(s);
    expect(h.spawned).toEqual([]);
  });
});
