import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcChannel, OdmGpuSetting, OdmInstallProgress } from '@aio/schema';
import { validated } from '../ipc';
import type { OdmDeps } from './install';
import { registerOdmIpc } from './ipc';
import type { OdmSystem } from './system';

const SETUP = Buffer.from('fake setup bytes');
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-odm-ipc-'));
  // the stand-in Windows folder holds Microsoft's x64 C++ runtime, which the install checks for
  await mkdir(join(dir, 'nowin', 'System32'), { recursive: true });
  for (const f of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'])
    await writeFile(join(dir, 'nowin', 'System32', f), '');
  await writeFile(
    join(dir, 'pin.json'),
    JSON.stringify({
      version: '3.6.2',
      url: 'http://127.0.0.1:9/ODM_Setup_test.exe',
      size: SETUP.length,
      sha256: createHash('sha256').update(SETUP).digest('hex'),
      installedBytes: 1000,
      file: 'ODM_Setup_test.exe',
    }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fetch that answers only when told to, and fails when its signal aborts. */
function heldFetch() {
  const started = deferred<undefined>();
  const release = deferred<undefined>();
  const fetch: OdmDeps['fetch'] = async (_u, init) => {
    started.resolve(undefined);
    await new Promise<void>((ok, fail) => {
      init?.signal?.addEventListener('abort', () => {
        fail(new DOMException('aborted', 'AbortError'));
      });
      void release.promise.then(() => {
        ok();
      });
    });
    return new Response(SETUP);
  };
  return { fetch, started, release };
}

function system(over: Partial<OdmSystem> = {}): OdmSystem {
  return {
    runSetup: async (_file, args) => {
      const target = args.find((a) => a.startsWith('/DIR='))?.slice(5) ?? '';
      await mkdir(join(target, 'venv', 'Scripts'), { recursive: true });
      await writeFile(join(target, 'venv', 'Scripts', 'python.exe'), '');
      for (const f of ['run.bat', 'winrun.bat', 'win32env.bat', 'VERSION', 'unins000.exe'])
        await writeFile(join(target, f), '');
      return 0;
    },
    runSmoke: () => Promise.resolve({ code: 0, out: 'usage: run [options] <dataset name>' }),
    runUninstaller: () => Promise.resolve(0),
    regQuery: () => Promise.resolve(''),
    rename: () => Promise.resolve(),
    fileBytes: () => Promise.resolve(null),
    exists: (p) => Promise.resolve(existsSync(p)),
    rm: (p) => rm(p, { recursive: true, force: true }),
    freeBytes: () => Promise.resolve(10e12),
    sleep: () => Promise.resolve(),
    ...over,
  };
}

type Handlers = Partial<Record<IpcChannel, (raw: unknown) => Promise<unknown>>>;

function setup(over: Partial<OdmDeps> = {}) {
  const handlers: Handlers = {};
  const events: OdmInstallProgress[] = [];
  const gpuWrites: OdmGpuSetting[] = [];
  let gpu: OdmGpuSetting = 'auto';
  registerOdmIpc({
    // every request and answer goes through the frozen contract, as in the app
    handle: (channel, handler) => {
      handlers[channel] = validated(channel, handler);
    },
    emit: (p) => events.push(p),
    setGpu: (g) => {
      gpuWrites.push(g);
      gpu = g;
      return Promise.resolve();
    },
    dataRoot: () => join(dir, 'data'),
    env: {
      QUADRION_E2E: '1',
      QUADRION_ODM_PIN_FILE: join(dir, 'pin.json'),
      LOCALAPPDATA: join(dir, 'local'),
      SYSTEMROOT: join(dir, 'nowin'),
    },
    platform: 'win32',
    arch: 'x64',
    fetch: (u, init) => fetch(u, init),
    system: system(),
    gpus: () => Promise.resolve([]),
    gpuSetting: () => gpu,
    offlineOnly: () => false,
    now: () => new Date('2026-10-14T10:00:00Z'),
    ...over,
  });
  const call = <T>(channel: IpcChannel, request: unknown = {}) => {
    const h = handlers[channel];
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(request) as Promise<T>;
  };
  return { call, events, gpuWrites };
}

describe.skipIf(process.platform !== 'win32')('ODM IPC', () => {
  it('a second install while one runs is busy, and cancel during the download stops it', async () => {
    const f = heldFetch();
    const { call, events } = setup({ fetch: f.fetch });
    const first = call<{ ok: boolean; code?: string }>('odm:install', {});
    await f.started.promise;
    expect(await call('odm:status')).toMatchObject({ state: 'installing', installing: true });
    expect(await call('odm:install', { replaceOther: true })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    expect(await call('odm:remove')).toMatchObject({ ok: false, code: 'busy' });
    expect(await call('odm:cancel')).toEqual({ ok: true });
    expect(await first).toMatchObject({ ok: false, code: 'cancelled' });
    expect(events.at(-1)).toMatchObject({ phase: 'cancelled' });
    expect(await call('odm:status')).toMatchObject({ state: 'not-installed', installing: false });
  });

  it('cancel is refused once the setup runs', async () => {
    const setupStarted = deferred<undefined>();
    const finishSetup = deferred<undefined>();
    const base = system();
    const { call, events } = setup({
      fetch: () => Promise.resolve(new Response(SETUP)),
      system: system({
        runSetup: async (file, args) => {
          setupStarted.resolve(undefined);
          await finishSetup.promise;
          return base.runSetup(file, args);
        },
      }),
    });
    const first = call<{ ok: boolean }>('odm:install', {});
    await setupStarted.promise;
    expect(await call('odm:cancel')).toEqual({ ok: false });
    finishSetup.resolve(undefined);
    expect(await first).toMatchObject({ ok: true, status: { state: 'installed' } });
    expect(events.map((e) => e.phase)).toContain('done');
    expect(await call('odm:cancel')).toEqual({ ok: false });
  });

  it('cancel stops the start check: ODM stays installed, waiting for Try again', async () => {
    const checking = deferred<undefined>();
    const { call, events } = setup({
      fetch: () => Promise.resolve(new Response(SETUP)),
      system: system({
        runSmoke: (_dir, signal) => {
          checking.resolve(undefined);
          return new Promise((ok) => {
            signal?.addEventListener('abort', () => {
              ok({ code: 1, out: '' });
            });
          });
        },
      }),
    });
    const first = call<{ ok: boolean }>('odm:install', {});
    await checking.promise;
    expect(await call('odm:cancel')).toEqual({ ok: true });
    expect(await first).toMatchObject({ ok: false, code: 'cancelled' });
    expect(events.at(-1)).toMatchObject({ phase: 'cancelled' });
    expect(await call('odm:status')).toMatchObject({ state: 'unverified' });
  });

  it('setGpu writes the setting and answers the new status', async () => {
    const { call, gpuWrites } = setup();
    expect(await call('odm:setGpu', { gpu: 'off' })).toMatchObject({
      ok: true,
      status: { gpu: { setting: 'off' } },
    });
    expect(gpuWrites).toEqual(['off']);
  });
});
