import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcceleratorProbe,
  findAddon,
  parseSelfTest,
  photoAddonEnv,
  photoGpuOff,
  selfTestAddon,
  type RunProgram,
} from './addon';
import type { PackInfo } from './pack';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-addon-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeAddon(version: string, over: Record<string, unknown> = {}) {
  const dir = join(root, 'runtime', `pipeline-addon-cuda-${version}`);
  await mkdir(join(dir, 'site'), { recursive: true });
  const manifest = {
    schema: 'aio.pipeline-addon/1',
    kind: 'gpu-cuda',
    version,
    packRange: '>=0.5.0 <0.7.0',
    python: '3.13',
    platform: 'win32-x64',
    runtime: { cuda: '12.9', minDriver: '528.33' },
    createdAt: '2026-10-11T10:00:00Z',
    files: {},
    ...over,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

const find = (version: string, env: Record<string, string | undefined> = {}) =>
  findAddon({ dataRoot: root, env, pack: { version }, platform: 'win32-x64' });

describe('findAddon', () => {
  it('finds nothing where nothing is installed, and says nothing about it', async () => {
    expect(await find('0.5.4')).toEqual({ addon: null });
    await mkdir(join(root, 'runtime', 'pipeline-pack-0.5.4'), { recursive: true });
    await mkdir(join(root, 'runtime', 'pipeline-addon-cuda-9.9.9'), { recursive: true }); // no manifest
    expect(await find('0.5.4')).toEqual({ addon: null });
  });

  it('takes the newest add-on that fits the processing tools in use', async () => {
    await writeAddon('0.1.0');
    const newest = await writeAddon('0.10.0');
    await writeAddon('0.9.0');
    await writeAddon('1.0.0', { packRange: '>=0.6.0 <0.7.0' });
    const r = await find('0.5.4');
    expect(r.addon?.dir).toBe(newest);
    expect(r.addon?.version).toBe('0.10.0');
    expect(r.problem).toBeUndefined();
  });

  it('says in words why an add-on that is there cannot be used', async () => {
    await writeAddon('0.1.0');
    expect(await find('0.7.1')).toEqual({
      addon: null,
      problem:
        'GPU add-on 0.1.0 fits processing tools >=0.5.0 <0.7.0; these are 0.7.1. Install the add-on made for this version.',
    });
    expect(
      await findAddon({
        dataRoot: root,
        env: {},
        pack: { version: '0.5.4' },
        platform: 'darwin-arm64',
      }),
    ).toEqual({
      addon: null,
      problem: 'GPU add-on 0.1.0 is for win32-x64, not this computer (darwin-arm64).',
    });
  });

  it('does not take a pipeline pack, another kind of add-on or a damaged manifest for one', async () => {
    await writeAddon('0.1.0', { kind: 'gpu-metal' });
    await writeAddon('0.2.0', { schema: 'aio.pipeline-pack/1' });
    const broken = join(root, 'runtime', 'pipeline-addon-cuda-0.3.0');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'manifest.json'), '{not json');
    expect(await find('0.5.4')).toEqual({ addon: null });
  });

  it('a development interpreter is not held to the pack range, and one folder can be named', async () => {
    const dir = await writeAddon('0.1.0');
    expect((await find('dev')).addon?.version).toBe('0.1.0');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    expect(await find('0.5.4', { QUADRION_PIPELINE_ADDON: elsewhere })).toEqual({
      addon: null,
      problem: `${elsewhere} is not a GPU add-on folder.`,
    });
    expect((await find('0.5.4', { QUADRION_PIPELINE_ADDON: dir })).addon?.dir).toBe(dir);
  });
});

describe('the self-test answer', () => {
  it('reads the state and what is known of the card', () => {
    const line = JSON.stringify({
      state: 'ready',
      version: '0.1.0',
      cuda: '12.9',
      gpu: 'NVIDIA GeForce RTX 5070 Ti',
      driver: '591.86',
      capability: '12.0',
      vramBytes: 17094475776,
      freeBytes: 15738077184,
      cupy: '14.2.0',
      seconds: 1.39,
    });
    expect(parseSelfTest(`a warning from a library\n${line}\n`)).toEqual({
      state: 'ready',
      version: '0.1.0',
      gpu: 'NVIDIA GeForce RTX 5070 Ti',
      driver: '591.86',
      vramBytes: 17094475776,
      freeBytes: 15738077184,
    });
  });

  it('keeps the reason in words, and takes anything it cannot read for a failed test', () => {
    expect(
      parseSelfTest(
        '{"state": "driver-too-old", "reason": "The GPU add-on needs graphics driver 528.33 or later (found 512.15)."}',
      ),
    ).toEqual({
      state: 'driver-too-old',
      reason: 'The GPU add-on needs graphics driver 528.33 or later (found 512.15).',
    });
    const failed = { state: 'failed', reason: 'The graphics card test gave no answer.' };
    expect(parseSelfTest('')).toEqual(failed);
    expect(parseSelfTest('Traceback (most recent call last):')).toEqual(failed);
    expect(parseSelfTest('{"state": "splendid"}')).toEqual(failed);
  });
});

const PACK: PackInfo = {
  dir: 'C:/runtime/pipeline-pack-0.5.4',
  version: '0.5.4',
  python: 'C:/runtime/pipeline-pack-0.5.4/python/python.exe',
};

describe('selfTestAddon', () => {
  it('asks the pack, isolated and with a time limit, and adds the add-on version', async () => {
    const dir = await writeAddon('0.1.0');
    const run = vi.fn<RunProgram>(() => Promise.resolve('{"state": "ready", "gpu": "Test Card"}'));
    const r = await selfTestAddon({
      pack: PACK,
      addon: { dir, version: '0.1.0', manifest: {} as never },
      cacheDir: 'C:/user/gpu-kernels',
      env: { PATH: 'x', PYTHONPATH: 'leak', QUADRION_PHOTO_GPU: '1' },
      run,
    });
    expect(r).toEqual({ state: 'ready', version: '0.1.0', gpu: 'Test Card' });
    const [file, args, options] = run.mock.calls[0] ?? [];
    expect(file).toBe(PACK.python);
    expect(args).toEqual([
      '-I',
      '-u',
      '-X',
      'utf8',
      '-m',
      'aio_pipelines.accel',
      '--selftest',
      '--addon',
      dir,
    ]);
    expect(options?.env.AIO_PHOTO_GPU_CACHE).toBe('C:/user/gpu-kernels');
    expect(options?.env.PYTHONPATH).toBeUndefined();
    expect(options?.timeoutMs).toBe(120_000);
    expect(options?.cwd).toBe(PACK.dir);
  });

  it('is off without starting anything, and a test that cannot run is a failure in words', async () => {
    const addon = { dir: 'x', version: '0.1.0', manifest: {} as never };
    const run = vi.fn<RunProgram>(() =>
      Promise.reject(new Error('No module named aio_pipelines.accel')),
    );
    expect(await selfTestAddon({ pack: PACK, addon, cacheDir: 'c', off: true, run })).toEqual({
      state: 'off',
      version: '0.1.0',
      reason: 'The graphics card is switched off for photo processing.',
    });
    expect(run).not.toHaveBeenCalled();
    const r = await selfTestAddon({ pack: PACK, addon, cacheDir: 'c', run });
    expect(r.state).toBe('failed');
    expect(r.reason).toContain('The graphics card test could not run.');
  });
});

describe('AcceleratorProbe', () => {
  const probe = (o: {
    pack?: PackInfo | null;
    run: RunProgram;
    off?: () => boolean;
    now?: () => number;
  }) =>
    new AcceleratorProbe({
      findPack: () => Promise.resolve({ pack: o.pack === undefined ? PACK : o.pack }),
      dataRoot: () => root,
      cacheDir: () => join(root, 'kernels'),
      env: () => ({}),
      off: o.off ?? (() => false),
      run: o.run,
      platform: 'win32-x64',
      ...(o.now ? { now: o.now } : {}),
    });

  it('is not installed without an add-on or without processing tools, and starts nothing', async () => {
    const run = vi.fn<RunProgram>(() => Promise.resolve('{"state": "ready"}'));
    expect(await probe({ run }).state()).toEqual({ state: 'not-installed' });
    await writeAddon('0.1.0');
    expect(await probe({ run, pack: null }).state()).toEqual({ state: 'not-installed' });
    expect(run).not.toHaveBeenCalled();
  });

  it('an add-on that does not fit is a failure with the reason, without a test', async () => {
    await writeAddon('0.1.0', { packRange: '>=0.7.0 <0.8.0' });
    const run = vi.fn<RunProgram>(() => Promise.resolve('{"state": "ready"}'));
    const r = await probe({ run }).state();
    expect(r.state).toBe('failed');
    expect(r.reason).toContain('fits processing tools >=0.7.0 <0.8.0; these are 0.5.4');
    expect(run).not.toHaveBeenCalled();
  });

  it('tests the card once and keeps the answer for ten minutes, per add-on', async () => {
    await writeAddon('0.1.0');
    let t = 0;
    const run = vi.fn<RunProgram>(() => Promise.resolve('{"state": "ready", "gpu": "Test Card"}'));
    const p = probe({ run, now: () => t });
    expect((await p.state()).state).toBe('ready');
    t = 9 * 60_000;
    await p.state();
    expect(run).toHaveBeenCalledTimes(1);
    t = 11 * 60_000;
    await p.state();
    expect(run).toHaveBeenCalledTimes(2);
    await writeAddon('0.2.0'); // a newer add-on is another question
    expect((await p.state()).version).toBe('0.2.0');
    expect(run).toHaveBeenCalledTimes(3);
    p.reset();
    await p.state();
    expect(run).toHaveBeenCalledTimes(4);
  });
});

// Only on a workstation with an NVIDIA card: QUADRION_TEST_ADDON names a built GPU add-on and
// QUADRION_TEST_PYTHON a Python that has aio_pipelines (a pipeline pack's, or the uv venv's).
const liveAddon = process.env.QUADRION_TEST_ADDON;
const livePython = process.env.QUADRION_TEST_PYTHON;
describe.skipIf(!liveAddon || !livePython)('the real add-on on this card', () => {
  it('is found, fits a development interpreter and passes its test', async () => {
    const found = await findAddon({
      dataRoot: root,
      env: { QUADRION_PIPELINE_ADDON: liveAddon },
      pack: { version: 'dev' },
    });
    if (!found.addon) throw new Error(found.problem ?? 'no add-on');
    const r = await selfTestAddon({
      pack: { dir: root, version: 'dev', python: livePython ?? '' },
      addon: found.addon,
      cacheDir: join(root, 'kernels'),
    });
    expect(r).toMatchObject({ state: 'ready', version: found.addon.version });
    expect(r.vramBytes).toBeGreaterThan(0);
  }, 180_000);
});

describe('the photo jobs environment', () => {
  const addon = {
    dir: 'D:/data/runtime/pipeline-addon-cuda-0.1.0',
    version: '0.1.0',
    manifest: {} as never,
  };

  it('names the add-on and the kernel cache to the photo jobs that can use the card', () => {
    expect(photoAddonEnv('photo.products', addon, 'C:/user/gpu-kernels', false)).toEqual({
      AIO_PHOTO_ADDON: addon.dir,
      AIO_PHOTO_GPU_CACHE: 'C:/user/gpu-kernels',
    });
    expect(photoAddonEnv('photo.align', addon, 'c', true)).toEqual({
      AIO_PHOTO_ADDON: addon.dir,
      AIO_PHOTO_GPU_CACHE: 'c',
      AIO_PHOTO_GPU: '0',
    });
  });

  it('adds nothing without an add-on or for other jobs', () => {
    expect(photoAddonEnv('photo.products', null, 'c', false)).toEqual({});
    expect(photoAddonEnv('photo.georef', addon, 'c', false)).toEqual({});
    expect(photoAddonEnv('system.selftest', addon, 'c', false)).toEqual({});
  });

  it('the card is switched off by QUADRION_PHOTO_GPU=0 only', () => {
    expect(photoGpuOff({ QUADRION_PHOTO_GPU: '0' })).toBe(true);
    expect(photoGpuOff({ QUADRION_PHOTO_GPU: '1' })).toBe(false);
    expect(photoGpuOff({})).toBe(false);
  });
});
