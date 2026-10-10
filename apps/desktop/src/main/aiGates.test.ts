/**
 * The cloud AI gates as the app wires them: the real settings store, the real providers and the
 * agent runtime, against a `fetch` that records every request (no network).
 */
import {
  builtInProviders,
  createAgentRuntime,
  createProviderRegistry,
  MESSAGES,
} from '@aio/ai/main';
import type { IpcEvent, IpcRequest } from '@aio/schema';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiGates } from './aiGates';
import { registerLocalModelsIpc } from './localModels';
import { collectHandlers } from './notYet';
import { createSettingsStore, defaultSettings, type SettingsStore } from './settings';

type AiEvent = IpcEvent<'ai:event'>;

const send = (runId: string): IpcRequest<'ai:send'> => ({
  runId,
  window: 'scene3d',
  context: { selection: null },
  messages: [{ role: 'user', content: 'How many issues are open?' }],
});

describe('cloud AI gates on the settings store', () => {
  let dir = '';
  let file = '';
  let store: SettingsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-gates-'));
    file = join(dir, 'settings.json');
    store = createSettingsStore(file, defaultSettings(dir));
    await store.set({ cloudAi: true });
  });

  afterEach(async () => {
    await store.settled();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** The agent, the providers and the local model IPC on one pair of gates, as in index.ts. */
  function app(packageAllows = true) {
    const seen: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'fake: request recorded' } }), {
          status: 418,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const gates = aiGates(store, { cloudAllowed: (setting) => setting && packageAllows });
    const ends = new Map<string, () => void>();
    const runtime = createAgentRuntime(
      {
        getKey: () => Promise.resolve('sk-test-NOT-A-REAL-KEY-0123456789'),
        ...gates,
        routes: () => store.current().routes,
        localModel: () => store.current().localModel,
        emit: (e: AiEvent) => {
          if (e.type === 'done' || e.type === 'error') ends.get(e.runId)?.();
        },
      },
      {
        providers: createProviderRegistry(
          builtInProviders({ fetch, offlineOnly: gates.offlineOnly }),
        ),
        maxRetries: 0,
      },
    );
    /** Send and wait for the run to end; resolves with what `ai:send` answered. */
    const ask = async (runId: string) => {
      const ended = new Promise<void>((resolve) => ends.set(runId, resolve));
      const r = await runtime.send(send(runId));
      if (r.ok) await ended;
      return r;
    };
    const ipc = collectHandlers((handle) => {
      registerLocalModelsIpc({ handle, ...gates, fetch, getKey: () => Promise.resolve(null) });
    });
    return { gates, runtime, ask, ipc, seen };
  }

  it('refuses the call made straight after offline-only is turned on, before it is written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = app();
    expect(await t.ask('r1')).toEqual({ ok: true });
    expect(t.seen).toHaveLength(1);

    // asked for, not awaited: the file still says offline-only is off
    const writing = store.set({ offlineOnly: true });
    expect(t.gates.offlineOnly()).toBe(true);
    const sent = t.runtime.send(send('r2'));
    const tested = t.runtime.testConnection({ provider: 'anthropic' });
    const status = t.runtime.status({});
    expect(await sent).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(await tested).toEqual({ ok: false, message: MESSAGES.offlineOnly });
    expect(await status).toMatchObject({ ready: false, reason: 'offline-only' });
    expect(t.seen).toHaveLength(1);

    await writing;
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ offlineOnly: true });
    expect(await t.ask('r3')).toEqual({ ok: false, error: MESSAGES.offlineOnly });
    expect(t.seen).toHaveLength(1);

    // and the other way: turned off, the next message goes out
    void store.set({ offlineOnly: false });
    expect(await t.ask('r4')).toEqual({ ok: true });
    expect(t.seen).toHaveLength(2);
  });

  it('holds with cloud AI on and off, and whatever the open package allows', async () => {
    await store.set({ offlineOnly: true });
    for (const cloudAi of [true, false]) {
      await store.set({ cloudAi });
      for (const allows of [true, false]) {
        const t = app(allows);
        expect(await t.ask('r1')).toEqual({ ok: false, error: MESSAGES.offlineOnly });
        expect(await t.runtime.status({})).toMatchObject({ reason: 'offline-only' });
        expect(t.seen).toEqual([]);
      }
    }
  });

  it('leaves the cloud switch and the package policy as they were with offline-only off', async () => {
    expect(app().gates.cloudAllowed()).toBe(true);
    expect(app(false).gates.cloudAllowed()).toBe(false);
    await store.set({ cloudAi: false });
    expect(app().gates.cloudAllowed()).toBe(false);
    expect(await app().runtime.status({})).toMatchObject({ ready: false, reason: 'cloud-off' });
  });

  it('refuses a model server on another machine at once, and keeps one on this machine', async () => {
    const t = app();
    const remote = 'http://192.168.1.20:11434/v1';
    void store.set({ offlineOnly: true });
    const refusal = {
      ok: false,
      error:
        'http://192.168.1.20:11434 is on another machine, and this workstation is offline-only, so nothing is sent to it. Use a model server on this machine, or turn off Offline-only workstation in Settings, Privacy and cloud.',
    };
    expect(await t.ipc.call('ai:localModels', { baseUrl: remote })).toEqual(refusal);
    expect(await t.ipc.call('ai:localProbe', { model: 'm', baseUrl: remote })).toEqual(refusal);
    expect(t.seen).toEqual([]);
    await t.ipc.call('ai:localModels', { baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(t.seen.length).toBeGreaterThan(0);
    for (const url of t.seen) expect(url.startsWith('http://127.0.0.1:11434/')).toBe(true);
  });
});
