import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSettingsStore, defaultDataRoot, defaultSettings } from './settings';

describe('defaultDataRoot', () => {
  const base = { platform: 'win32', documents: 'C:\\Users\\me\\Documents', exists: () => false };

  it('prefers the STRATLAS_DATA environment variable', () => {
    expect(defaultDataRoot({ ...base, env: { STRATLAS_DATA: 'D:\\Data' } })).toBe('D:\\Data');
  });

  it('uses E:\\Stratlas Data on Windows when it exists', () => {
    expect(defaultDataRoot({ ...base, env: {}, exists: (p) => p === 'E:\\Stratlas Data' })).toBe(
      'E:\\Stratlas Data',
    );
  });

  it('falls back to Documents/Stratlas Data', () => {
    expect(defaultDataRoot({ ...base, env: {} })).toBe(join(base.documents, 'Stratlas Data'));
  });

  it('ignores E:\\ on other platforms', () => {
    expect(
      defaultDataRoot({
        platform: 'darwin',
        documents: '/Users/me/Documents',
        env: {},
        exists: () => true,
      }),
    ).toBe(join('/Users/me/Documents', 'Stratlas Data'));
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

  it('exposes a synchronous snapshot after the first read', async () => {
    const store = createSettingsStore(file, defaults);
    await store.set({ cloudAi: true });
    expect(store.current().cloudAi).toBe(true);
  });
});
