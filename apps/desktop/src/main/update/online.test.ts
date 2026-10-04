import { describe, expect, it } from 'vitest';
import { createOnlineUpdater, type UpdaterLike } from './online';

/** Asymmetric matcher typed as unknown, so object literals stay type-safe. */
const matching = (re: RegExp): unknown => expect.stringMatching(re);

function fakeUpdater(version: string | null) {
  const log: string[] = [];
  const u: UpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    setFeedURL: (o) => {
      log.push(`feed ${o.provider} ${o.url}`);
    },
    checkForUpdates: () => {
      log.push('check');
      return Promise.resolve(version === null ? null : { updateInfo: { version } });
    },
    downloadUpdate: () => {
      log.push('download');
      return Promise.resolve([]);
    },
    quitAndInstall: () => {
      log.push('install');
    },
  };
  return { u, log };
}

const on = { offlineOnly: false, updateCheck: true, updateUrl: 'https://updates.example.com/app/' };

function make(settings: Partial<typeof on>, version: string | null = '0.2.0') {
  const { u, log } = fakeUpdater(version);
  let loads = 0;
  const updater = createOnlineUpdater({
    settings: () => ({ ...on, ...settings }),
    currentVersion: '0.1.0',
    load: () => {
      loads++;
      return Promise.resolve(u);
    },
  });
  return { updater, u, log, loads: () => loads };
}

describe('online update check', () => {
  it('never loads the updater when offline-only, switched off or without an address', async () => {
    for (const s of [{ offlineOnly: true }, { updateCheck: false }, { updateUrl: '' }]) {
      const { updater, loads } = make(s);
      const r = await updater.check();
      expect(r.ok).toBe(false);
      expect(loads()).toBe(0);
    }
    expect((await make({ offlineOnly: true }).updater.check()) as { error: string }).toMatchObject({
      error: matching(/offline-only/),
    });
  });

  it('checks the generic feed without downloading', async () => {
    const { updater, u, log } = make({});
    expect(await updater.check()).toEqual({ ok: true, available: true, version: '0.2.0' });
    expect(log).toEqual(['feed generic https://updates.example.com/app/', 'check']);
    expect(u.autoDownload).toBe(false);
    expect(u.autoInstallOnAppQuit).toBe(false);
  });

  it('says when the app is up to date', async () => {
    expect(await make({}, '0.1.0').updater.check()).toEqual({
      ok: true,
      available: false,
      version: '0.1.0',
    });
  });

  it('explains that development builds do not update', async () => {
    expect(await make({}, null).updater.check()).toMatchObject({
      ok: false,
      error: matching(/installed app/),
    });
  });

  it('downloads and installs only after a check found a newer version', async () => {
    const fresh = make({});
    expect(await fresh.updater.downloadAndInstall()).toMatchObject({ ok: false });
    await fresh.updater.check();
    expect(await fresh.updater.downloadAndInstall()).toEqual({ ok: true });
    expect(fresh.log.slice(-2)).toEqual(['download', 'install']);
  });
});
