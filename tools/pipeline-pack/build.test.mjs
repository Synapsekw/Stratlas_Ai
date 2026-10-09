import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BuildError,
  defaultOutRoot,
  photogrammetryProblem,
  staleTempDirs,
  tarCommand,
  withTempDir,
} from './build.mjs';

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

describe('pipeline pack tar', () => {
  const never = () => {
    throw new Error('tar --version must not run');
  };

  it("uses Windows' own bsdtar, not the GNU tar of Git Bash", () => {
    const seen = [];
    const exists = (p) => {
      seen.push(p);
      return true;
    };
    expect(tarCommand('win32', { SystemRoot: 'C:\\Windows' }, exists, never)).toEqual({
      cmd: 'C:\\Windows\\System32\\tar.exe',
      args: [],
    });
    expect(seen).toEqual(['C:\\Windows\\System32\\tar.exe']);
  });

  it('keeps a GNU tar from reading D:\\ as a remote host when there is no system tar', () => {
    const gnu = () => 'tar (GNU tar) 1.35\n';
    expect(tarCommand('win32', { SystemRoot: 'D:\\Win' }, () => false, gnu)).toEqual({
      cmd: 'tar',
      args: ['--force-local'],
    });
    const bsd = () => 'bsdtar 3.7.7 - libarchive 3.7.7';
    expect(tarCommand('win32', {}, () => false, bsd)).toEqual({ cmd: 'tar', args: [] });
  });

  it("uses the PATH's tar on macOS", () => {
    expect(tarCommand('darwin', {}, never, never)).toEqual({ cmd: 'tar', args: [] });
  });
});

describe('pipeline pack photogrammetry smoke test', () => {
  const full = {
    pycolmap: '4.0.1',
    colmapBuild: 'Commit abc without CUDA',
    opencv: '4.12.0',
    pymeshlab: '2025.7',
    poissonFaces: 2000,
    pymeshlabInParent: false,
  };

  it('passes a pack whose engines each run in their own process', () => {
    expect(photogrammetryProblem(full)).toBeNull();
    expect(photogrammetryProblem({})).toBeNull(); // the Intel Mac pack has none (decision 8)
  });

  it("fails a pack whose MeshLab child crashed, with the child's output", () => {
    const problem = photogrammetryProblem({
      ...full,
      poissonFaces: undefined,
      meshlabExit: -6,
      meshlabOutput: 'OMP: Error #15: Initializing libomp.dylib',
    });
    expect(problem).toMatch(/screened Poisson failed/);
    expect(problem).toMatch(/OMP: Error #15/);
  });

  it('fails a pack with missing wheels or MeshLab in the probing process', () => {
    expect(photogrammetryProblem({ ...full, opencv: undefined })).toMatch(/incomplete/);
    expect(photogrammetryProblem({ ...full, pymeshlabInParent: true })).toMatch(
      /outside its child/,
    );
  });
});
