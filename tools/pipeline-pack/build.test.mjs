import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildError, defaultOutRoot, staleTempDirs, withTempDir } from './build.mjs';

let out;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'pack-build-'));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

const quiet = { log: () => undefined };

describe('pipeline pack temp folder', () => {
  it('is removed when a build step fails', async () => {
    let seen = '';
    await expect(
      withTempDir(
        out,
        '0.2.0',
        (tmp) => {
          seen = tmp;
          writeFileSync(join(tmp, 'half-extracted.bin'), 'x');
          throw new BuildError('tar -xzf failed (exit 2)');
        },
        { pid: 4242, ...quiet },
      ),
    ).rejects.toThrow('tar -xzf failed');
    expect(seen).toContain('.pipeline-pack-0.2.0.tmp-4242');
    expect(existsSync(seen)).toBe(false);
    expect(readdirSync(out)).toEqual([]);
  });

  it('is removed after an async failure too', async () => {
    await expect(
      withTempDir(
        out,
        '0.2.0',
        async () => {
          await Promise.resolve();
          throw new Error('uv pip install failed');
        },
        { pid: 7, ...quiet },
      ),
    ).rejects.toThrow('uv pip install failed');
    expect(readdirSync(out)).toEqual([]);
  });

  it('returns the build result and leaves only what the build moved into place', async () => {
    const r = await withTempDir(
      out,
      '0.2.0',
      (tmp) => {
        mkdirSync(join(out, 'pipeline-pack-0.2.0'));
        writeFileSync(join(tmp, 'scratch'), 'x');
        return 'done';
      },
      { pid: 9, ...quiet },
    );
    expect(r).toBe('done');
    expect(readdirSync(out)).toEqual(['pipeline-pack-0.2.0']);
  });

  it('sweeps temp folders of builds that are no longer running, keeps live ones', async () => {
    for (const n of [
      '.pipeline-pack-0.1.0.tmp-111',
      '.pipeline-pack-0.2.0.tmp-222',
      'pipeline-pack-0.1.0',
      '.cache',
    ])
      mkdirSync(join(out, n));
    const logged = [];
    await withTempDir(out, '0.2.0', () => undefined, {
      pid: 333,
      alive: (pid) => pid === 222,
      log: (m) => logged.push(m),
    });
    expect(readdirSync(out).sort()).toEqual([
      '.cache',
      '.pipeline-pack-0.2.0.tmp-222',
      'pipeline-pack-0.1.0',
    ]);
    expect(logged.join('\n')).toContain('.pipeline-pack-0.1.0.tmp-111');
  });

  it('only treats its own temp folder names as stale', () => {
    expect(
      staleTempDirs(
        [
          '.pipeline-pack-0.2.0.tmp-5',
          'pipeline-pack-0.2.0',
          '.pipeline-pack-x.tmp-',
          'other.tmp-5',
        ],
        () => false,
      ),
    ).toEqual(['.pipeline-pack-0.2.0.tmp-5']);
  });
});

describe('defaultOutRoot', () => {
  it('uses QUADRION_DATA on every system', () => {
    expect(defaultOutRoot('darwin', { QUADRION_DATA: '/Volumes/Data' })).toBe(
      join('/Volumes/Data', 'runtime'),
    );
  });

  it('has a default only on the Windows workstation', () => {
    expect(defaultOutRoot('win32', {})).toBe('E:/Stratlas Data/runtime');
    expect(defaultOutRoot('darwin', {})).toBeNull();
  });
});
