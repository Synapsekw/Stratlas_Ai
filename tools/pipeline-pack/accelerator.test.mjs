import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AddonBuildError,
  addonName,
  archiveAddon,
  archiveName,
  buildAddon,
  fetchWheels,
  lockProblems,
  readLock,
  trimmed,
} from './accelerator.mjs';
import { packageVersion, tarCommand } from './build.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A zip with stored (uncompressed) entries: enough of the format for a wheel. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, n, data);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBytes, end]);
}

/** A lock of small made-up wheels and a fetch that serves them (counting the calls). */
function fake(wheels) {
  const bodies = {};
  const list = Object.entries(wheels).map(([name, entries]) => {
    const body = zip(entries);
    const url = `https://files.pythonhosted.org/packages/aa/${name}-1.0-py3-none-any.whl`;
    bodies[url] = body;
    return { name, version: '1.0', license: 'MIT', url, sha256: sha(body), size: body.length };
  });
  const lock = {
    schema: 'accelerator-lock/1',
    kind: 'gpu-cuda',
    version: '9.9.9',
    packRange: '>=0.5.0 <0.7.0',
    python: '3.13',
    runtime: { cuda: '12.9', minDriver: '528.33' },
    platforms: { 'win32-x64': list },
  };
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url);
    const body = bodies[url];
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      arrayBuffer: () =>
        Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.length)),
    });
  };
  return { lock, calls, fetchImpl, bodies };
}

// bsdtar (Windows' own tar, macOS) reads zip; GNU tar does not, and the add-on is built on Windows
const tar = tarCommand();
const readsZip = /bsdtar/i.test(
  spawnSync(tar.cmd, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout ?? '',
);

describe('the GPU add-on build', () => {
  const dirs = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'aio-addon-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('the committed lock is complete and fits the pack this repository builds', () => {
    const lock = readLock();
    expect(lockProblems(lock)).toEqual([]);
    const names = lock.platforms['win32-x64'].map((w) => w.name);
    expect(names).toEqual([
      'cupy-cuda12x',
      'cuda-pathfinder',
      'nvidia-cuda-runtime-cu12',
      'nvidia-cuda-nvrtc-cu12',
      'nvidia-cublas-cu12',
    ]);
    // the pack's version is inside the range the add-on claims
    const pack = packageVersion(
      readFileSync(join(import.meta.dirname, '..', '..', 'python', 'pyproject.toml'), 'utf8'),
    );
    const [, lo, hi] = /^>=(\S+) <(\S+)$/.exec(lock.packRange) ?? [];
    const num = (v) => v.split('.').map(Number);
    const cmp = (a, b) => num(a).reduce((r, x, i) => r || x - (num(b)[i] ?? 0), 0);
    expect(cmp(pack, lo)).toBeGreaterThanOrEqual(0);
    expect(cmp(pack, hi)).toBeLessThan(0);
    expect(addonName(lock)).toBe(`pipeline-addon-cuda-${lock.version}`);
    expect(archiveName(lock, 'win32-x64')).toBe(
      `pipeline-addon-cuda-${lock.version}-win-x64.tar.gz`,
    );
  });

  it('a lock with a wheel from elsewhere, a bad hash or a missing licence is refused in words', () => {
    const { lock } = fake({ a: { 'a/__init__.py': '' } });
    const w = lock.platforms['win32-x64'][0];
    expect(
      lockProblems({
        ...lock,
        platforms: { 'win32-x64': [{ ...w, url: 'https://example.test/a.whl' }] },
      }),
    ).toEqual(['win32-x64 a: not a wheel on files.pythonhosted.org']);
    expect(
      lockProblems({ ...lock, platforms: { 'win32-x64': [{ ...w, sha256: 'abc' }] } }),
    ).toEqual(['win32-x64 a: sha256']);
    expect(lockProblems({ ...lock, platforms: { 'win32-x64': [{ ...w, license: '' }] } })).toEqual([
      'win32-x64 a: name, version or license',
    ]);
    expect(lockProblems({ ...lock, schema: 'aio.something/1' })).toContain(
      'schema is not accelerator-lock/1',
    );
  });

  it('wheels are downloaded once, checked against their pins and kept in the cache', async () => {
    const { lock, calls, fetchImpl } = fake({ a: { 'a/__init__.py': 'A = 1\n' } });
    const cache = tmp();
    const first = await fetchWheels({ lock, platform: 'win32-x64', cache, fetchImpl });
    const again = await fetchWheels({ lock, platform: 'win32-x64', cache, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(again[0].file).toBe(first[0].file);
    expect(sha(readFileSync(first[0].file))).toBe(lock.platforms['win32-x64'][0].sha256);
  });

  it('a wheel that does not match its pin is refused and not kept', async () => {
    const { lock, fetchImpl } = fake({ a: { 'a/__init__.py': 'A = 1\n' } });
    lock.platforms['win32-x64'][0].sha256 = 'f'.repeat(64);
    const cache = tmp();
    await expect(fetchWheels({ lock, platform: 'win32-x64', cache, fetchImpl })).rejects.toThrow(
      /has SHA-256 [a-f0-9]{64}, expected f{64}/,
    );
    expect(readdirSync(join(cache, 'accelerator'))).toEqual([]);
  });

  it('a platform the lock does not cover is refused', async () => {
    const { lock, fetchImpl } = fake({ a: { 'a/__init__.py': '' } });
    await expect(
      fetchWheels({ lock, platform: 'darwin-arm64', cache: tmp(), fetchImpl }),
    ).rejects.toThrow('the add-on lock has no wheels for darwin-arm64');
  });

  it('import libraries and debug symbols are left out', () => {
    expect(trimmed('site/nvidia/cublas/lib/x64/cublas.lib')).toBe(true);
    expect(trimmed('site/cupy/_core/core.pdb')).toBe(true);
    expect(trimmed('site/nvidia/cublas/bin/cublas64_12.dll')).toBe(false);
    expect(trimmed('site/nvidia/cuda_runtime/include/cuda.h')).toBe(false);
  });

  it.skipIf(!readsZip)(
    'the add-on is the unpacked wheels and a manifest of every file, and its archive opens with the manifest',
    async () => {
      const { lock, fetchImpl } = fake({
        'cupy-fake': { 'cupy/__init__.py': 'X = 1\n', 'cupy/_core/core.lib': 'lib' },
        'nvidia-fake': { 'nvidia/cublas/bin/cublas64_12.dll': 'dll bytes' },
      });
      const outRoot = tmp();
      const built = await buildAddon({
        outRoot,
        cache: tmp(),
        lock,
        platform: 'win32-x64',
        fetchImpl,
        now: new Date('2026-10-11T00:00:00Z'),
      });
      expect(built.dir).toBe(join(outRoot, 'pipeline-addon-cuda-9.9.9'));
      const manifest = JSON.parse(readFileSync(join(built.dir, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({
        schema: 'aio.pipeline-addon/1',
        kind: 'gpu-cuda',
        version: '9.9.9',
        packRange: '>=0.5.0 <0.7.0',
        python: '3.13',
        platform: 'win32-x64',
        runtime: { cuda: '12.9', minDriver: '528.33' },
        createdAt: '2026-10-11T00:00:00.000Z',
      });
      expect(manifest.packages.map((p) => p.name)).toEqual(['cupy-fake', 'nvidia-fake']);
      expect(Object.keys(manifest.files)).toEqual([
        'site/cupy/__init__.py',
        'site/nvidia/cublas/bin/cublas64_12.dll',
      ]);
      expect(manifest.files['site/cupy/__init__.py']).toEqual({
        size: 6,
        sha256: sha(Buffer.from('X = 1\n')),
      });
      expect(existsSync(join(built.dir, 'site', 'cupy', '_core', 'core.lib'))).toBe(false);
      // nothing is left behind, and a second build needs --force
      expect(readdirSync(outRoot)).toEqual(['pipeline-addon-cuda-9.9.9']);
      await expect(
        buildAddon({ outRoot, cache: tmp(), lock, platform: 'win32-x64', fetchImpl }),
      ).rejects.toThrow(AddonBuildError);
      const archive = join(tmp(), archiveName(lock, 'win32-x64'));
      expect(archiveAddon(built.dir, archive)).toBeGreaterThan(0);
      const listed = spawnSync(tar.cmd, [...tar.args, '-tzf', archive], { encoding: 'utf8' });
      expect(listed.stdout.split(/\r?\n/)[0]).toBe('pipeline-addon-cuda-9.9.9/manifest.json');
    },
  );
});
