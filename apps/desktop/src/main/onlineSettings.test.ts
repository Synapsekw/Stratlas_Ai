import { Settings } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOnlineSettingsStore, onlineSettingsPath } from './onlineSettings';

describe('the online satellite switch (userData online.json)', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-online-'));
    file = onlineSettingsPath(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lives in its own file, not in settings.json', () => {
    expect(file).toBe(join(dir, 'online.json'));
    for (const key of Object.keys(Settings.shape))
      expect(key.toLowerCase()).not.toContain('online');
  });

  it('is off when there is no file, and off before the file is read', async () => {
    await writeFile(file, JSON.stringify({ schema: 'aio.online-settings/1', satellite: true }));
    const store = createOnlineSettingsStore(file);
    // the gate may ask before the file is read: off until then
    expect(store.satellite()).toBe(false);
    await store.load();
    expect(store.satellite()).toBe(true);

    const fresh = createOnlineSettingsStore(join(dir, 'none.json'));
    expect(await fresh.get()).toBe(false);
    expect(fresh.satellite()).toBe(false);
  });

  it('writes the switch and reads it back', async () => {
    const store = createOnlineSettingsStore(file);
    expect(await store.set(true)).toEqual({ ok: true, satellite: true });
    expect(store.satellite()).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.online-settings/1',
      satellite: true,
    });
    expect(await createOnlineSettingsStore(file).get()).toBe(true);
    expect(await store.set(false)).toEqual({ ok: true, satellite: false });
    expect(await createOnlineSettingsStore(file).get()).toBe(false);
  });

  it('on counts once it is saved; off counts at once', async () => {
    const store = createOnlineSettingsStore(file);
    const on = store.set(true);
    expect(store.satellite()).toBe(false);
    await on;
    expect(store.satellite()).toBe(true);
    const off = store.set(false);
    expect(store.satellite()).toBe(false);
    await off;
    expect(store.satellite()).toBe(false);
  });

  it('a quick on then off ends off, also while the on is still being written', async () => {
    const store = createOnlineSettingsStore(file);
    const on = store.set(true);
    const off = store.set(false);
    await on;
    // the write of "on" finished, but the person has since said off
    expect(store.satellite()).toBe(false);
    await off;
    expect(store.satellite()).toBe(false);
    expect(await createOnlineSettingsStore(file).get()).toBe(false);
  });

  it('a switch that cannot be saved does not turn it on', async () => {
    // the folder of the file is itself a file: nothing can be written there
    await writeFile(join(dir, 'blocker'), 'x');
    const store = createOnlineSettingsStore(join(dir, 'blocker', 'online.json'));
    const r = await store.set(true);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('The online satellite setting was not saved');
    expect(store.satellite()).toBe(false);
  });

  it('keeps fields a newer build of the same version added', async () => {
    await writeFile(file, JSON.stringify({ schema: 'aio.online-settings/1', later: 1 }));
    const store = createOnlineSettingsStore(file);
    expect(await store.get()).toBe(false);
    await store.set(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.online-settings/1',
      later: 1,
      satellite: true,
    });
  });

  it('reads a file from a newer version as off and never overwrites it', async () => {
    const newer = JSON.stringify({ schema: 'aio.online-settings/2', satellite: true });
    await writeFile(file, newer);
    const store = createOnlineSettingsStore(file);
    expect(await store.get()).toBe(false);
    const r = await store.set(true);
    expect(r.ok).toBe(false);
    expect(store.satellite()).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('reads a broken or foreign file as off', async () => {
    await writeFile(file, '{ not json');
    expect(await createOnlineSettingsStore(file).get()).toBe(false);
    await writeFile(file, JSON.stringify({ satellite: true }));
    expect(await createOnlineSettingsStore(file).get()).toBe(false);
    await writeFile(file, JSON.stringify({ schema: 'aio.online-settings/1', satellite: 'yes' }));
    expect(await createOnlineSettingsStore(file).get()).toBe(false);
  });
});
