import {
  mkdtemp,
  mkdir,
  readFile,
  rename as renameFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OdmInstallProgress } from '@aio/schema';
import { installOdm, odmJobEnv, odmStatus, parkOdmStub, removeOdm, type OdmDeps } from './install';
import type { OdmSystem } from './system';

const SETUP = Buffer.from('fake setup bytes');
let dir: string;
let server: Server;
let url: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-odm-'));
  server = createServer((_, res) => res.end(SETUP));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  url = `http://127.0.0.1:${String(port)}/ODM_Setup_test.exe`;
  await writeFile(
    join(dir, 'pin.json'),
    JSON.stringify({
      version: '3.6.2',
      url,
      size: SETUP.length,
      sha256: createHash('sha256').update(SETUP).digest('hex'),
      installedBytes: 1000,
      file: 'ODM_Setup_test.exe',
    }),
  );
});
afterEach(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

/** What ODM's setup leaves in its folder that the check looks for (C4), and the uninstaller. */
async function writeOdmFiles(target: string): Promise<void> {
  await mkdir(join(target, 'venv', 'Scripts'), { recursive: true });
  await writeFile(join(target, 'venv', 'Scripts', 'python.exe'), '');
  for (const f of ['run.bat', 'winrun.bat', 'win32env.bat', 'unins000.exe'])
    await writeFile(join(target, f), '');
  await writeFile(join(target, 'VERSION'), '3.6.2');
}

const dirArg = (args: string[]) => args.find((a) => a.startsWith('/DIR='))?.slice(5) ?? '';

/** A system whose setup writes what ODM's would, and whose uninstaller removes it. */
function fakeSystem(over: Partial<OdmSystem> = {}): OdmSystem & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runSetup: async (file, args) => {
      calls.push([file, ...args]);
      await writeOdmFiles(dirArg(args));
      return 0;
    },
    runSmoke: () => Promise.resolve({ code: 0, out: 'usage: run [options] <dataset name>' }),
    runUninstaller: async (file) => {
      calls.push([file]);
      await rm(join(file, '..'), { recursive: true, force: true });
      return 0;
    },
    regQuery: () => Promise.resolve(''),
    rename: async (from, to) => {
      await renameFile(from, to);
    },
    fileBytes: async (p) => (existsSync(p) ? (await stat(p)).size : null),
    exists: (p) => Promise.resolve(existsSync(p)),
    rm: (p) => rm(p, { recursive: true, force: true }),
    freeBytes: () => Promise.resolve(10e12),
    sleep: () => Promise.resolve(),
    ...over,
  };
}

function deps(system = fakeSystem(), over: Partial<OdmDeps> = {}): OdmDeps {
  return {
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
    system,
    gpus: () => Promise.resolve([{ name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'NVIDIA' }]),
    gpuSetting: () => 'auto',
    offlineOnly: () => false,
    now: () => new Date('2026-10-14T10:00:00Z'),
    ...over,
  };
}

const run = (d: OdmDeps, replaceOther = false) => {
  const seen: OdmInstallProgress[] = [];
  return installOdm(d, {
    replaceOther,
    signal: new AbortController().signal,
    onProgress: (p) => seen.push(p),
  }).then((r) => ({ r, seen }));
};

const readRec = async (root: string) =>
  JSON.parse(await readFile(join(root, 'runtime', 'odm.json'), 'utf8')) as {
    dir: string;
    version: string;
  };

// Install folders are Windows drive paths (C5); temporary folders elsewhere are not.
describe.skipIf(process.platform !== 'win32')('installing ODM', () => {
  it('downloads, checks, runs the setup silently, smoke-tests and records it', async () => {
    const system = fakeSystem();
    const { r, seen } = await run(deps(system));
    expect(r.ok).toBe(true);
    const setup = system.calls[0] ?? [];
    expect(setup.slice(1, 5)).toEqual([
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/CURRENTUSER',
    ]);
    expect(setup[5]).toBe(`/DIR=${join(dir, 'data', 'runtime', 'odm-3.6.2')}`);
    const record = await readRec(join(dir, 'data'));
    expect(record).toMatchObject({
      schema: 'aio.odm-install/1',
      version: '3.6.2',
      installedAt: '2026-10-14T10:00:00.000Z',
    });
    expect(seen.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['download', 'install', 'check', 'done']),
    );
    expect(existsSync(join(dir, 'data', 'runtime', 'downloads', 'ODM_Setup_test.exe'))).toBe(false);
    if (r.ok) expect(r.status.state).toBe('installed');
  });

  it('install folder avoids non-ASCII letters in the data root', async () => {
    const d = deps(fakeSystem(), { dataRoot: () => join(dir, 'Données') });
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    const record = await readRec(join(dir, 'Données'));
    expect(record.dir).toMatch(/^[\x20-\x7e]+$/);
    expect(record.dir.startsWith(join(dir, 'local'))).toBe(true);
  });

  it('install folder avoids spaces in the data root', async () => {
    const d = deps(fakeSystem(), { dataRoot: () => join(dir, 'Stratlas Data') });
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    const record = await readRec(join(dir, 'Stratlas Data'));
    expect(record.dir).not.toMatch(/\s/); // C5 false: ODM's SMRF command breaks on a space
    expect(record.dir.startsWith(join(dir, 'local'))).toBe(true);
  });

  it('parks the placeholder nvcuda.dll after install when the driver is there, and puts it back for off and remove', async () => {
    const system = fakeSystem({
      runSetup: async (_file, args) => {
        const target = dirArg(args);
        await mkdir(join(target, 'SuperBuild', 'install', 'bin'), { recursive: true });
        await writeFile(
          join(target, 'SuperBuild', 'install', 'bin', 'nvcuda.dll'),
          Buffer.alloc(19_968),
        );
        await writeOdmFiles(target);
        return 0;
      },
    });
    const d = deps(system, { env: { ...deps().env, SYSTEMROOT: join(dir, 'win') } });
    await mkdir(join(dir, 'win', 'System32'), { recursive: true });
    await writeFile(join(dir, 'win', 'System32', 'nvcuda.dll'), 'driver');
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    const rec = await readRec(join(dir, 'data'));
    const bin = join(rec.dir, 'SuperBuild', 'install', 'bin');
    expect(existsSync(join(bin, 'nvcuda.dll'))).toBe(false);
    expect(existsSync(join(bin, 'nvcuda.dll.odm-stub'))).toBe(true);
    await parkOdmStub(rec.dir, 'off', d.env, system);
    expect(existsSync(join(bin, 'nvcuda.dll'))).toBe(true);
    expect(existsSync(join(bin, 'nvcuda.dll.odm-stub'))).toBe(false);
    // parked again, then remove puts it back before the uninstaller runs
    await parkOdmStub(rec.dir, 'auto', d.env, system);
    let seenAtUninstall: boolean | null = null;
    const r2 = await removeOdm({
      ...d,
      system: {
        ...system,
        runUninstaller: async (file, args) => {
          seenAtUninstall = existsSync(join(bin, 'nvcuda.dll'));
          return system.runUninstaller(file, args);
        },
      },
    });
    expect(r2.ok).toBe(true);
    expect(seenAtUninstall).toBe(true);
  });

  it('leaves a real nvcuda.dll (not the placeholder) alone, and parks nothing without the driver', async () => {
    const bin = join(dir, 'odm', 'SuperBuild', 'install', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'nvcuda.dll'), Buffer.alloc(200_000));
    await mkdir(join(dir, 'win', 'System32'), { recursive: true });
    await writeFile(join(dir, 'win', 'System32', 'nvcuda.dll'), 'driver');
    const system = fakeSystem();
    await parkOdmStub(join(dir, 'odm'), 'auto', { SYSTEMROOT: join(dir, 'win') }, system);
    expect(existsSync(join(bin, 'nvcuda.dll'))).toBe(true);
    await writeFile(join(bin, 'nvcuda.dll'), Buffer.alloc(19_968));
    await parkOdmStub(join(dir, 'odm'), 'auto', { SYSTEMROOT: join(dir, 'nowin') }, system);
    expect(existsSync(join(bin, 'nvcuda.dll'))).toBe(true);
  });

  it('an ODM that does not print its usage is broken, whatever its exit code', async () => {
    const { r } = await run(
      deps(
        fakeSystem({
          runSmoke: () => Promise.resolve({ code: 0, out: "'winrun.bat' is not recognized" }),
        }),
      ),
    );
    expect(r).toMatchObject({ ok: false, code: 'failed' });
  });

  it('a setup that leaves a required file out is reported', async () => {
    const system = fakeSystem({
      runSetup: async (_file, args) => {
        await writeOdmFiles(dirArg(args));
        await rm(join(dirArg(args), 'win32env.bat'));
        return 0;
      },
    });
    const { r, seen } = await run(deps(system));
    expect(r).toMatchObject({
      ok: false,
      code: 'failed',
      error: "ODM's setup finished but win32env.bat is missing.",
    });
    expect(seen.at(-1)).toMatchObject({ phase: 'failed' });
  });

  it('refuses while another ODM is installed until replaceOther', async () => {
    const regText = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{ODM}_is1',
      '    DisplayName    REG_SZ    ODM version 3.5.6',
      '    InstallLocation    REG_SZ    C:\\ODM\\',
      '    DisplayVersion    REG_SZ    3.5.6',
    ].join('\r\n');
    const system = fakeSystem({
      regQuery: (k) => Promise.resolve(k.startsWith('HKCU') ? regText : ''),
    });
    const first = await run(deps(system));
    expect(first.r).toMatchObject({
      ok: false,
      code: 'other-install',
      error: 'Another ODM is installed in C:\\ODM. Installing replaces it.',
    });
    expect(system.calls).toHaveLength(0);
    const second = await run(deps(system), true);
    expect(second.r.ok).toBe(true);
  });

  it('a setup that fails or an engine that does not start is reported plainly', async () => {
    const bad = await run(deps(fakeSystem({ runSetup: () => Promise.resolve(5) })));
    expect(bad.r).toMatchObject({ ok: false, code: 'failed' });
    if (!bad.r.ok) expect(bad.r.error).toMatch(/cancelled|permission/i);
    const odd = await run(deps(fakeSystem({ runSetup: () => Promise.resolve(7) })));
    expect(odd.r).toMatchObject({ ok: false, error: "ODM's setup stopped with exit code 7." });
    const broken = await run(
      deps(fakeSystem({ runSmoke: () => Promise.resolve({ code: 1, out: 'Traceback\nboom\n' }) })),
    );
    expect(broken.r).toMatchObject({ ok: false, code: 'failed' });
    if (!broken.r.ok) expect(broken.r.error).toMatch(/does not start: boom/);
  });

  it('too little free space is refused before the download', async () => {
    const system = fakeSystem({ freeBytes: () => Promise.resolve(100) });
    const { r } = await run(deps(system));
    expect(r).toMatchObject({ ok: false, code: 'disk' });
    expect(system.calls).toHaveLength(0);
  });

  it('a download that fails is reported and nothing is installed', async () => {
    const system = fakeSystem();
    const d = deps(system, {
      fetch: () => Promise.resolve(new Response('nope', { status: 500 })),
    });
    const { r, seen } = await run(d);
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(seen.at(-1)).toMatchObject({ phase: 'failed' });
    expect(system.calls).toHaveLength(0);
  });

  it('offline-only and other platforms are refused before any download', async () => {
    expect((await run(deps(fakeSystem(), { offlineOnly: () => true }))).r).toMatchObject({
      code: 'offline-only',
    });
    expect((await run(deps(fakeSystem(), { platform: 'darwin', arch: 'arm64' }))).r).toMatchObject({
      code: 'unsupported',
    });
  });

  it('status follows the record: installed, update available, broken, not installed', async () => {
    const d = deps();
    expect((await odmStatus(d, false)).state).toBe('not-installed');
    expect((await odmStatus(d, true)).state).toBe('installing');
    await run(d);
    expect(await odmStatus(d, false)).toMatchObject({
      state: 'installed',
      version: '3.6.2',
      gpu: { setting: 'auto', nvidia: 'NVIDIA GeForce RTX 5070 Ti', cuda: false },
      other: null,
      dev: false,
      mayAskAdmin: false,
      pinned: { version: '3.6.2' },
    });
    const recPath = join(dir, 'data', 'runtime', 'odm.json');
    const rec = await readRec(join(dir, 'data'));
    await writeFile(recPath, JSON.stringify({ ...rec, version: '3.5.6' }));
    expect((await odmStatus(d, false)).state).toBe('update-available');
    await rm(join(rec.dir, 'run.bat'));
    expect(await odmStatus(d, false)).toMatchObject({
      state: 'broken',
      problem: 'Files of the processing engine are missing. Reinstall it.',
    });
    expect((await odmStatus({ ...d, platform: 'darwin', arch: 'arm64' }, false)).state).toBe(
      'unsupported',
    );
  });

  it('remove runs the uninstaller, waits for it, and forgets the record', async () => {
    const d = deps();
    await run(d);
    const r = await removeOdm(d);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'data', 'runtime', 'odm.json'))).toBe(false);
    expect((await odmStatus(d, false)).state).toBe('not-installed');
  });

  it('remove waits for an uninstaller that returns early, then clears what is left', async () => {
    let polls = 0;
    const system = fakeSystem({
      runUninstaller: () => Promise.resolve(0),
      sleep: () => {
        polls += 1;
        return Promise.resolve();
      },
    });
    const d = deps(system);
    await run(d);
    const rec = await readRec(join(dir, 'data'));
    const r = await removeOdm(d);
    expect(r.ok).toBe(true);
    expect(polls).toBe(300);
    expect(existsSync(rec.dir)).toBe(false);
  });

  it('a failed install removes what the setup left; our own folder is never "another ODM"', async () => {
    const system = fakeSystem({
      runSmoke: () => Promise.resolve({ code: 0, out: "'winrun.bat' is not recognized" }),
    });
    const target = join(dir, 'data', 'runtime', 'odm-3.6.2');
    const { r } = await run(deps(system));
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(system.calls.at(-1)).toEqual([join(target, 'unins000.exe')]);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(dir, 'data', 'runtime', 'odm.json'))).toBe(false);

    // an uninstall entry for our install folder with no odm.json (a setup that left it behind)
    const regText = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{ODM}_is1',
      '    DisplayName    REG_SZ    ODM version 3.6.2',
      `    InstallLocation    REG_SZ    ${target}\\`,
    ].join('\r\n');
    const d = deps(
      fakeSystem({ regQuery: (k) => Promise.resolve(k.startsWith('HKCU') ? regText : '') }),
    );
    expect((await odmStatus(d, false)).other).toBeNull();
    expect((await run(d)).r.ok).toBe(true);
  });

  it('a failed reinstall over our recorded folder leaves it, reported broken', async () => {
    const d = deps();
    await run(d);
    const rec = await readRec(join(dir, 'data'));
    const system = fakeSystem({
      runSetup: async (_file, args) => {
        await rm(join(dirArg(args), 'run.bat'));
        return 7;
      },
    });
    const { r } = await run(deps(system));
    expect(r.ok).toBe(false);
    expect(system.calls).toHaveLength(0); // no uninstaller run
    expect(existsSync(rec.dir)).toBe(true);
    expect((await odmStatus(d, false)).state).toBe('broken');
  });

  it('checks the download drive and the install drive, each for its own share', async () => {
    const on = (free: Record<string, number>) =>
      fakeSystem({ freeBytes: (p) => Promise.resolve(free[p.slice(0, 3).toUpperCase()] ?? 10e12) });
    // the data root has a space, so ODM goes to local app data on C:, the setup to Q:
    const split = { dataRoot: () => 'Q:\\Stratlas Data' };
    const c = join(dir, 'local').slice(0, 3).toUpperCase();
    const q1 = await run(deps(on({ 'Q:\\': 10 }), split));
    expect(q1.r).toMatchObject({ ok: false, code: 'disk' });
    if (!q1.r.ok) expect(q1.r.error).toMatch(/^Not enough free space on Q:\\/);
    const c1 = await run(deps(on({ 'Q:\\': 10e12, [c]: 999 }), split));
    expect(c1.r).toMatchObject({ ok: false, code: 'disk' });
    if (!c1.r.ok) expect(c1.r.error).toContain(`on ${c}`);
    // one drive: the setup (16 bytes) and ODM (1000) together
    const both = await run(deps(on({ [c]: 1010 })));
    expect(both.r).toMatchObject({ ok: false, code: 'disk' });
    expect((await run(deps(on({ [c]: 1016 })))).r.ok).toBe(true);
  });

  it('a cancel during the hash check stops before the setup runs', async () => {
    // already downloaded: downloadVerified reports verify and returns without reading a stream
    await mkdir(join(dir, 'data', 'runtime', 'downloads'), { recursive: true });
    await writeFile(join(dir, 'data', 'runtime', 'downloads', 'ODM_Setup_test.exe'), SETUP);
    const system = fakeSystem();
    const ctl = new AbortController();
    const seen: OdmInstallProgress[] = [];
    const r = await installOdm(deps(system), {
      replaceOther: false,
      signal: ctl.signal,
      onProgress: (p) => {
        seen.push(p);
        if (p.phase === 'verify') ctl.abort();
      },
    });
    expect(r).toMatchObject({ ok: false, code: 'cancelled' });
    expect(system.calls).toHaveLength(0);
    expect(seen.at(-1)).toMatchObject({ phase: 'cancelled' });
  });

  it('a setup whose hash does not match never runs, and the error names the ODM download', async () => {
    const pin = JSON.parse(await readFile(join(dir, 'pin.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(join(dir, 'pin.json'), JSON.stringify({ ...pin, sha256: '0'.repeat(64) }));
    const system = fakeSystem();
    const { r } = await run(deps(system));
    expect(r).toMatchObject({
      ok: false,
      code: 'failed',
      error: 'The ODM download does not match its checksum (SHA-256). It was deleted; try again.',
    });
    expect(system.calls).toHaveLength(0);
    const http = await run(
      deps(fakeSystem(), { fetch: () => Promise.resolve(new Response('', { status: 503 })) }),
    );
    expect(http.r).toMatchObject({ error: 'The server answered HTTP 503 for the ODM download.' });
  });

  it('a placeholder that cannot be renamed is a warning in the log and the status, not a failure', async () => {
    const lines: string[] = [];
    const system = fakeSystem({
      runSetup: async (_file, args) => {
        const target = dirArg(args);
        await mkdir(join(target, 'SuperBuild', 'install', 'bin'), { recursive: true });
        await writeFile(
          join(target, 'SuperBuild', 'install', 'bin', 'nvcuda.dll'),
          Buffer.alloc(19_968),
        );
        await writeOdmFiles(target);
        return 0;
      },
      rename: () => Promise.reject(new Error('EBUSY: resource busy or locked')),
    });
    await mkdir(join(dir, 'win', 'System32'), { recursive: true });
    await writeFile(join(dir, 'win', 'System32', 'nvcuda.dll'), 'driver');
    const d = deps(system, {
      env: { ...deps().env, SYSTEMROOT: join(dir, 'win') },
      log: (l) => lines.push(l),
    });
    const { r } = await run(d);
    expect(r).toMatchObject({ ok: true, status: { state: 'installed' } });
    if (r.ok) expect(r.status.problem).toMatch(/placeholder nvcuda\.dll could not be set aside/);
    expect(lines.join('\n')).toMatch(/EBUSY/);
  });

  it('only deletes folders that look like our ODM install', async () => {
    // a record that names a folder of someone else's
    const precious = join(dir, 'precious');
    await mkdir(precious, { recursive: true });
    await writeFile(join(precious, 'run.bat'), '');
    const recPath = join(dir, 'data', 'runtime', 'odm.json');
    await mkdir(join(dir, 'data', 'runtime'), { recursive: true });
    const rec = {
      schema: 'aio.odm-install/1',
      version: '3.5.6',
      dir: precious,
      installedAt: '2026-10-01T00:00:00.000Z',
    };
    await writeFile(recPath, JSON.stringify(rec));
    expect((await run(deps(), true)).r.ok).toBe(true); // replaces the record, keeps the folder
    expect(existsSync(precious)).toBe(true);
    await writeFile(recPath, JSON.stringify(rec));
    expect((await removeOdm(deps())).ok).toBe(true);
    expect(existsSync(precious)).toBe(true);
    // an older install of ours in our folder is removed after the update
    const older = join(dir, 'data', 'runtime', 'odm-3.5.6');
    await mkdir(older, { recursive: true });
    await writeFile(join(older, 'run.bat'), '');
    await writeFile(recPath, JSON.stringify({ ...rec, dir: older }));
    expect((await run(deps(), true)).r.ok).toBe(true);
    expect(existsSync(older)).toBe(false);
  });

  it('QUADRION_ODM_DIR names an ODM without installing it', async () => {
    const d = deps(fakeSystem(), {
      env: { QUADRION_ODM_DIR: join(dir, 'fake'), QUADRION_ODM_VERSION: '3.6.2' },
    });
    const s = await odmStatus(d, false);
    expect(s).toMatchObject({ state: 'installed', dev: true, dir: join(dir, 'fake') });
    expect((await removeOdm(d)).ok).toBe(false);
    expect((await run(d)).r).toMatchObject({ ok: false, code: 'dev' });
  });
});

describe('the job environment', () => {
  it('names ODM, its version, the GPU setting and the work folder for photo jobs only', () => {
    const env = odmJobEnv(
      'photo.products',
      { dir: 'C:\\Q\\odm-3.6.2', version: '3.6.2', owned: true },
      'off',
    );
    expect(env).toEqual({
      AIO_ODM: 'C:\\Q\\odm-3.6.2',
      AIO_ODM_VERSION: '3.6.2',
      AIO_ODM_GPU: 'off',
      AIO_ODM_WORK: 'C:\\Q\\odm-work',
      AIO_ODM_OWNED: '1',
    });
    const dev = odmJobEnv(
      'photo.products',
      { dir: 'C:\\Q\\odm-3.6.2', version: '3.6.2', owned: false },
      'off',
    );
    expect(dev.AIO_ODM_OWNED).toBeUndefined(); // QUADRION_ODM_DIR: never touch its files
    const odm = { dir: 'x', version: 'y', owned: true };
    expect(odmJobEnv('photo.align', odm, 'auto')).toMatchObject({ AIO_ODM: 'x' });
    expect(odmJobEnv('photo.georef', odm, 'auto')).toMatchObject({ AIO_ODM: 'x' });
    expect(odmJobEnv('walk.process', odm, 'auto')).toEqual({});
    expect(odmJobEnv('photo.align', null, 'auto')).toEqual({});
  });
});
