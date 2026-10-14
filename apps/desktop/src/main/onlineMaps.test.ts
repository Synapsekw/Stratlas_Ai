import type { MapKeyProvider, OnlineSourceId } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { collectHandlers } from './notYet';
import { createMapKeys, PROBE_SOURCE, registerMapKeysIpc } from './onlineMaps';
import { MAPBOX_FEEDBACK_URL } from './onlineUpstream';
import type { ProbeResult } from './onlineTiles';

function fakeVault() {
  const store = new Map<MapKeyProvider, string>();
  const reads: MapKeyProvider[] = [];
  return {
    store,
    reads,
    setMapKey: vi.fn((p: MapKeyProvider, k: string) => {
      store.set(p, k);
      return Promise.resolve({ ok: true });
    }),
    getMapKey: (p: MapKeyProvider) => {
      reads.push(p);
      return Promise.resolve(store.get(p) ?? null);
    },
    hasMapKey: (p: MapKeyProvider) => Promise.resolve(store.has(p)),
    clearMapKey: (p: MapKeyProvider) => {
      store.delete(p);
      return Promise.resolve({ ok: true });
    },
  };
}

function setup(answer: ProbeResult = 'ok') {
  const vault = fakeVault();
  const keys = createMapKeys(vault);
  const probes: { id: OnlineSourceId; key: string }[] = [];
  const tiles = {
    probe: (id: OnlineSourceId, key: string) => {
      probes.push({ id, key });
      return Promise.resolve(answer);
    },
  };
  const opened: string[] = [];
  const ipc = collectHandlers((handle) => {
    registerMapKeysIpc({
      handle,
      keys,
      tiles,
      openExternal: (url) => {
        opened.push(url);
      },
    });
  });
  return { vault, keys, probes, ipc, opened };
}

describe('map keys over IPC', () => {
  it('answers its channels', () => {
    expect(setup().ipc.channels()).toEqual([
      'mapKeys:clear',
      'mapKeys:set',
      'mapKeys:status',
      'mapKeys:test',
      'onlineTiles:openFeedback',
    ]);
  });

  it('checks a key with one tile through main before it is stored', async () => {
    const { ipc, probes, vault } = setup('ok');
    expect(
      await ipc.call('mapKeys:set', { provider: 'mapbox', key: '  pk.good-token-1  ' }),
    ).toEqual({ ok: true });
    expect(probes).toEqual([{ id: PROBE_SOURCE.mapbox, key: 'pk.good-token-1' }]);
    expect(vault.store.get('mapbox')).toBe('pk.good-token-1');
    expect(await ipc.call('mapKeys:status', {})).toEqual({ esri: false, mapbox: true });
  });

  it('never stores a key the provider refused, and says why', async () => {
    const { ipc, vault } = setup('refused');
    const r = await ipc.call('mapKeys:set', { provider: 'esri', key: 'AAPTbad-0123456789' });
    expect(r).toEqual({ ok: false, error: 'Esri refused the key. Check it and try again.' });
    expect(vault.setMapKey).not.toHaveBeenCalled();
  });

  it('says offline-only with its code, and that it could not reach the provider', async () => {
    expect(
      await setup('offline-only').ipc.call('mapKeys:set', {
        provider: 'mapbox',
        key: 'pk.x-123456',
      }),
    ).toEqual({
      ok: false,
      error: 'This workstation is offline-only, so the key cannot be checked.',
      code: 'offline-only',
    });
    // a saved key whose provider cannot be reached says so (not "no key")
    const s = setup('unreachable');
    s.vault.store.set('mapbox', 'pk.saved-key-123');
    const r = await s.ipc.call('mapKeys:test', { provider: 'mapbox' });
    expect(r).toEqual({
      ok: false,
      error:
        'Mapbox could not be reached, so the key could not be checked. Try again when this computer is online.',
    });
    const none = await setup('ok').ipc.call('mapKeys:test', { provider: 'mapbox' });
    expect(none).toEqual({ ok: false, error: 'No Mapbox key is saved.' });
  });

  it('tests the saved key, and removes it', async () => {
    const { ipc, probes } = setup('ok');
    await ipc.call('mapKeys:set', { provider: 'esri', key: 'AAPTkey-0123456789' });
    expect(await ipc.call('mapKeys:test', { provider: 'esri' })).toEqual({ ok: true });
    expect(probes.at(-1)).toEqual({ id: 'esri-world-imagery', key: 'AAPTkey-0123456789' });
    expect(await ipc.call('mapKeys:clear', { provider: 'esri' })).toEqual({ ok: true });
    expect(await ipc.call('mapKeys:status', {})).toEqual({ esri: false, mapbox: false });
  });

  it('status never carries a key, and the vault is read once per provider', async () => {
    const { ipc, vault } = setup('ok');
    vault.store.set('mapbox', 'pk.saved-before-1');
    const status = await ipc.call('mapKeys:status', {});
    expect(JSON.stringify(status)).not.toContain('pk.');
    await ipc.call('mapKeys:status', {});
    expect(vault.reads.filter((p) => p === 'mapbox')).toHaveLength(1);
  });

  it('refuses a request that is not a key before asking anyone', async () => {
    const { ipc, probes } = setup('ok');
    await expect(ipc.call('mapKeys:set', { provider: 'mapbox', key: 'short' })).rejects.toThrow();
    expect(probes).toEqual([]);
  });

  it('refuses an empty or blank key before probing, on set and on test', async () => {
    const { ipc, probes, vault } = setup('ok');
    // the schema asks for 8 characters; blanks of that length pass it and are still no key
    expect(await ipc.call('mapKeys:set', { provider: 'esri', key: '          ' })).toEqual({
      ok: false,
      error: 'That is not an Esri key.',
    });
    expect(await ipc.call('mapKeys:set', { provider: 'mapbox', key: '          ' })).toEqual({
      ok: false,
      error: 'That is not a Mapbox key.',
    });
    vault.store.set('esri', '   ');
    expect(await ipc.call('mapKeys:test', { provider: 'esri' })).toEqual({
      ok: false,
      error: 'No Esri key is saved.',
    });
    expect(probes).toEqual([]);
  });

  it('keeps a key cache that set and clear invalidate', async () => {
    const { ipc, keys, vault } = setup('ok');
    vault.store.set('mapbox', 'pk.first-key-123');
    expect(await keys.get('mapbox')).toBe('pk.first-key-123');
    expect(await keys.get('mapbox')).toBe('pk.first-key-123');
    expect(vault.reads).toEqual(['mapbox']);
    await ipc.call('mapKeys:set', { provider: 'mapbox', key: 'pk.second-key-123' });
    expect(await keys.get('mapbox')).toBe('pk.second-key-123');
    await ipc.call('mapKeys:clear', { provider: 'mapbox' });
    expect(await keys.get('mapbox')).toBeNull();
  });

  it('does not trust the cache after a clear that failed', async () => {
    const vault = fakeVault();
    vault.clearMapKey = () => Promise.resolve({ ok: false });
    vault.store.set('esri', 'AAPTkey-0123456789');
    const keys = createMapKeys(vault);
    expect(await keys.get('esri')).toBe('AAPTkey-0123456789');
    expect(await keys.clear('esri')).toEqual({ ok: false });
    expect(await keys.get('esri')).toBe('AAPTkey-0123456789');
    expect(vault.reads).toEqual(['esri', 'esri']);
  });

  it('opens the fixed Mapbox feedback page and nothing the renderer sends', async () => {
    const { ipc, opened } = setup('ok');
    expect(await ipc.call('onlineTiles:openFeedback', { provider: 'mapbox' })).toEqual({});
    expect(opened).toEqual([MAPBOX_FEEDBACK_URL]);
    expect(MAPBOX_FEEDBACK_URL).toBe('https://apps.mapbox.com/feedback/');
    await expect(
      ipc.call('onlineTiles:openFeedback', {
        provider: 'mapbox',
        url: 'https://evil.example',
      } as never),
    ).rejects.toThrow();
    expect(opened).toHaveLength(1);
  });
});
