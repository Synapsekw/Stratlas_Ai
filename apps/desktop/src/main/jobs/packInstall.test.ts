import { PIPELINES, type IpcChannel, type PackInstallProgress } from '@aio/schema';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validated } from '../ipc';
import { findPack } from './pack';
import {
  fakePackArchive,
  fakePackEntries,
  fakePackFiles,
  fakeTar,
  fakeTarGz,
  type FakePackOptions,
  type FakeTarEntry,
} from './packArchive.fakes';
import {
  archiveSegments,
  findPackArchives,
  installPackArchive,
  installProblem,
  linkStaysInside,
  listPacks,
  packArchiveName,
  packNeeds,
  packNoticeAllowed,
  packOffer,
  packStatus,
  packArchivePlaces,
  peekPackManifest,
  registerPipelinePackIpc,
  type InstallOptions,
  type PipelinePackIpcDeps,
} from './packInstall';

const APP = { version: '0.11.0', name: 'Quadrion AI' };
const PLATFORM = 'win32-x64';
const PHOTO = [{ label: 'Creating maps from photos', minVersion: '0.4.0' }];

// Each test unpacks several archives to disk; a busy machine or a virus scanner makes that slow.
vi.setConfig({ testTimeout: 60_000 });

/** `root/data` is the data folder, `root/in` holds archives; nothing may appear beside them. */
let root: string;
let dataRoot: string;
let runtime: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-pack-install-'));
  dataRoot = join(root, 'data');
  runtime = join(dataRoot, 'runtime');
  await mkdir(join(root, 'in'), { recursive: true });
  await writeFolderPack('0.2.0', { pipelines: ['system.selftest'] });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** An installed pack folder in runtime, as an earlier install or a hand copy left it. */
async function writeFolderPack(version: string, o: FakePackOptions = {}): Promise<string> {
  const dir = join(runtime, `pipeline-pack-${version}`);
  for (const [name, data] of Object.entries(fakePackFiles(version, o))) {
    await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...name.split('/')), data);
  }
  return dir;
}

async function archive(name: string, bytes: Buffer): Promise<string> {
  const path = join(root, 'in', name);
  await writeFile(path, bytes);
  return path;
}

/** Every file and folder under `dir`, with file sizes: what "unchanged" is compared on. */
async function tree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) out.push(`${rel}/`, ...(await tree(join(dir, e.name), `${rel}/`)));
    else out.push(`${rel} ${String((await readFile(join(dir, e.name))).length)}`);
  }
  return out;
}

const install = (path: string, o: Partial<InstallOptions> = {}) =>
  installPackArchive(path, { dataRoot, app: APP, platform: PLATFORM, ...o });

/** Install an archive of `entries` and expect a refusal that leaves everything as it was. */
async function refusedUnchanged(
  entries: readonly FakeTarEntry[],
  o: Partial<InstallOptions> = {},
): Promise<string> {
  const path = await archive('pipeline-pack-0.5.0-win-x64.tar.gz', fakeTarGz(entries));
  const before = await tree(root);
  const r = await install(path, o);
  expect(await tree(root)).toEqual(before);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
}

const canSymlink = async (): Promise<boolean> => {
  const probe = join(root, 'in', 'probe-link');
  try {
    await symlink('probe-target', probe);
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
};

describe('installPackArchive', () => {
  it('installs a good archive, reports progress, and findPack then picks it', async () => {
    const path = await archive(
      'pipeline-pack-0.5.0-win-x64.tar.gz',
      fakePackArchive('0.5.0', {
        appRange: '>=0.11.0 <2.0.0',
        files: { 'python/Lib/site.py': 'print("site")', 'models/sam/model.json': '{}' },
      }),
    );
    const progress: PackInstallProgress[] = [];
    const r = await install(path, { onProgress: (p) => progress.push(p), progressEveryMs: 0 });
    const dir = join(runtime, 'pipeline-pack-0.5.0');
    expect(r).toEqual({ ok: true, version: '0.5.0', dir, replaced: false });
    // no temporary folder is left, the older pack stays
    expect((await readdir(runtime)).sort()).toEqual(['pipeline-pack-0.2.0', 'pipeline-pack-0.5.0']);
    expect(await readFile(join(dir, 'python', 'Lib', 'site.py'), 'utf8')).toBe('print("site")');
    const found = await findPack({ dataRoot, env: {}, app: APP });
    expect(found.runtime).toEqual({ found: true, version: '0.5.0', dir });
    expect(found.pack?.python).toBe(join(dir, 'python', 'python.exe'));
    expect(progress.map((p) => p.phase)).toContain('unpack');
    expect(progress.at(-1)).toMatchObject({ phase: 'done', entries: 9 });
    expect(progress.at(-1)?.bytesDone).toBe(progress.at(-1)?.bytesTotal);
  });

  it('installs a plain tar and a pack with `./` before its folder', async () => {
    const entries = fakePackEntries('0.6.0').map((e) => ({ ...e, path: `./${e.path}` }));
    const r = await install(await archive('pack.tar', fakeTar(entries)));
    expect(r).toMatchObject({ ok: true, version: '0.6.0' });
  });

  it('refuses a path that climbs out with .. and writes nothing', async () => {
    const error = await refusedUnchanged([
      ...fakePackEntries('0.5.0'),
      { path: 'pipeline-pack-0.5.0/../../evil.txt', data: 'out' },
    ]);
    expect(error).toContain('climbs out of the pack');
    expect(existsSync(join(dataRoot, 'evil.txt'))).toBe(false);
    // a backslash is a separator too, on every system
    expect(
      await refusedUnchanged([
        ...fakePackEntries('0.5.0'),
        { path: 'pipeline-pack-0.5.0\\..\\..\\evil.txt', data: 'out' },
      ]),
    ).toContain('climbs out of the pack');
  });

  it('refuses absolute paths', async () => {
    for (const path of ['/tmp/evil.txt', 'C:/evil.txt', 'C:\\evil.txt', '//server/share/evil']) {
      const error = await refusedUnchanged([{ path, data: 'out' }, ...fakePackEntries('0.5.0')]);
      expect(error, path).toContain('an absolute path');
    }
  });

  it('refuses anything beside the one pack folder at the top', async () => {
    expect(await refusedUnchanged([{ path: 'README.txt', data: 'hello' }])).toContain(
      'not a pipeline pack: it starts with README.txt',
    );
    expect(
      await refusedUnchanged([
        ...fakePackEntries('0.5.0'),
        { path: 'pipeline-pack-0.6.0/extra.txt', data: 'x' },
      ]),
    ).toContain('a pipeline pack is one folder');
    expect(
      await refusedUnchanged([...fakePackEntries('0.5.0'), { path: 'autorun.inf', data: 'x' }]),
    ).toContain('a pipeline pack is one folder');
    // the folder name and the manifest must name the same version
    expect(
      await refusedUnchanged(fakePackEntries('0.5.0', { top: 'pipeline-pack-9.9.9' })),
    ).toContain('disagree');
  });

  it('refuses links that lead out of the pack, by name', async () => {
    for (const linkpath of ['../../outside', '/etc/passwd', 'C:\\Windows\\win.ini', 'a/../../..']) {
      const error = await refusedUnchanged([
        ...fakePackEntries('0.5.0'),
        { path: 'pipeline-pack-0.5.0/python/link', type: 'symlink', linkpath },
      ]);
      expect(error, linkpath).toContain('a link that leads out of the pack');
    }
    // a hard link to a file that is not in the pack, or out of it
    for (const linkpath of ['pipeline-pack-0.5.0/nothing-here', '../data/secret', '/etc/passwd']) {
      const error = await refusedUnchanged([
        ...fakePackEntries('0.5.0'),
        { path: 'pipeline-pack-0.5.0/python/hard', type: 'link', linkpath },
      ]);
      expect(error, linkpath).toContain('a link that leads out of the pack');
    }
  });

  it('never writes through a link, and refuses a link chain that ends outside', async () => {
    // "in" is the pack folder itself, so "up" (in/..) really is runtime, though its name stays inside
    const chain: FakeTarEntry[] = [
      ...fakePackEntries('0.5.0'),
      { path: 'pipeline-pack-0.5.0/in', type: 'symlink', linkpath: '.' },
      { path: 'pipeline-pack-0.5.0/up', type: 'symlink', linkpath: 'in/..' },
    ];
    const through = await refusedUnchanged([
      ...chain,
      { path: 'pipeline-pack-0.5.0/up/evil.txt', data: 'out' },
    ]);
    const ends = await refusedUnchanged(chain);
    expect(existsSync(join(runtime, 'evil.txt'))).toBe(false);
    if (await canSymlink()) {
      expect(through).toContain('which is a link or a file, not a folder');
      expect(ends).toContain('a link that does not lead to a file inside it');
    }
  });

  it('copies a hard link inside the pack, and keeps a link that stays inside', async () => {
    const withHard = [
      ...fakePackEntries('0.5.0', { files: { 'python/copy.exe': 'fake python of pack 0.5.0' } }),
    ].map((e): FakeTarEntry =>
      e.path.endsWith('copy.exe')
        ? { path: e.path, type: 'link', linkpath: 'pipeline-pack-0.5.0/python/python.exe' }
        : e,
    );
    const r = await install(await archive('hard.tar.gz', fakeTarGz(withHard)));
    expect(r).toMatchObject({ ok: true });
    expect(await readFile(join(runtime, 'pipeline-pack-0.5.0', 'python', 'copy.exe'), 'utf8')).toBe(
      'fake python of pack 0.5.0',
    );

    if (!(await canSymlink())) return;
    const withLink = [
      ...fakePackEntries('0.7.0'),
      { path: 'pipeline-pack-0.7.0/python/python3', type: 'symlink', linkpath: 'python.exe' },
    ] satisfies FakeTarEntry[];
    expect(await install(await archive('link.tar.gz', fakeTarGz(withLink)))).toMatchObject({
      ok: true,
      version: '0.7.0',
    });
  });

  it('installs a macOS pack: in-pack links and executable bits are kept', async () => {
    // as python-build-standalone lays a Mac out: bin/python3 is a link to the real interpreter
    const entries = fakePackEntries('1.2.0', {
      platform: 'darwin-arm64',
      executable: 'python/bin/python3',
      pythonFile: 'python/bin/python3.13',
      files: { 'python/lib/python3.13/os.py': 'import sys', 'tools/pdal/bin/pdal': 'fake pdal' },
    }).map((e): FakeTarEntry =>
      e.path.endsWith('python3.13') || e.path.endsWith('/pdal') ? { ...e, mode: 0o755 } : e,
    );
    const mac: FakeTarEntry[] = [
      ...entries,
      { path: 'pipeline-pack-1.2.0/python/bin/python3', type: 'symlink', linkpath: 'python3.13' },
      // a link to a folder, up and down inside the pack
      { path: 'pipeline-pack-1.2.0/tools/py', type: 'symlink', linkpath: '../python/lib' },
    ];
    const path = await archive('pipeline-pack-1.2.0-macos-arm64.tar.gz', fakeTarGz(mac));
    const before = await tree(root);
    const r = await install(path, { platform: 'darwin-arm64', win32: false });
    if (!(await canSymlink())) {
      // Windows without the right to make links: refused whole, nothing half-installed
      expect(r.ok).toBe(false);
      expect(await tree(root)).toEqual(before);
      return;
    }
    const dir = join(runtime, 'pipeline-pack-1.2.0');
    expect(r).toEqual({ ok: true, version: '1.2.0', dir, replaced: false });
    expect(await readlink(join(dir, 'python', 'bin', 'python3'))).toBe('python3.13');
    expect(await readFile(join(dir, 'python', 'bin', 'python3'), 'utf8')).toBe(
      'fake python of pack 1.2.0',
    );
    expect(await readFile(join(dir, 'tools', 'py', 'python3.13', 'os.py'), 'utf8')).toBe(
      'import sys',
    );
    // findPack runs the pack through the link, as the app does
    const found = await findPack({ dataRoot, env: {}, app: APP });
    expect(found.pack?.python).toBe(join(dir, 'python', 'bin', 'python3'));
    if (process.platform !== 'win32') {
      // Windows keeps no executable bit; everywhere else the interpreter and tools must run
      const mode = async (...p: string[]) => (await stat(join(dir, ...p))).mode & 0o777;
      expect((await mode('python', 'bin', 'python3.13')) & 0o111).toBe(0o111);
      expect((await mode('tools', 'pdal', 'bin', 'pdal')) & 0o100).toBe(0o100);
      expect((await mode('python', 'lib', 'python3.13', 'os.py')) & 0o111).toBe(0);
    }
  });

  it('tells the two kinds of Mac apart', async () => {
    const intel = fakePackEntries('0.5.0', { platform: 'darwin-x64' });
    expect(await refusedUnchanged(intel, { platform: 'darwin-arm64', win32: false })).toBe(
      'These processing tools are for an Intel Mac, and this computer is a Mac with Apple silicon. Pick the file made for this computer.',
    );
    const silicon = fakePackEntries('0.5.0', { platform: 'darwin-arm64' });
    expect(await refusedUnchanged(silicon, { platform: 'darwin-x64', win32: false })).toBe(
      'These processing tools are for a Mac with Apple silicon, and this computer is an Intel Mac. Pick the file made for this computer.',
    );
    expect(packArchiveName('pipeline-pack-0.5.0-macos-x64.tar.gz', 'darwin-arm64')).toBeNull();
    expect(packArchiveName('pipeline-pack-0.5.0-macos-arm64.tar.gz', 'darwin-x64')).toBeNull();
    expect(packArchiveName('pipeline-pack-0.5.0-macos-x64.tar.gz', 'darwin-x64')).toEqual({
      version: '0.5.0',
    });
  });

  it('refuses devices, pipes and names Windows cannot hold', async () => {
    expect(
      await refusedUnchanged([
        ...fakePackEntries('0.5.0'),
        { path: 'pipeline-pack-0.5.0/pipe', type: 'fifo' },
      ]),
    ).toContain('neither a file, a folder nor a link');
    for (const name of ['nul', 'file.txt:stream', 'trailing.']) {
      const error = await refusedUnchanged(
        [...fakePackEntries('0.5.0'), { path: `pipeline-pack-0.5.0/${name}`, data: 'x' }],
        { win32: true },
      );
      expect(error, name).toContain('a name Windows cannot hold');
    }
  });

  it('refuses a file listed twice instead of overwriting it', async () => {
    const error = await refusedUnchanged([
      ...fakePackEntries('0.5.0'),
      { path: 'pipeline-pack-0.5.0/python/python.exe', data: 'another python' },
    ]);
    expect(error).toBe('The archive holds the same file or link twice. It was not installed.');
  });

  it('holds archives to a number of entries and an unpacked size', async () => {
    expect(
      await refusedUnchanged(fakePackEntries('0.5.0'), { limits: { maxEntries: 3 } }),
    ).toContain('holds more than 3 entries');
    expect(
      await refusedUnchanged(
        fakePackEntries('0.5.0', { files: { 'big.bin': randomBytes(3 * 2 ** 20) } }),
        { limits: { maxBytes: 2 * 2 ** 20 } },
      ),
    ).toContain('unpacks to more than 2 MB');
  });

  it('refuses a pack for another platform', async () => {
    const error = await refusedUnchanged(fakePackEntries('0.5.0', { platform: 'darwin-arm64' }));
    expect(error).toBe(
      'These processing tools are for a Mac with Apple silicon, and this computer is Windows (x64). Pick the file made for this computer.',
    );
  });

  it('refuses a pack whose app range leaves this app out, in the words findPack uses', async () => {
    const error = await refusedUnchanged(fakePackEntries('0.5.0', { appRange: '>=2.0.0 <3.0.0' }));
    expect(error).toBe(
      'This pipeline pack works with Quadrion AI >=2.0.0 <3.0.0, and this is 0.11.0. Install the pipeline pack made for this version.',
    );
  });

  it('refuses a pack without its Python, without a manifest, or with a manifest it cannot read', async () => {
    expect(await refusedUnchanged(fakePackEntries('0.5.0', { python: false }))).toContain(
      'is incomplete',
    );
    expect(
      await refusedUnchanged(
        fakePackEntries('0.5.0').filter((e) => !e.path.endsWith('manifest.json')),
      ),
    ).toContain('it has no manifest.json');
    expect(
      await refusedUnchanged(
        fakePackEntries('0.5.0', {
          manifest: (m) => {
            m.schema = 'aio.something-else/1';
          },
        }),
      ),
    ).toContain('is not one this app can read');
    // the Python the manifest names must be inside the pack
    expect(
      await refusedUnchanged(
        fakePackEntries('0.5.0', {
          manifest: (m) => {
            m.python = { version: '3', build: 'x', executable: '../../python.exe' };
          },
        }),
      ),
    ).toContain('has no Python at');
  });

  it('checks every file against the checksums in the manifest', async () => {
    const damaged = fakePackEntries('0.5.0', { files: { 'python/Lib/os.py': 'import sys' } }).map(
      (e): FakeTarEntry => (e.path.endsWith('os.py') ? { ...e, data: 'import syz' } : e),
    );
    expect(await refusedUnchanged(damaged)).toBe(
      'This file is damaged: python/Lib/os.py does not match its checksum. Copy or download it again.',
    );
    const incomplete = fakePackEntries('0.5.0', {
      files: { 'python/Lib/os.py': 'import sys' },
    }).filter((e) => !e.path.endsWith('os.py'));
    expect(await refusedUnchanged(incomplete)).toBe(
      'This file is incomplete: python/Lib/os.py is missing. Copy or download it again.',
    );
  });

  it('refuses a truncated archive and something that is no archive', async () => {
    const whole = fakePackArchive('0.5.0', { files: { 'data.bin': randomBytes(200_000) } });
    for (const cut of [whole.length - 20, Math.floor(whole.length / 2), 600]) {
      const path = await archive('pipeline-pack-0.5.0-win-x64.tar.gz', whole.subarray(0, cut));
      const before = await tree(root);
      const r = await install(path);
      expect(await tree(root), `cut at ${String(cut)}`).toEqual(before);
      expect(r).toMatchObject({ ok: false });
      expect(r.ok ? '' : r.error, `cut at ${String(cut)}`).toMatch(
        /damaged or was cut short|is incomplete|is damaged/,
      );
    }
    // a plain tar cut inside a file
    const tar = fakeTar(fakePackEntries('0.5.0', { files: { 'data.bin': randomBytes(50_000) } }));
    const plain = await archive('cut.tar', tar.subarray(0, tar.length - 30_000));
    const before = await tree(root);
    expect(await install(plain)).toMatchObject({ ok: false });
    expect(await tree(root)).toEqual(before);
    const text = await archive('notes.tar.gz', Buffer.from('this is not an archive at all\n'));
    const withText = await tree(root);
    const r = await install(text);
    expect(r.ok ? '' : r.error).toContain('damaged or was cut short');
    expect(await tree(root)).toEqual(withText);
    expect(await install(join(root, 'in', 'nothing.tar.gz'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('is not a file that can be read') as string,
    });
  });

  it('cancels mid-way and removes what it unpacked', async () => {
    // several megabytes that do not compress, so the archive is read in more than one piece
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 6; i++) files[`blob-${String(i)}.bin`] = randomBytes(2 ** 20);
    const path = await archive(
      'pipeline-pack-0.5.0-win-x64.tar.gz',
      fakePackArchive('0.5.0', { files }),
    );
    const before = await tree(root);
    const stop = new AbortController();
    const seen: PackInstallProgress[] = [];
    const r = await install(path, {
      signal: stop.signal,
      progressEveryMs: 0,
      onProgress: (p) => {
        seen.push(p);
        if (p.phase === 'unpack' && p.bytesDone > 0 && p.bytesDone < p.bytesTotal) stop.abort();
      },
    });
    expect(r).toEqual({
      ok: false,
      code: 'cancelled',
      error: 'Installing the processing tools was cancelled. Nothing was changed.',
    });
    expect(seen.at(-1)?.phase).toBe('cancelled');
    expect(await tree(root)).toEqual(before);
    // cancelled before it starts
    const early = new AbortController();
    early.abort();
    expect(await install(path, { signal: early.signal })).toMatchObject({ code: 'cancelled' });
    expect(await tree(root)).toEqual(before);
  });

  it('checks the free disk space first, and says what a full disk is', async () => {
    const path = await archive(
      'pipeline-pack-0.5.0-win-x64.tar.gz',
      fakePackArchive('0.5.0', { files: { 'data.bin': randomBytes(300_000) } }),
    );
    const before = await tree(root);
    const asked: string[] = [];
    const r = await install(path, {
      freeBytes: (dir) => {
        asked.push(dir);
        return Promise.resolve(10 * 2 ** 20);
      },
    });
    expect(asked).toEqual([runtime]);
    expect(r.ok ? '' : r.error).toMatch(
      /^Not enough free disk space: the processing tools need about 65 MB in .+runtime, and 10 MB is free\. Free some space and try again\.$/,
    );
    expect(await tree(root)).toEqual(before);
    // the disk filling up while unpacking
    const full = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
    });
    expect(installProblem(full).error).toContain('The disk filled up');
    // unknown free space does not stop an install
    expect(await install(path, { freeBytes: () => Promise.resolve(null) })).toMatchObject({
      ok: true,
    });
  });

  it('asks before replacing a version that is installed', async () => {
    const old = await writeFolderPack('0.5.0');
    await writeFile(join(old, 'marker.txt'), 'the pack that was here');
    const path = await archive('pipeline-pack-0.5.0-win-x64.tar.gz', fakePackArchive('0.5.0'));
    const before = await tree(root);
    const asked = await install(path);
    expect(asked).toEqual({
      ok: false,
      code: 'exists',
      version: '0.5.0',
      error: 'Processing tools 0.5.0 are already installed.',
    });
    expect(await tree(root)).toEqual(before);

    const replaced = await install(path, { replace: true });
    expect(replaced).toEqual({ ok: true, version: '0.5.0', dir: old, replaced: true });
    expect(existsSync(join(old, 'marker.txt'))).toBe(false);
    expect((await readdir(runtime)).sort()).toEqual(['pipeline-pack-0.2.0', 'pipeline-pack-0.5.0']);
  });

  it('clears what a killed install left, and creates runtime when there is none', async () => {
    await mkdir(join(runtime, '.install-0123abcd.tmp', 'python'), { recursive: true });
    await writeFile(join(runtime, '.install-0123abcd.tmp', 'python', 'python.exe'), 'half');
    // a half-unpacked pack is never something findPack picks
    expect((await findPack({ dataRoot, env: {}, app: APP })).runtime.version).toBe('0.2.0');
    const path = await archive('pipeline-pack-0.5.0-win-x64.tar.gz', fakePackArchive('0.5.0'));
    expect(await install(path)).toMatchObject({ ok: true });
    expect((await readdir(runtime)).sort()).toEqual(['pipeline-pack-0.2.0', 'pipeline-pack-0.5.0']);

    const fresh = join(root, 'fresh');
    const r = await installPackArchive(path, { dataRoot: fresh, app: APP, platform: PLATFORM });
    expect(r).toMatchObject({ ok: true, dir: join(fresh, 'runtime', 'pipeline-pack-0.5.0') });
  });

  it('respects the e2e real-data guard before it writes', async () => {
    const path = await archive('pipeline-pack-0.5.0-win-x64.tar.gz', fakePackArchive('0.5.0'));
    const before = await tree(root);
    const refuse = (p: string, op: string) => {
      throw Object.assign(new Error(`E2E real-data guard: refused ${op} of ${p}`), {
        name: 'RealDataWriteRefusedError',
      });
    };
    const r = await install(path, { assertWritable: refuse });
    expect(r).toEqual({
      ok: false,
      error: `E2E real-data guard: refused pipeline pack install of ${runtime}`,
    });
    expect(await tree(root)).toEqual(before);
  });
});

describe('archive paths', () => {
  it('splits a path into safe names', () => {
    expect(archiveSegments('./pipeline-pack-1.0.0/python//bin/python3', false)).toEqual({
      ok: true,
      segments: ['pipeline-pack-1.0.0', 'python', 'bin', 'python3'],
    });
    for (const bad of ['', '/', '.', '/abs', 'a/../b', '..', 'a\\..\\b', 'D:rel', 'a/b\u0000c']) {
      expect(archiveSegments(bad, false).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(archiveSegments('a/con.txt', true).ok).toBe(false);
    expect(archiveSegments('a/con.txt', false).ok).toBe(true);
    expect(archiveSegments('a/what?.txt', true).ok).toBe(false);
  });

  it('judges a link by where its name leads', () => {
    expect(linkStaysInside(['python', 'bin', 'python3'], 'python3.13')).toBe(true);
    expect(linkStaysInside(['python', 'bin', 'python3'], '../lib/libpython.dylib')).toBe(true);
    expect(linkStaysInside(['python', 'bin', 'python3'], '../../..')).toBe(false);
    expect(linkStaysInside(['link'], '..')).toBe(false);
    expect(linkStaysInside(['link'], '/usr/bin/python3')).toBe(false);
    expect(linkStaysInside(['link'], '')).toBe(false);
  });

  it('reads the version from an archive name made for this computer', () => {
    expect(packArchiveName('pipeline-pack-0.5.0-win-x64.tar.gz', PLATFORM)).toEqual({
      version: '0.5.0',
    });
    expect(packArchiveName('pipeline-pack-1.0.0-rc1-win32-x64 (2).tgz', PLATFORM)).toEqual({
      version: '1.0.0-rc1',
    });
    expect(packArchiveName('pipeline-pack-0.5.0-macos-arm64.tar.gz', 'darwin-arm64')).toEqual({
      version: '0.5.0',
    });
    expect(packArchiveName('pipeline-pack-0.5.0-macos-arm64.tar.gz', PLATFORM)).toBeNull();
    expect(packArchiveName('pipeline-pack-0.5.0-win-x64.zip', PLATFORM)).toBeNull();
    expect(packArchiveName('something-else-0.5.0-win-x64.tar.gz', PLATFORM)).toBeNull();
  });
});

describe('listPacks and packStatus', () => {
  const status = (env: Record<string, string | undefined> = {}) =>
    packStatus({ dataRoot, env, app: APP, platform: PLATFORM, features: PHOTO });

  it('lists the pack folders with their sizes, newest first', async () => {
    const newest = await writeFolderPack('0.10.0', { files: { 'big.bin': 'x'.repeat(4000) } });
    const broken = join(runtime, 'pipeline-pack-0.3.0');
    await mkdir(join(broken, 'python'), { recursive: true });
    await writeFile(join(broken, 'python', 'half.bin'), 'x'.repeat(700));
    await mkdir(join(runtime, '.install-00ff.tmp'));
    await writeFile(join(runtime, 'pipeline-pack-0.5.0-win-x64.tar.gz'), 'an archive, not a pack');
    const packs = await listPacks(dataRoot);
    expect(packs.map((p) => [p.name, p.version, p.valid])).toEqual([
      ['pipeline-pack-0.10.0', '0.10.0', true],
      ['pipeline-pack-0.3.0', '0.3.0', false],
      ['pipeline-pack-0.2.0', '0.2.0', true],
    ]);
    expect(packs[0]).toMatchObject({
      dir: newest,
      bytes: 4000 + 'fake python of pack 0.10.0'.length,
    });
    // no manifest: the folder is measured
    expect(packs[1]?.bytes).toBe(700);
    expect(await listPacks(join(root, 'nowhere'))).toEqual([]);
  });

  it('says a pack is too old for what this app does, and what for', async () => {
    const s = await status();
    expect(s).toMatchObject({
      state: 'too-old',
      version: '0.2.0',
      dir: join(runtime, 'pipeline-pack-0.2.0'),
      runtimeDir: runtime,
      platform: PLATFORM,
      others: [],
      installing: false,
      notify: true,
    });
    expect(s.needs[0]).toBe('Creating maps from photos needs version 0.4.0 or later.');
    expect(s.needs[1]).toMatch(
      new RegExp(
        `^This version cannot run ${String(PIPELINES.length - 1)} kinds of job this app has`,
      ),
    );
  });

  it('is up to date with a pack that has every pipeline, and lists the older ones', async () => {
    await writeFolderPack('0.5.0');
    const s = await status();
    expect(s).toMatchObject({ state: 'ok', version: '0.5.0', needs: [] });
    expect(s.others.map((p) => p.name)).toEqual(['pipeline-pack-0.2.0']);
    expect(s.bytes).toBe('fake python of pack 0.5.0'.length);
  });

  it('tells missing from incompatible, and leaves a development pack alone', async () => {
    await rm(runtime, { recursive: true });
    expect(await status()).toMatchObject({ state: 'missing', needs: [], others: [] });
    expect((await status()).problem).toContain('Install one in Settings, Processing tools');
    await writeFolderPack('2.0.0', { appRange: '>=2.0.0 <3.0.0' });
    const s = await status();
    expect(s.state).toBe('incompatible');
    expect(s.problem).toContain('works with Quadrion AI >=2.0.0 <3.0.0');
    expect(s.others.map((p) => p.name)).toEqual(['pipeline-pack-2.0.0']);

    const py = join(root, 'in', 'python.exe');
    await writeFile(py, '');
    expect(await status({ QUADRION_PIPELINE_PYTHON: py })).toMatchObject({
      state: 'dev',
      version: 'dev',
      needs: [],
    });
  });

  it('names one missing pipeline by its title', () => {
    const all = PIPELINES.map((p) => ({ name: p.name, title: p.title }));
    const manifest = {
      schema: 'aio.pipeline-pack/1' as const,
      version: '0.9.0',
      protocol: 'aio.pipelines/1',
      python: { version: '3', build: 'x', executable: 'python/python.exe' },
      platform: PLATFORM,
      createdAt: '2026-10-10T10:00:00Z',
      pipelines: all.slice(1),
      files: {},
    };
    expect(packNeeds('0.9.0', manifest, PHOTO)).toEqual([
      `This version cannot run "${all[0]?.title ?? ''}".`,
    ]);
    expect(packNeeds('0.9.0', { ...manifest, pipelines: all }, PHOTO)).toEqual([]);
    expect(packNeeds('dev', undefined, PHOTO)).toEqual([]);
  });

  it('keeps the start notice out of automated runs', () => {
    expect(packNoticeAllowed({})).toBe(true);
    expect(packNoticeAllowed({ QUADRION_E2E: '1' })).toBe(false);
    expect(packNoticeAllowed({ QUADRION_E2E: '1', QUADRION_PACK_NOTICE: '1' })).toBe(true);
    expect(packNoticeAllowed({ QUADRION_PACK_NOTICE: '0' })).toBe(false);
  });
});

describe('finding a pack archive', () => {
  const places = () => [
    { dir: join(root, 'app'), where: 'app' as const },
    { dir: join(root, 'downloads'), where: 'downloads' as const },
    { dir: runtime, where: 'runtime' as const },
  ];
  const find = () => findPackArchives({ places: places(), platform: PLATFORM, app: APP });

  beforeEach(async () => {
    await mkdir(join(root, 'app'));
    await mkdir(join(root, 'downloads', 'deeper'), { recursive: true });
  });

  it('finds archives for this computer by name, newest first, and reads only their manifest', async () => {
    const d = join(root, 'downloads');
    await writeFile(join(d, 'pipeline-pack-0.5.0-win-x64.tar.gz'), fakePackArchive('0.5.0'));
    await writeFile(join(d, 'pipeline-pack-0.4.0-win-x64.tar.gz'), fakePackArchive('0.4.0'));
    await writeFile(join(d, 'pipeline-pack-0.9.0-macos-arm64.tar.gz'), fakePackArchive('0.9.0'));
    await writeFile(join(d, 'holiday-photos.tar.gz'), 'not ours');
    await writeFile(
      join(d, 'deeper', 'pipeline-pack-3.0.0-win-x64.tar.gz'),
      fakePackArchive('3.0.0'),
    );
    await writeFile(
      join(root, 'app', 'pipeline-pack-0.4.1-win-x64.tar.gz'),
      fakePackArchive('0.4.1'),
    );
    const found = await find();
    expect(found.map((a) => [a.version, a.where])).toEqual([
      ['0.5.0', 'downloads'],
      ['0.4.1', 'app'],
      ['0.4.0', 'downloads'],
    ]);
    expect(found[0]).toMatchObject({ path: join(d, 'pipeline-pack-0.5.0-win-x64.tar.gz') });
    expect(found[0]?.bytes).toBeGreaterThan(100);
  });

  it('drops an archive whose manifest is for another platform, app version or version', async () => {
    const d = join(root, 'downloads');
    await writeFile(
      join(d, 'pipeline-pack-0.9.0-win-x64.tar.gz'),
      fakePackArchive('0.9.0', { platform: 'darwin-arm64' }),
    );
    await writeFile(
      join(d, 'pipeline-pack-0.8.0-win-x64.tar.gz'),
      fakePackArchive('0.8.0', { appRange: '>=5.0.0 <6.0.0' }),
    );
    await writeFile(join(d, 'pipeline-pack-0.7.0-win-x64.tar.gz'), fakePackArchive('0.6.5'));
    await writeFile(join(runtime, 'pipeline-pack-0.6.0-win-x64.tar.gz'), fakePackArchive('0.6.0'));
    // one that cannot be read at all is kept by its name: installing it says what is wrong
    await writeFile(join(d, 'pipeline-pack-0.5.5-win-x64.tar.gz'), 'cut short');
    const found = await findPackArchives({
      places: places(),
      platform: PLATFORM,
      app: APP,
      check: 9,
    });
    expect(found.map((a) => [a.version, a.where])).toEqual([
      ['0.6.0', 'runtime'],
      ['0.5.5', 'downloads'],
    ]);
  });

  it('peeks at the manifest only when it is at the start of the archive', async () => {
    const first = join(root, 'in', 'first.tar.gz');
    await writeFile(first, fakePackArchive('0.5.0'));
    expect(await peekPackManifest(first)).toMatchObject({ version: '0.5.0', platform: PLATFORM });
    // behind more than the peek reads: not found, and not an error
    const entries = fakePackEntries('0.5.0', { files: { 'a-big.bin': randomBytes(300_000) } });
    const late = join(root, 'in', 'late.tar.gz');
    await writeFile(
      late,
      fakeTarGz([
        ...entries.filter((e) => !e.path.endsWith('manifest.json')),
        ...entries.filter((e) => e.path.endsWith('manifest.json')),
      ]),
    );
    expect(await peekPackManifest(late, { maxBytes: 100_000 })).toBeNull();
    expect(await peekPackManifest(late)).toMatchObject({ version: '0.5.0' });
    expect(await peekPackManifest(join(root, 'in', 'missing.tar.gz'))).toBeNull();
  });

  it('looks beside the app first and in Downloads last', () => {
    expect(
      packArchivePlaces({
        exe: join(root, 'kit', 'app', 'Quadrion AI.exe'),
        portableDir: join(root, 'stick'),
        downloads: join(root, 'downloads'),
      }),
    ).toEqual([
      { dir: join(root, 'stick'), where: 'app' },
      { dir: join(root, 'kit', 'app'), where: 'app' },
      { dir: join(root, 'kit'), where: 'app' },
      { dir: join(root, 'downloads'), where: 'downloads' },
    ]);
    const mac = packArchivePlaces({
      exe: '/Applications/Quadrion AI.app/Contents/MacOS/Quadrion AI',
      downloads: '/Users/someone/Downloads',
    });
    expect(mac.map((p) => p.dir)).toContain('/Applications');
    expect(mac.at(-1)).toEqual({ dir: '/Users/someone/Downloads', where: 'downloads' });
  });

  it('offers the newest archive only when it is newer than the pack in use', () => {
    const a = (version: string) => ({
      path: `/d/${version}`,
      version,
      where: 'downloads' as const,
      bytes: 1,
    });
    expect(
      packOffer({ state: 'too-old', version: '0.2.0' }, [a('0.5.0'), a('0.4.0')])?.version,
    ).toBe('0.5.0');
    expect(packOffer({ state: 'ok', version: '0.5.0' }, [a('0.5.0')])).toBeNull();
    expect(packOffer({ state: 'ok', version: '0.5.0' }, [a('0.4.0')])).toBeNull();
    expect(packOffer({ state: 'missing' }, [a('0.4.0')])?.version).toBe('0.4.0');
    expect(packOffer({ state: 'incompatible' }, [a('0.4.0')])?.version).toBe('0.4.0');
    expect(packOffer({ state: 'dev', version: 'dev' }, [a('9.0.0')])).toBeNull();
    expect(packOffer({ state: 'missing' }, [])).toBeNull();
  });
});

describe('pipeline pack IPC', () => {
  type Handlers = Partial<Record<IpcChannel, (raw: unknown) => Promise<unknown>>>;

  function setup(over: Partial<PipelinePackIpcDeps> = {}) {
    const handlers: Handlers = {};
    const events: PackInstallProgress[] = [];
    const trashed: string[] = [];
    const chosen: (string | null)[] = [];
    registerPipelinePackIpc({
      // every request and answer goes through the frozen contract, as in the app
      handle: (channel, handler) => {
        handlers[channel] = validated(channel, handler);
      },
      dataRoot: () => dataRoot,
      env: {},
      app: APP,
      platform: PLATFORM,
      features: PHOTO,
      places: () => [
        { dir: join(root, 'app'), where: 'app' },
        { dir: join(root, 'downloads'), where: 'downloads' },
      ],
      chooseFile: (startDir) => {
        chosen.push(startDir);
        return Promise.resolve(null);
      },
      trash: async (dir) => {
        trashed.push(dir);
        await rm(dir, { recursive: true });
      },
      emit: (p) => events.push(p),
      ...over,
    });
    const call = <T>(channel: IpcChannel, request: unknown = {}) => {
      const h = handlers[channel];
      if (!h) throw new Error(`no handler for ${channel}`);
      return h(request) as Promise<T>;
    };
    return { call, events, trashed, chosen };
  }

  it('finds an archive in Downloads, installs it, then lists and removes the old pack', async () => {
    await mkdir(join(root, 'downloads'), { recursive: true });
    const path = join(root, 'downloads', 'pipeline-pack-0.5.0-win-x64.tar.gz');
    await writeFile(path, fakePackArchive('0.5.0'));
    const { call, events, trashed, chosen } = setup();

    expect(await call('pipelinePack:status')).toMatchObject({ state: 'too-old', version: '0.2.0' });
    const found = await call<{ offer: unknown; startDir: string }>('pipelinePack:find');
    expect(found).toMatchObject({
      offer: { path, version: '0.5.0', where: 'downloads' },
      startDir: join(root, 'downloads'),
    });
    // the dialog opens where the archive was found
    expect(await call('pipelinePack:choose')).toEqual({ path: null });
    expect(chosen).toEqual([join(root, 'downloads')]);

    const r = await call<{ ok: boolean; status: { state: string; others: { name: string }[] } }>(
      'pipelinePack:install',
      { path },
    );
    expect(r).toMatchObject({
      ok: true,
      version: '0.5.0',
      status: { state: 'ok', version: '0.5.0', installing: false },
    });
    expect(r.status.others.map((p) => p.name)).toEqual(['pipeline-pack-0.2.0']);
    expect(events.at(-1)?.phase).toBe('done');
    // nothing newer is left to offer
    expect(await call('pipelinePack:find')).toMatchObject({ offer: null });

    // the pack in use is never removed; an older one goes to the bin
    expect(await call('pipelinePack:remove', { name: 'pipeline-pack-0.5.0' })).toEqual({
      ok: false,
      error: 'This version is the one in use. Install a newer one first.',
    });
    expect(await call('pipelinePack:remove', { name: 'pipeline-pack-0.1.0' })).toMatchObject({
      ok: false,
    });
    await expect(call('pipelinePack:remove', { name: '../../projects' })).rejects.toThrow(
      'Invalid request',
    );
    expect(trashed).toEqual([]);
    const removed = await call<{ ok: boolean; status: { others: unknown[] } }>(
      'pipelinePack:remove',
      { name: 'pipeline-pack-0.2.0' },
    );
    expect(removed).toMatchObject({ ok: true, status: { state: 'ok', others: [] } });
    expect(trashed).toEqual([join(runtime, 'pipeline-pack-0.2.0')]);
  });

  it('runs one install at a time and cancels it', async () => {
    const path = await archive('pipeline-pack-0.5.0-win-x64.tar.gz', fakePackArchive('0.5.0'));
    const before = await tree(root);
    // the install waits on the free-space answer until the test lets it go on
    let release: () => void = () => undefined;
    const gate = new Promise<null>((r) => {
      release = () => {
        r(null);
      };
    });
    const { call, events } = setup({ freeBytes: () => gate });
    expect(await call('pipelinePack:cancel')).toEqual({ ok: false });
    const first = call('pipelinePack:install', { path });
    expect(await call('pipelinePack:install', { path })).toEqual({
      ok: false,
      code: 'busy',
      error: 'The processing tools are being installed already.',
    });
    expect(await call('pipelinePack:status')).toMatchObject({ installing: true });
    expect(await call('pipelinePack:cancel')).toEqual({ ok: true });
    release();
    expect(await first).toMatchObject({ ok: false, code: 'cancelled' });
    expect(events.at(-1)?.phase).toBe('cancelled');
    expect(await tree(root)).toEqual(before);
    expect(await call('pipelinePack:status')).toMatchObject({
      installing: false,
      state: 'too-old',
    });
  });

  it('refuses under the real-data guard, for installing and for removing', async () => {
    await writeFolderPack('0.5.0');
    const path = await archive('pipeline-pack-0.6.0-win-x64.tar.gz', fakePackArchive('0.6.0'));
    const before = await tree(root);
    const guard = vi.fn((p: string, op: string) => {
      throw Object.assign(new Error(`refused ${op} of ${p}`), {
        name: 'RealDataWriteRefusedError',
      });
    });
    const { call, trashed } = setup({ assertWritable: guard });
    expect(await call('pipelinePack:install', { path })).toEqual({
      ok: false,
      error: `refused pipeline pack install of ${runtime}`,
    });
    expect(await call('pipelinePack:remove', { name: 'pipeline-pack-0.2.0' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('could not be moved to the bin') as string,
    });
    expect(trashed).toEqual([]);
    expect(await tree(root)).toEqual(before);
  });
});
