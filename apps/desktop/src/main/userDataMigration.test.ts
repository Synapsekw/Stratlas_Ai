import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATION_MARKER, migrateLegacyUserData } from './userDataMigration';

let appData = '';
let legacy = '';
let userData = '';

beforeEach(async () => {
  appData = await mkdtemp(join(tmpdir(), 'aio-userdata-'));
  legacy = join(appData, 'Stratlas');
  userData = join(appData, 'Quadrion AI');
  await mkdir(join(legacy, 'Local Storage', 'leveldb'), { recursive: true });
  await mkdir(join(legacy, 'GPUCache'), { recursive: true });
  await writeFile(join(legacy, 'settings.json'), '{"dataRoot":"E:\\\\Stratlas Data"}');
  await writeFile(join(legacy, 'library.json'), '{"projects":[]}');
  await writeFile(join(legacy, 'Local Storage', 'leveldb', '000003.log'), 'stratlas.author');
  await writeFile(join(legacy, 'GPUCache', 'data_0'), 'cache');
});

afterEach(async () => {
  await rm(appData, { recursive: true, force: true });
});

const run = (o: Partial<Parameters<typeof migrateLegacyUserData>[0]> = {}) =>
  migrateLegacyUserData({
    userData,
    appData,
    packaged: true,
    overridden: false,
    now: new Date('2026-10-07T12:00:00Z'),
    ...o,
  });

describe('migrateLegacyUserData', () => {
  it('copies the Stratlas folder once, keeps the original and writes a marker', async () => {
    const r = run();
    expect(r).toMatchObject({ kind: 'copied', from: legacy, failed: [] });
    if (r.kind === 'copied')
      expect(r.copied.sort()).toEqual(['Local Storage', 'library.json', 'settings.json']);
    expect(await readFile(join(userData, 'settings.json'), 'utf8')).toContain('Stratlas Data');
    expect(existsSync(join(userData, 'Local Storage', 'leveldb', '000003.log'))).toBe(true);
    // Chromium caches are not carried over
    expect(existsSync(join(userData, 'GPUCache'))).toBe(false);
    // the old folder is untouched
    expect(existsSync(join(legacy, 'settings.json'))).toBe(true);
    expect(existsSync(join(legacy, 'GPUCache', 'data_0'))).toBe(true);
    const marker = JSON.parse(readFileSync(join(userData, MIGRATION_MARKER), 'utf8')) as {
      from: string;
      at: string;
    };
    expect(marker).toMatchObject({ from: legacy, at: '2026-10-07T12:00:00.000Z' });
  });

  it('copies only once, even when settings are removed later', async () => {
    run();
    await rm(join(userData, 'settings.json'));
    expect(run()).toEqual({ kind: 'skipped', reason: 'done' });
    expect(existsSync(join(userData, 'settings.json'))).toBe(false);
  });

  it('never overwrites a new folder that already has settings', async () => {
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, 'settings.json'), '{"theme":"light"}');
    expect(run()).toEqual({ kind: 'skipped', reason: 'has-settings' });
    expect(await readFile(join(userData, 'settings.json'), 'utf8')).toBe('{"theme":"light"}');
    expect(existsSync(join(userData, 'library.json'))).toBe(false);
  });

  it('does nothing for an isolated profile, a development run, or without an old folder', async () => {
    expect(run({ overridden: true })).toEqual({ kind: 'skipped', reason: 'override' });
    expect(run({ packaged: false })).toEqual({ kind: 'skipped', reason: 'not-packaged' });
    await rm(legacy, { recursive: true });
    expect(run()).toEqual({ kind: 'skipped', reason: 'no-legacy' });
    expect(existsSync(userData)).toBe(false);
  });

  it('carries on past an entry it cannot copy', () => {
    const written: string[] = [];
    const r = migrateLegacyUserData({
      userData: 'U',
      appData: 'A',
      packaged: true,
      overridden: false,
      fs: {
        exists: (p) => p === join('A', 'Stratlas'),
        list: () => ['locked.db', 'settings.json'],
        mkdir: () => undefined,
        copy: (from) => {
          if (from.endsWith('locked.db')) throw new Error('EBUSY');
        },
        write: (file) => written.push(file),
      },
    });
    expect(r).toMatchObject({ kind: 'copied', copied: ['settings.json'], failed: ['locked.db'] });
    expect(written).toEqual([join('U', MIGRATION_MARKER)]);
  });
});
