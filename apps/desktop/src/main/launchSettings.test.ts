import { Settings } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLaunchSettingsStore, launchSettingsPath } from './launchSettings';

describe('launch screen preference (userData launch.json)', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-launch-'));
    file = launchSettingsPath(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lives in its own file, not in settings.json', () => {
    expect(file).toBe(join(dir, 'launch.json'));
    expect(Object.keys(Settings.shape)).not.toContain('launchScreen');
  });

  it('is shown when there is no file yet', async () => {
    const store = createLaunchSettingsStore(file);
    expect(await store.get()).toEqual({
      ok: true,
      settings: { schema: 'aio.launch-settings/1' },
    });
  });

  it('writes the switch and reads it back', async () => {
    const store = createLaunchSettingsStore(file);
    expect(await store.set(false)).toEqual({
      ok: true,
      settings: { schema: 'aio.launch-settings/1', show: false },
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.launch-settings/1',
      show: false,
    });
    expect(await createLaunchSettingsStore(file).get()).toMatchObject({
      settings: { show: false },
    });
    await store.set(true);
    expect(await store.get()).toMatchObject({ settings: { show: true } });
  });

  it('keeps fields a newer build of the same version added', async () => {
    await writeFile(file, JSON.stringify({ schema: 'aio.launch-settings/1', later: 1 }));
    await createLaunchSettingsStore(file).set(false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.launch-settings/1',
      later: 1,
      show: false,
    });
  });

  it('reads a broken file as the defaults and repairs it on the next change', async () => {
    await writeFile(file, '{ not json');
    const store = createLaunchSettingsStore(file);
    expect(await store.get()).toMatchObject({ settings: { schema: 'aio.launch-settings/1' } });
    expect(await store.set(false)).toMatchObject({ ok: true });
  });

  it('never overwrites a file saved by a newer version', async () => {
    const newer = JSON.stringify({ schema: 'aio.launch-settings/2', show: false });
    await writeFile(file, newer);
    const store = createLaunchSettingsStore(file);
    expect(await store.get()).toEqual({
      ok: true,
      settings: { schema: 'aio.launch-settings/1' },
    });
    expect(await store.set(true)).toMatchObject({ ok: false });
    expect(await readFile(file, 'utf8')).toBe(newer);
  });
});
