import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_SECTIONS_08,
  createSettingsStore,
  defaultDataRoot,
  defaultSettings,
} from './settings';

describe('defaultDataRoot', () => {
  const base = { platform: 'win32', documents: 'C:\\Users\\me\\Documents', exists: () => false };

  it('prefers the QUADRION_DATA environment variable', () => {
    expect(defaultDataRoot({ ...base, env: { QUADRION_DATA: 'D:\\Data' } })).toBe('D:\\Data');
  });

  it('uses E:\\Stratlas Data on Windows when it exists', () => {
    expect(defaultDataRoot({ ...base, env: {}, exists: (p) => p === 'E:\\Stratlas Data' })).toBe(
      'E:\\Stratlas Data',
    );
  });

  it('still reads the legacy STRATLAS_DATA variable', () => {
    expect(defaultDataRoot({ ...base, env: { STRATLAS_DATA: 'D:\\Old' } })).toBe('D:\\Old');
  });

  it('falls back to Documents/Quadrion AI Data for a new install', () => {
    expect(defaultDataRoot({ ...base, env: {} })).toBe(join(base.documents, 'Quadrion AI Data'));
  });

  it('keeps using Documents/Stratlas Data from before the rename when it exists', () => {
    const legacy = join(base.documents, 'Stratlas Data');
    expect(defaultDataRoot({ ...base, env: {}, exists: (p) => p === legacy })).toBe(legacy);
  });

  it('ignores E:\\ on other platforms', () => {
    expect(
      defaultDataRoot({
        platform: 'darwin',
        documents: '/Users/me/Documents',
        env: {},
        exists: (p) => p === 'E:\\Stratlas Data',
      }),
    ).toBe(join('/Users/me/Documents', 'Quadrion AI Data'));
  });
});

describe('settings store', () => {
  let dir: string;
  let file: string;
  const defaults = defaultSettings('D:\\Data');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-settings-'));
    file = join(dir, 'settings.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has offline-first defaults', () => {
    expect(defaults.cloudAi).toBe(false);
    expect(defaults.theme).toBe('dark');
    expect(defaults.sidebarCollapsed).toBe(false);
    expect(defaults.dataRoot).toBe('D:\\Data');
    expect(defaults.routes.length).toBeGreaterThan(0);
    expect(defaults.direction).toBe('ltr');
    expect(defaults.offlineOnly).toBe(false);
    expect(defaults.updateCheck).toBe(false);
    expect(defaults.updateUrl).toBe('');
  });

  it('upgrades a settings file written before the platform settings existed', async () => {
    await writeFile(
      file,
      JSON.stringify({
        cloudAi: true,
        theme: 'light',
        sidebarCollapsed: true,
        dataRoot: 'X:/data',
      }),
    );
    const s = await createSettingsStore(file, defaults).get();
    expect(s.theme).toBe('light');
    expect(s.direction).toBe('ltr');
    expect(s.updateCheck).toBe(false);
  });

  it('returns defaults when no file exists', async () => {
    const store = createSettingsStore(file, defaults);
    expect(await store.get()).toEqual(defaults);
  });

  it('persists a partial update and reads it back', async () => {
    const store = createSettingsStore(file, defaults);
    const next = await store.set({ theme: 'light', cloudAi: true });
    expect(next.theme).toBe('light');
    expect(next.cloudAi).toBe(true);
    const again = createSettingsStore(file, defaults);
    expect(await again.get()).toEqual(next);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(next);
  });

  // agent-local e2e, flaky on Windows CI: settings:get answered while saves were still writing.
  it('reads what was asked for before the read, even while it is still being written', async () => {
    const store = createSettingsStore(file, defaults);
    await store.get();
    const writing = store.set({ cloudAi: true });
    const read = await store.get();
    expect(read.cloudAi).toBe(true);
    await writing;
  });

  // current() serves synchronous and per-request readers (offline-only, AI routes, the data
  // folder, the team cache): a change asked for must show there before it is written.
  describe('current() right after a change is asked for', () => {
    it('shows offline-only', async () => {
      const store = createSettingsStore(file, defaults);
      await store.get();
      const writing = store.set({ offlineOnly: true });
      expect(store.current().offlineOnly).toBe(true);
      await writing;
      expect(store.current().offlineOnly).toBe(true);
    });

    it('shows cloud AI, the routes and the local model', async () => {
      const store = createSettingsStore(file, defaults);
      await store.get();
      const localModel = {
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'fake',
        kind: 'ollama' as const,
      };
      const routes = [{ task: 'chat' as const, provider: 'local' as const, model: 'fake' }];
      const writing = store.set({ cloudAi: true });
      const next = store.set({ cloudAi: false, localModel, routes });
      expect(store.current()).toMatchObject({ cloudAi: false, localModel, routes });
      await Promise.all([writing, next]);
      expect(store.current()).toMatchObject({ cloudAi: false, localModel, routes });
    });

    it('shows the data folder', async () => {
      const store = createSettingsStore(file, defaults);
      await store.get();
      const writing = store.set({ dataRoot: join(dir, 'other') });
      expect(store.current().dataRoot).toBe(join(dir, 'other'));
      await writing;
    });

    it('shows the team cache size', async () => {
      const store = createSettingsStore(file, defaults);
      await store.get();
      const team = { autoSync: true, intervalMin: 15, blobCacheGb: 80 };
      const writing = store.set({ team });
      expect(store.current().team?.blobCacheGb).toBe(80);
      await writing;
    });

    it('drops a change that cannot be saved, and keeps one made by update()', async () => {
      const store = createSettingsStore(file, defaults);
      await store.get();
      const bad = store.set({ theme: 'neon' as never });
      const fine = store.set({ cloudAi: true });
      // the invalid one does not hide the valid one asked after it
      expect(store.current()).toMatchObject({ theme: defaults.theme, cloudAi: true });
      await fine;
      await expect(bad).rejects.toThrow();
      const logo = store.update(() => ({ reportBranding: { logo: 'logo-abc123.png' } }));
      const offline = store.set({ offlineOnly: true });
      await Promise.all([logo, offline]);
      expect(store.current()).toMatchObject({
        offlineOnly: true,
        reportBranding: { logo: 'logo-abc123.png' },
      });
    });
  });

  it('fills fields missing from an older file with defaults', async () => {
    await writeFile(file, JSON.stringify({ theme: 'light' }));
    const store = createSettingsStore(file, defaults);
    expect(await store.get()).toEqual({ ...defaults, theme: 'light' });
  });

  it('drops invalid fields and keeps the valid ones', async () => {
    await writeFile(file, JSON.stringify({ theme: 'purple', sidebarCollapsed: true }));
    const store = createSettingsStore(file, defaults);
    expect(await store.get()).toEqual({ ...defaults, sidebarCollapsed: true });
  });

  it('survives a corrupt file', async () => {
    await writeFile(file, '{ not json');
    const store = createSettingsStore(file, defaults);
    expect(await store.get()).toEqual(defaults);
  });

  it('treats undefined fields in a patch as not given', async () => {
    const store = createSettingsStore(file, defaults);
    const next = await store.set({ theme: undefined, sidebarCollapsed: true });
    expect(next).toEqual({ ...defaults, sidebarCollapsed: true });
  });

  it('keeps both of two updates made at the same time', async () => {
    const store = createSettingsStore(file, defaults);
    await Promise.all([store.set({ theme: 'light' }), store.set({ sidebarCollapsed: true })]);
    const again = createSettingsStore(file, defaults);
    expect(await again.get()).toEqual({ ...defaults, theme: 'light', sidebarCollapsed: true });
  });

  it('updates from the latest settings, after any save still being written', async () => {
    const store = createSettingsStore(file, defaults);
    const name = store.set({ reportBranding: { companyName: 'Synapse Solutions' } });
    const logo = store.update((s) => ({
      reportBranding: { ...s.reportBranding, logo: 'logo-a1b2c3.png' },
    }));
    await Promise.all([name, logo]);
    expect((await store.get()).reportBranding).toEqual({
      companyName: 'Synapse Solutions',
      logo: 'logo-a1b2c3.png',
    });
  });

  it('settles after every update asked for so far, failed or not', async () => {
    const store = createSettingsStore(file, defaults);
    void store.set({ cloudAi: true });
    await store.settled();
    expect(store.current().cloudAi).toBe(true);
    await expect(store.set({ theme: 'nope' as never })).rejects.toThrow();
    await expect(store.settled()).resolves.toBeUndefined();
  });

  it('exposes a synchronous snapshot after the first read', async () => {
    const store = createSettingsStore(file, defaults);
    await store.set({ cloudAi: true });
    expect(store.current().cloudAi).toBe(true);
  });
  // 0.8 reads `reportContents` with a strict schema over its eight section ids, so a section added
  // later (`audit`, `approvals`) would make an 0.8 build on the same machine drop every report
  // choice. The file keeps the later sections in `reportSectionsExtra`, which 0.8 ignores.
  describe('report sections an 0.8 build does not know', () => {
    it('are written outside reportContents and read back in', async () => {
      const store = createSettingsStore(file, defaults);
      const sections = { register: false, audit: false, approvals: true } as const;
      const next = await store.set({ reportContents: { sections, issuePages: 'none' } });
      expect(next.reportContents).toEqual({ sections, issuePages: 'none' });
      const disk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      expect(disk.reportContents).toEqual({ sections: { register: false }, issuePages: 'none' });
      expect(disk.reportSectionsExtra).toEqual({ audit: false, approvals: true });
      expect(await createSettingsStore(file, defaults).get()).toEqual(next);
    });

    it('leave reportContents without sections when only later ones are set', async () => {
      const store = createSettingsStore(file, defaults);
      await store.set({ reportContents: { sections: { audit: false } } });
      const disk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      expect(disk.reportContents).toEqual({});
      expect(disk.reportSectionsExtra).toEqual({ audit: false });
    });

    it('move a later section out of reportContents on the next save', async () => {
      await writeFile(
        file,
        JSON.stringify({ ...defaults, reportContents: { sections: { audit: false } } }),
      );
      const store = createSettingsStore(file, defaults);
      expect((await store.get()).reportContents).toEqual({ sections: { audit: false } });
      await store.set({ theme: 'light' });
      const disk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      expect(disk.reportContents).toEqual({});
      expect(disk.reportSectionsExtra).toEqual({ audit: false });
    });

    it('keep sections from a newer build, and drop values that are not on or off', async () => {
      await writeFile(
        file,
        JSON.stringify({
          ...defaults,
          reportSectionsExtra: { audit: false, signoffs2: true, approvals: 'yes' },
        }),
      );
      const store = createSettingsStore(file, defaults);
      expect((await store.get()).reportContents).toEqual({ sections: { audit: false } });
      await store.set({ theme: 'light' });
      const disk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      expect(disk.reportSectionsExtra).toEqual({ audit: false, signoffs2: true });
    });

    it('lists exactly the sections 0.8 knows', () => {
      expect(REPORT_SECTIONS_08).toEqual([
        'contents',
        'summary',
        'scope',
        'site',
        'statistics',
        'register',
        'issues',
        'appendices',
      ]);
    });
  });
});
