import { describe, expect, it } from 'vitest';
import { mapSourceRows, masterSwitch } from './mapSourcesView';

describe('Settings, Map sources', () => {
  it('lists Esri, Mapbox and Sentinel-2 with what each needs', () => {
    const rows = mapSourceRows({ esri: false, mapbox: false });
    expect(rows.map((r) => [r.provider, r.keyProvider, r.status])).toEqual([
      ['esri', 'esri', 'mapSources.status.keyless'],
      ['mapbox', 'mapbox', 'mapSources.status.noKey'],
      ['eox', null, 'mapSources.status.keyless'],
    ]);
    expect(rows.map((r) => r.terms)).toEqual([
      'mapSources.terms.esri',
      'mapSources.terms.mapbox',
      'mapSources.terms.eox',
    ]);
  });

  it('says when a key is saved', () => {
    const rows = mapSourceRows({ esri: true, mapbox: true });
    expect(rows.slice(0, 2).map((r) => [r.status, r.hasKey])).toEqual([
      ['mapSources.status.saved', true],
      ['mapSources.status.saved', true],
    ]);
  });

  it('the master switch cannot be switched on offline-only, but can always be switched off', () => {
    expect(masterSwitch(false, false)).toEqual({
      checked: false,
      disabled: false,
      help: 'mapSources.master.help',
    });
    expect(masterSwitch(false, true)).toEqual({
      checked: false,
      disabled: true,
      help: 'mapSources.offlineOnly',
    });
    expect(masterSwitch(true, true).disabled).toBe(false);
  });
});
