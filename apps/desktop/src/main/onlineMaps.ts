/**
 * Map keys (ADR 0007, amendment of 14 Oct 2026): kept per computer in the OS credential store
 * (`keys.ts`, accounts `map:esri` and `map:mapbox`), read once into memory for the tile proxy
 * (so a tile never waits on the synchronous OS call), and checked with one tile through the same
 * proxy before they are stored. The renderer learns only whether a key is present.
 */
import type { IpcResponse, MapKeyProvider, MapKeysStatus, OnlineSourceId } from '@aio/schema';
import { registerSecret } from './diagnostics/redact';
import type { KeyVault } from './keys';
import type { Handle } from './notYet';
import type { OnlineTiles, ProbeResult } from './onlineTiles';
import { MAPBOX_FEEDBACK_URL } from './onlineUpstream';

/** The tile a key check asks for: a source each kind of key must be able to draw. */
export const PROBE_SOURCE: Record<MapKeyProvider, OnlineSourceId> = {
  esri: 'esri-world-imagery',
  mapbox: 'mapbox-streets',
};

const NAME: Record<MapKeyProvider, string> = { esri: 'Esri', mapbox: 'Mapbox' };
/** The name with its article, for "That is not an Esri key." */
const A_NAME: Record<MapKeyProvider, string> = { esri: 'an Esri', mapbox: 'a Mapbox' };

export type MapKeyVault = Pick<KeyVault, 'setMapKey' | 'getMapKey' | 'clearMapKey'>;

export function createMapKeys(vault: MapKeyVault) {
  const known = new Map<MapKeyProvider, string | null>();
  async function get(provider: MapKeyProvider): Promise<string | null> {
    if (known.has(provider)) return known.get(provider) ?? null;
    const raw = await vault.getMapKey(provider);
    // a blank value is no key
    const key = raw !== null && raw.trim() !== '' ? raw : null;
    // a key the app has seen is redacted from every log line and diagnostics bundle
    registerSecret(key);
    known.set(provider, key);
    return key;
  }
  return {
    get,
    async status(): Promise<MapKeysStatus> {
      return { esri: (await get('esri')) !== null, mapbox: (await get('mapbox')) !== null };
    },
    async store(provider: MapKeyProvider, key: string): Promise<{ ok: boolean }> {
      const r = await vault.setMapKey(provider, key);
      if (r.ok) registerSecret(key);
      // either way the next tile reads the vault again, so the cache never outlives a change
      known.delete(provider);
      return r;
    },
    async clear(provider: MapKeyProvider): Promise<{ ok: boolean }> {
      const r = await vault.clearMapKey(provider);
      known.delete(provider);
      return r;
    },
  };
}

export type MapKeys = ReturnType<typeof createMapKeys>;

function probeFailure(
  provider: MapKeyProvider,
  r: Exclude<ProbeResult, 'ok'>,
): Extract<IpcResponse<'mapKeys:set'>, { ok: false }> {
  switch (r) {
    case 'refused':
      return { ok: false, error: `${NAME[provider]} refused the key. Check it and try again.` };
    case 'unreachable':
      return {
        ok: false,
        error: `${NAME[provider]} could not be reached, so the key could not be checked. Try again when this computer is online.`,
      };
    case 'offline-only':
      return {
        ok: false,
        error: 'This workstation is offline-only, so the key cannot be checked.',
        code: 'offline-only',
      };
    case 'no-network':
      return { ok: false, error: 'There is no network in this run, so the key cannot be checked.' };
  }
}

export function registerMapKeysIpc({
  handle,
  keys,
  tiles,
  openExternal,
}: {
  handle: Handle;
  keys: MapKeys;
  tiles: Pick<OnlineTiles, 'probe'>;
  /** Opens an address in the person's browser (`shell.openExternal`). */
  openExternal: (url: string) => void;
}): void {
  handle('mapKeys:status', () => keys.status());
  handle('mapKeys:set', async ({ provider, key }) => {
    const trimmed = key.trim();
    if (trimmed.length < 8) return { ok: false, error: `That is not ${A_NAME[provider]} key.` };
    const r = await tiles.probe(PROBE_SOURCE[provider], trimmed);
    if (r !== 'ok') return probeFailure(provider, r);
    const saved = await keys.store(provider, trimmed);
    return saved.ok
      ? { ok: true }
      : { ok: false, error: "The key could not be kept in this computer's credential store." };
  });
  handle('mapKeys:test', async ({ provider }) => {
    const key = await keys.get(provider);
    if (!key) return { ok: false, error: `No ${NAME[provider]} key is saved.` };
    const r = await tiles.probe(PROBE_SOURCE[provider], key);
    return r === 'ok' ? { ok: true } : probeFailure(provider, r);
  });
  handle('mapKeys:clear', async ({ provider }) => {
    const r = await keys.clear(provider);
    return r.ok
      ? { ok: true }
      : { ok: false, error: "The key could not be removed from this computer's credential store." };
  });
  handle('onlineTiles:openFeedback', () => {
    openExternal(MAPBOX_FEEDBACK_URL);
    return {};
  });
}
