import { Settings } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOnlineSettingsStore, onlineSettingsPath } from './onlineSettings';

const OFF_ESRI = { enabled: false, source: 'esri-world-imagery' };

describe('online maps switch and source (userData online.json)', () => {
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

  it('is off before the file is read; a 0.11 file that was on keeps Sentinel-2', async () => {
    await writeFile(file, JSON.stringify({ schema: 'aio.online-settings/1', satellite: true }));
    const store = createOnlineSettingsStore(file);
    expect(store.current()).toEqual(OFF_ESRI);
    await store.load();
    expect(store.current()).toEqual({ enabled: true, source: 's2cloudless-2016' });
    expect(await createOnlineSettingsStore(join(dir, 'none.json')).get()).toEqual(OFF_ESRI);
  });

  it('writes the source with every change, so a file that says on never reads as Sentinel-2 by mistake', async () => {
    const store = createOnlineSettingsStore(file);
    expect(await store.set({ enabled: true })).toEqual({
      ok: true,
      enabled: true,
      source: 'esri-world-imagery',
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.online-settings/1',
      satellite: true,
      source: 'esri-world-imagery',
    });
    expect(await createOnlineSettingsStore(file).get()).toEqual({
      enabled: true,
      source: 'esri-world-imagery',
    });
  });

  it('changes the source alone and keeps the switch', async () => {
    const store = createOnlineSettingsStore(file);
    await store.set({ enabled: true });
    expect(await store.set({ source: 'mapbox-satellite' })).toEqual({
      ok: true,
      enabled: true,
      source: 'mapbox-satellite',
    });
    expect(store.current()).toEqual({ enabled: true, source: 'mapbox-satellite' });
  });

  it('on counts once it is saved; off counts at once', async () => {
    const store = createOnlineSettingsStore(file);
    const on = store.set({ enabled: true });
    expect(store.current().enabled).toBe(false);
    await on;
    expect(store.current().enabled).toBe(true);
    const off = store.set({ enabled: false });
    expect(store.current().enabled).toBe(false);
    await off;
    expect(store.current().enabled).toBe(false);
  });

  it('a quick on then off ends off, also while the on is still being written', async () => {
    const store = createOnlineSettingsStore(file);
    const on = store.set({ enabled: true });
    const off = store.set({ enabled: false });
    await on;
    expect(store.current().enabled).toBe(false);
    await off;
    expect((await createOnlineSettingsStore(file).get()).enabled).toBe(false);
  });

  it('a switch that cannot be saved does not turn it on', async () => {
    await writeFile(join(dir, 'blocker'), 'x');
    const store = createOnlineSettingsStore(join(dir, 'blocker', 'online.json'));
    const r = await store.set({ enabled: true });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('The online maps setting was not saved');
    expect(store.current().enabled).toBe(false);
  });

  it('keeps fields a newer build of the same version added', async () => {
    await writeFile(file, JSON.stringify({ schema: 'aio.online-settings/1', later: 1 }));
    const store = createOnlineSettingsStore(file);
    await store.set({ enabled: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schema: 'aio.online-settings/1',
      later: 1,
      satellite: true,
      source: 'esri-world-imagery',
    });
  });

  it('reads a file from a newer version as off and never overwrites it', async () => {
    const newer = JSON.stringify({ schema: 'aio.online-settings/2', satellite: true });
    await writeFile(file, newer);
    const store = createOnlineSettingsStore(file);
    expect(await store.get()).toEqual(OFF_ESRI);
    const r = await store.set({ enabled: true });
    expect(r.ok).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('reads a broken or foreign file as off', async () => {
    await writeFile(file, '{ not json');
    expect(await createOnlineSettingsStore(file).get()).toEqual(OFF_ESRI);
    await writeFile(file, JSON.stringify({ satellite: true }));
    expect(await createOnlineSettingsStore(file).get()).toEqual(OFF_ESRI);
    await writeFile(file, JSON.stringify({ schema: 'aio.online-settings/1', satellite: 'yes' }));
    expect(await createOnlineSettingsStore(file).get()).toEqual(OFF_ESRI);
    // an unknown source on a file that is on reads as absent: on, with Sentinel-2 as in 0.11
    await writeFile(
      file,
      JSON.stringify({ schema: 'aio.online-settings/1', satellite: true, source: 'custom-url' }),
    );
    expect(await createOnlineSettingsStore(file).get()).toEqual({
      enabled: true,
      source: 's2cloudless-2016',
    });
  });
});
