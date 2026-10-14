/** The rows of Settings, Map sources (plan 2026-10-14-satellite-providers), as data. */
import type { MapKeyProvider, MapKeysStatus, OnlineProvider } from '@aio/schema';
import type { MessageKey } from '@aio/ui';

export interface SourceRow {
  provider: OnlineProvider;
  /** The vault account a key goes to, or null for a provider that takes none. */
  keyProvider: MapKeyProvider | null;
  name: MessageKey;
  terms: MessageKey;
  status: MessageKey;
  hasKey: boolean;
}

export function mapSourceRows(keys: MapKeysStatus): SourceRow[] {
  return [
    {
      provider: 'esri',
      keyProvider: 'esri',
      name: 'mapSources.provider.esri',
      terms: 'mapSources.terms.esri',
      status: keys.esri ? 'mapSources.status.saved' : 'mapSources.status.keyless',
      hasKey: keys.esri,
    },
    {
      provider: 'mapbox',
      keyProvider: 'mapbox',
      name: 'mapSources.provider.mapbox',
      terms: 'mapSources.terms.mapbox',
      status: keys.mapbox ? 'mapSources.status.saved' : 'mapSources.status.noKey',
      hasKey: keys.mapbox,
    },
    {
      provider: 'eox',
      keyProvider: null,
      name: 'mapSources.provider.eox',
      terms: 'mapSources.terms.eox',
      status: 'mapSources.status.keyless',
      hasKey: false,
    },
  ];
}

export function masterSwitch(
  enabled: boolean,
  offlineOnly: boolean,
): { checked: boolean; disabled: boolean; help: MessageKey } {
  return {
    checked: enabled,
    // offline-only: it cannot be switched on (it can still be switched off)
    disabled: offlineOnly && !enabled,
    help: offlineOnly ? 'mapSources.offlineOnly' : 'mapSources.master.help',
  };
}
