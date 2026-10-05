import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRollback,
  installOf,
  isKeptCopy,
  restoreArgs,
  restoreInto,
  type RollbackFs,
} from './rollback';

const fs: RollbackFs = {
  readFile: (p, enc) => fsp.readFile(p, enc),
  writeFile: (p, d) => fsp.writeFile(p, d),
  rename: (a, b) => fsp.rename(a, b),
  rm: (p, o) => fsp.rm(p, o),
  mkdir: (p, o) => fsp.mkdir(p, o),
  cp: (a, b, o) => fsp.cp(a, b, o),
  stat: (p) => fsp.stat(p),
  readdir: (p) => fsp.readdir(p),
};

let base: string;
let appRoot: string;
let updates: string;

async function installVersion(version: string) {
  await rm(appRoot, { recursive: true, force: true });
  await mkdir(join(appRoot, 'resources'), { recursive: true });
  await writeFile(join(appRoot, 'Stratlas.exe'), `exe ${version}`);
  await writeFile(join(appRoot, 'resources', 'app.asar'), `asar ${version}`);
}

const rollbackFor = (current: string) =>
  createRollback({
    dir: updates,
    current,
    install: { appRoot, exe: 'Stratlas.exe' },
    fs,
    now: () => new Date('2026-10-05T12:00:00Z'),
  });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rollback-'));
  appRoot = join(base, 'Programs', 'Stratlas');
  updates = join(base, 'userData', 'updates');
  await installVersion('0.7.0');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('keeping the previous version', () => {
  it('copies the installed folder, records the update and keeps only one copy', async () => {
    await mkdir(join(updates, 'previous', '0.6.0'), { recursive: true });
    const kept = await rollbackFor('0.7.0').keepCurrent('0.8.0');
    expect(kept.exe).toBe(join(updates, 'previous', '0.7.0', 'Stratlas.exe'));
    expect(await readFile(join(kept.dir, 'resources', 'app.asar'), 'utf8')).toBe('asar 0.7.0');
    expect(existsSync(join(updates, 'previous', '0.6.0'))).toBe(false);
    expect(existsSync(`${kept.dir}.partial`)).toBe(false);
    const j = await rollbackFor('0.7.0').read();
    expect(j.pending).toMatchObject({ from: '0.7.0', to: '0.8.0', launches: 0, failures: 0 });
    expect(j.previous).toMatchObject({ version: '0.7.0', appRoot });
  });

  it('is not possible in a development build', async () => {
    const r = createRollback({
      dir: updates,
      current: '0.7.0',
      install: installOf('C:/x/electron.exe', 'win32', {
        packaged: false,
        store: false,
        portable: false,
      }),
      fs,
    });
    await expect(r.keepCurrent('0.8.0')).rejects.toThrow(/development build/);
    expect((await r.status()).rollbackUnavailable).toMatch(/development build/);
  });
});

describe('first start of the new version', () => {
  beforeEach(async () => {
    await rollbackFor('0.7.0').keepCurrent('0.8.0');
    await installVersion('0.8.0');
  });

  it('watches the first start and closes the record when the renderer is ready', async () => {
    const r = rollbackFor('0.8.0');
    expect(await r.startup()).toEqual({ kind: 'watch', from: '0.7.0', to: '0.8.0' });
    expect((await r.status()).pending).toEqual({ from: '0.7.0', to: '0.8.0', failures: 0 });
    expect(await r.markReady()).toBe(true);
    expect(await r.startup()).toEqual({ kind: 'normal' });
    const s = await r.status();
    expect(s.pending).toBeUndefined();
    expect(s.previous).toEqual({ version: '0.7.0', dir: join(updates, 'previous', '0.7.0') });
  });

  it('offers rollback at the next start after a start that never got ready', async () => {
    const r = rollbackFor('0.8.0');
    await r.startup(); // crashed or hung: no ready, no clean exit
    expect(await r.startup()).toEqual({ kind: 'offer', from: '0.7.0', to: '0.8.0', failures: 1 });
  });

  it('does not count a start the person closed before it was ready', async () => {
    const r = rollbackFor('0.8.0');
    await r.startup();
    await r.markCleanExit();
    expect(await r.startup()).toEqual({ kind: 'watch', from: '0.7.0', to: '0.8.0' });
  });

  it('counts an in-session failure and stops asking once declined', async () => {
    const r = rollbackFor('0.8.0');
    await r.startup();
    expect(await r.markFailure('no ready in 90 s')).toBe(true);
    expect((await r.status()).pending?.failures).toBe(1);
    await r.decline();
    expect(await r.startup()).toEqual({ kind: 'watch', from: '0.7.0', to: '0.8.0' });
    expect(await r.markFailure('again')).toBe(false);
  });

  it('closes the record when the installer did not finish and the old version still runs', async () => {
    await installVersion('0.7.0');
    const r = rollbackFor('0.7.0');
    expect(await r.startup()).toEqual({ kind: 'installAborted', to: '0.8.0' });
    expect((await r.status()).previous).toBeUndefined(); // the copy is this very version
    expect(await r.startup()).toEqual({ kind: 'normal' });
    expect(existsSync(join(updates, 'previous', '0.7.0'))).toBe(false);
  });

  it('removes leftovers at a normal start but never the kept previous version', async () => {
    const r = rollbackFor('0.8.0');
    await r.startup();
    await r.markReady();
    await mkdir(join(updates, 'previous', '0.5.0'), { recursive: true });
    expect(await r.startup()).toEqual({ kind: 'normal' });
    expect(existsSync(join(updates, 'previous', '0.5.0'))).toBe(false);
    expect(existsSync(join(updates, 'previous', '0.7.0', 'Stratlas.exe'))).toBe(true);
  });
});

describe('restoring the kept version', () => {
  it('replaces the installed folder with two renames and records the rollback', async () => {
    const kept = await rollbackFor('0.7.0').keepCurrent('0.8.0');
    await installVersion('0.8.0');
    await restoreInto(kept.dir, appRoot, null, {
      fs,
      alive: () => false,
      sleep: () => Promise.resolve(),
    });
    expect(await readFile(join(appRoot, 'Stratlas.exe'), 'utf8')).toBe('exe 0.7.0');
    expect(existsSync(`${appRoot}.failed`)).toBe(false);
    expect(existsSync(`${appRoot}.restoring`)).toBe(false);
    const r = rollbackFor('0.7.0');
    await r.recordRollback('0.8.0');
    expect((await r.status()).rolledBack).toEqual({
      from: '0.8.0',
      to: '0.7.0',
      at: '2026-10-05T12:00:00.000Z',
    });
  });

  it('restores into an install folder an interrupted installer left empty or missing', async () => {
    const kept = await rollbackFor('0.7.0').keepCurrent('0.8.0');
    await rm(appRoot, { recursive: true, force: true });
    await restoreInto(kept.dir, appRoot, null, {
      fs,
      alive: () => false,
      sleep: () => Promise.resolve(),
    });
    expect(await readFile(join(appRoot, 'resources', 'app.asar'), 'utf8')).toBe('asar 0.7.0');
  });

  it('waits for the newer version to close, and gives up when it never does', async () => {
    const kept = await rollbackFor('0.7.0').keepCurrent('0.8.0');
    let polls = 0;
    await restoreInto(kept.dir, appRoot, 42, {
      fs,
      alive: () => ++polls < 3,
      sleep: () => Promise.resolve(),
    });
    expect(polls).toBeGreaterThanOrEqual(3);
    await expect(
      restoreInto(kept.dir, appRoot, 42, { fs, alive: () => true, sleep: () => Promise.resolve() }),
    ).rejects.toThrow(/did not close/);
  });

  it('leaves the installed version alone when it cannot be moved', async () => {
    const kept = await rollbackFor('0.7.0').keepCurrent('0.8.0');
    await installVersion('0.8.0');
    const locked: RollbackFs = {
      ...fs,
      rename: (a, b) => (a === appRoot ? Promise.reject(new Error('EBUSY')) : fs.rename(a, b)),
    };
    await expect(
      restoreInto(kept.dir, appRoot, null, {
        fs: locked,
        alive: () => false,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/in use/);
    expect(await readFile(join(appRoot, 'Stratlas.exe'), 'utf8')).toBe('exe 0.8.0');
    expect(existsSync(`${appRoot}.restoring`)).toBe(false);
  });
});

describe('helpers', () => {
  it('parses the restore arguments', () => {
    expect(
      restoreArgs([
        'x.exe',
        '--stratlas-restore-into=C:\\P\\Stratlas',
        '--stratlas-restore-wait=77',
        '--stratlas-restore-from=0.8.0',
      ]),
    ).toEqual({ into: 'C:\\P\\Stratlas', waitPid: 77, from: '0.8.0' });
    expect(restoreArgs(['x.exe'])).toBeNull();
  });

  it('finds the install location', () => {
    expect(
      installOf('C:/P/Stratlas/Stratlas.exe', 'win32', {
        packaged: true,
        store: false,
        portable: false,
      }),
    ).toEqual({
      appRoot: 'C:/P/Stratlas',
      exe: 'Stratlas.exe',
    });
    expect(
      installOf('/Applications/Stratlas.app/Contents/MacOS/Stratlas', 'darwin', {
        packaged: true,
        store: false,
        portable: false,
      }),
    ).toEqual({
      appRoot: '/Applications/Stratlas.app',
      exe: join('Contents', 'MacOS', 'Stratlas'),
    });
    expect(
      installOf('/Volumes/Stratlas/Stratlas.app/Contents/MacOS/Stratlas', 'darwin', {
        packaged: true,
        store: false,
        portable: false,
      }),
    ).toEqual({ unavailable: expect.stringMatching(/Applications/) as unknown });
    expect(
      installOf('C:/x.exe', 'win32', { packaged: true, store: true, portable: false }),
    ).toHaveProperty('unavailable');
  });

  it('knows a kept copy from the installed app', () => {
    expect(isKeptCopy(join(updates, 'previous', '0.7.0', 'Stratlas.exe'), updates)).toBe(true);
    expect(isKeptCopy(join(appRoot, 'Stratlas.exe'), updates)).toBe(false);
  });
});
