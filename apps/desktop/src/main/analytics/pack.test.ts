import type { IpcChannel } from '@aio/schema';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validated } from '../ipc';
import {
  FAKE_ANALYTICS_GGUF,
  FAKE_ANALYTICS_MMPROJ,
  FAKE_ANALYTICS_SERVER,
  fakeAnalyticsPackArchive,
  fakeAnalyticsPackFiles,
  type FakeAnalyticsPackOptions,
} from '../jobs/packArchive.fakes';
import { findAnalyticsPack } from './pack';
import { registerAnalyticsPackIpc, type AnalyticsPackIpcDeps } from './packIpc';
import { VLM_PACK_IN_USE } from './server';

const APP = { version: '0.11.0', name: 'Quadrion AI' };
const PLATFORM = 'win32-x64';

vi.setConfig({ testTimeout: 60_000 });

let root: string;
let dataRoot: string;
let runtime: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-analytics-pack-'));
  dataRoot = join(root, 'data');
  runtime = join(dataRoot, 'runtime');
  await mkdir(runtime, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** An Analytics pack folder as an install leaves it (in runtime unless `dir` is given). */
async function writeAnalyticsPack(
  version: string,
  o: FakeAnalyticsPackOptions & { dir?: string } = {},
): Promise<string> {
  const dir = o.dir ?? join(runtime, `analytics-pack-${version}`);
  for (const [name, data] of Object.entries(fakeAnalyticsPackFiles(version, o))) {
    await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...name.split('/')), data);
  }
  return dir;
}

describe('findAnalyticsPack', () => {
  it('findAnalyticsPack picks the newest valid and honours QUADRION_ANALYTICS_PACK', async () => {
    expect(await findAnalyticsPack({ dataRoot, env: {} })).toBeNull();
    await writeAnalyticsPack('0.1.0');
    const newest = await writeAnalyticsPack('0.2.0');
    await writeAnalyticsPack('0.3.0', { server: false }); // incomplete: skipped
    await mkdir(join(runtime, 'analytics-pack-0.9.0')); // no manifest: skipped
    await writeAnalyticsPack('0.10.0', {
      manifest: (m) => {
        (m.model as Record<string, unknown>).sha256 = 'none'; // a check build: skipped
      },
    });
    await mkdir(join(runtime, 'pipeline-pack-9.0.0')); // another kind
    const found = await findAnalyticsPack({ dataRoot, env: {} });
    expect(found).toMatchObject({
      version: '0.2.0',
      dir: newest,
      server: join(newest, ...FAKE_ANALYTICS_SERVER.split('/')),
      gguf: join(newest, ...FAKE_ANALYTICS_GGUF.split('/')),
      mmproj: join(newest, ...FAKE_ANALYTICS_MMPROJ.split('/')),
    });
    expect(found?.manifest.runtime.executable).toBe(FAKE_ANALYTICS_SERVER);

    const elsewhere = await writeAnalyticsPack('0.0.7', { dir: join(root, 'dev-pack') });
    expect(
      await findAnalyticsPack({ dataRoot, env: { QUADRION_ANALYTICS_PACK: elsewhere } }),
    ).toMatchObject({ version: '0.0.7', dir: elsewhere });
    // a folder named by the environment that is not a pack: none, never a fallback
    expect(
      await findAnalyticsPack({
        dataRoot,
        env: { QUADRION_ANALYTICS_PACK: join(root, 'nowhere') },
      }),
    ).toBeNull();
  });

  it('skips a pack whose model files are missing', async () => {
    const dir = await writeAnalyticsPack('0.1.0');
    await rm(join(dir, ...FAKE_ANALYTICS_MMPROJ.split('/')));
    expect(await findAnalyticsPack({ dataRoot, env: {} })).toBeNull();
  });
});

describe('Analytics pack IPC', () => {
  type Handlers = Partial<Record<IpcChannel, (raw: unknown) => Promise<unknown>>>;

  function setup(over: Partial<AnalyticsPackIpcDeps> = {}) {
    const handlers: Handlers = {};
    const trashed: string[] = [];
    const chosen: (string | null)[] = [];
    registerAnalyticsPackIpc({
      handle: (channel, handler) => {
        handlers[channel] = validated(channel, handler);
      },
      dataRoot: () => dataRoot,
      env: {},
      app: APP,
      platform: PLATFORM,
      features: [],
      places: () => [{ dir: join(root, 'downloads'), where: 'downloads' }],
      chooseFile: (startDir) => {
        chosen.push(startDir);
        return Promise.resolve(null);
      },
      trash: async (dir) => {
        trashed.push(dir);
        await rm(dir, { recursive: true });
      },
      emit: () => {
        throw new Error('the pipeline pack progress channel is not the Analytics pack one');
      },
      ...over,
    });
    const call = <T>(channel: IpcChannel, request: unknown = {}) => {
      const h = handlers[channel];
      if (!h) throw new Error(`no handler for ${channel}`);
      return h(request) as Promise<T>;
    };
    return { call, handlers, trashed, chosen };
  }

  it('registers the six channels and installs, offers and removes a pack', async () => {
    const { call, handlers, trashed, chosen } = setup();
    expect(Object.keys(handlers).sort()).toEqual([
      'analyticsPack:cancel',
      'analyticsPack:choose',
      'analyticsPack:find',
      'analyticsPack:install',
      'analyticsPack:remove',
      'analyticsPack:status',
    ]);
    expect(await call('analyticsPack:status')).toEqual({ installed: null, offer: null });

    const downloads = join(root, 'downloads');
    await mkdir(downloads);
    const path = join(downloads, 'analytics-pack-0.1.0-win-x64.tar.gz');
    await writeFile(path, fakeAnalyticsPackArchive('0.1.0'));
    expect(await call('analyticsPack:find')).toEqual({
      archives: [{ path, version: '0.1.0' }],
    });
    expect(await call('analyticsPack:status')).toEqual({
      installed: null,
      offer: { path, version: '0.1.0' },
    });
    expect(await call('analyticsPack:choose')).toEqual({ path: null });
    expect(chosen).toEqual([downloads]);

    expect(await call('analyticsPack:install', { path })).toEqual({ ok: true, version: '0.1.0' });
    const dir = join(runtime, 'analytics-pack-0.1.0');
    expect(await call('analyticsPack:status')).toEqual({
      installed: { version: '0.1.0', dir },
      offer: null,
    });
    expect(await call('analyticsPack:install', { path })).toMatchObject({
      ok: false,
      code: 'exists',
      version: '0.1.0',
    });
    expect(await call('analyticsPack:cancel')).toEqual({ ok: false });

    expect(await call('analyticsPack:remove', { version: '0.2.0' })).toEqual({
      ok: false,
      error: `There is no analytics-pack-0.2.0 in ${runtime}.`,
    });
    expect(await call('analyticsPack:remove', { version: '../x' })).toMatchObject({ ok: false });
    expect(await call('analyticsPack:remove', { version: '0.1.0' })).toEqual({ ok: true });
    expect(trashed).toEqual([dir]);
    expect(await readdir(runtime)).toEqual([]);
  });

  it('refuses under the real-data guard, for installing and for removing', async () => {
    await writeAnalyticsPack('0.1.0');
    const guard = vi.fn((p: string, op: string) => {
      throw Object.assign(new Error(`refused ${op} of ${p}`), {
        name: 'RealDataWriteRefusedError',
      });
    });
    const { call, trashed } = setup({ assertWritable: guard });
    const path = join(root, 'analytics-pack-0.2.0-win-x64.tar.gz');
    await writeFile(path, fakeAnalyticsPackArchive('0.2.0'));
    expect(await call('analyticsPack:install', { path })).toEqual({
      ok: false,
      error: `refused analytics pack install of ${runtime}`,
    });
    expect(await call('analyticsPack:remove', { version: '0.1.0' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('could not be moved to the bin') as string,
    });
    expect(trashed).toEqual([]);
  });

  it('refuses to remove or replace a pack while the model server runs from it', async () => {
    const dir = await writeAnalyticsPack('0.1.0');
    let serving: string | null = dir;
    const hold = vi.fn((d?: string) =>
      serving !== null && (d === undefined || d === serving) ? null : () => undefined,
    );
    const { call, trashed } = setup({ hold });
    expect(await call('analyticsPack:remove', { version: '0.1.0' })).toEqual({
      ok: false,
      error: VLM_PACK_IN_USE,
    });
    const path = join(root, 'analytics-pack-0.1.0-win-x64.tar.gz');
    await writeFile(path, fakeAnalyticsPackArchive('0.1.0'));
    expect(await call('analyticsPack:install', { path, replace: true })).toMatchObject({
      ok: false,
      error: VLM_PACK_IN_USE,
    });
    expect(await readdir(runtime)).toEqual(['analytics-pack-0.1.0']);
    expect(trashed).toEqual([]);

    serving = null;
    expect(await call('analyticsPack:install', { path, replace: true })).toEqual({
      ok: true,
      version: '0.1.0',
    });
    expect(await call('analyticsPack:remove', { version: '0.1.0' })).toEqual({ ok: true });
    expect(trashed).toEqual([dir]);
  });
});
