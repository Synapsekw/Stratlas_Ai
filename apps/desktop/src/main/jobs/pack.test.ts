import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareVersions, findPack } from './pack';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-pack-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePack(version: string, opts: { python?: boolean; manifest?: unknown } = {}) {
  const dir = join(root, 'runtime', `pipeline-pack-${version}`);
  await mkdir(join(dir, 'python'), { recursive: true });
  if (opts.python !== false) await writeFile(join(dir, 'python', 'python.exe'), '');
  const manifest = opts.manifest ?? {
    schema: 'aio.pipeline-pack/1',
    version,
    protocol: 'aio.pipelines/1',
    python: { version: '3.13.7', build: '20260924', executable: 'python/python.exe' },
    platform: 'win32-x64',
    createdAt: '2026-10-04T10:00:00Z',
    pipelines: [],
    files: {},
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('findPack', () => {
  it('refuses a pack whose app range leaves this app out, and uses one that fits', async () => {
    const base = {
      schema: 'aio.pipeline-pack/1',
      protocol: 'aio.pipelines/1',
      python: { version: '3.13.7', build: '20260924', executable: 'python/python.exe' },
      platform: 'win32-x64',
      createdAt: '2026-10-04T10:00:00Z',
      pipelines: [],
      files: {},
    };
    await writePack('2.0.0', {
      manifest: { ...base, version: '2.0.0', appRange: '>=2.0.0 <3.0.0' },
    });
    const app = { version: '0.9.0', name: 'Stratlas' };
    const refused = await findPack({ dataRoot: root, env: {}, app });
    expect(refused.pack).toBeNull();
    expect(refused.runtime.problem).toContain('works with Stratlas >=2.0.0 <3.0.0');
    const fits = await writePack('1.0.0', {
      manifest: { ...base, version: '1.0.0', appRange: '>=0.9.0 <2.0.0' },
    });
    const r = await findPack({ dataRoot: root, env: {}, app });
    expect(r.runtime).toEqual({ found: true, version: '1.0.0', dir: fits });
  });

  it('says where it looked when there is no pack', async () => {
    const r = await findPack({ dataRoot: root, env: {} });
    expect(r.pack).toBeNull();
    expect(r.runtime.found).toBe(false);
    expect(r.runtime.problem).toContain(join(root, 'runtime'));
  });

  it('picks the newest valid pack and reports its version', async () => {
    await writePack('0.1.0');
    const newest = await writePack('0.10.0');
    await writePack('0.9.0');
    await writePack('9.9.9', { python: false }); // broken: no interpreter
    await writePack('8.0.0', { manifest: { schema: 'nope' } }); // broken: bad manifest
    const r = await findPack({ dataRoot: root, env: {} });
    expect(r.runtime).toEqual({ found: true, version: '0.10.0', dir: newest });
    expect(r.pack?.python).toBe(join(newest, 'python', 'python.exe'));
  });

  it('honours a development interpreter from the environment', async () => {
    const py = join(root, 'venv', 'python.exe');
    await mkdir(join(root, 'venv'), { recursive: true });
    await writeFile(py, '');
    const r = await findPack({ dataRoot: root, env: { QUADRION_PIPELINE_PYTHON: py } });
    expect(r.runtime).toMatchObject({ found: true, version: 'dev' });
    expect(r.pack?.python).toBe(py);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
  });
});
