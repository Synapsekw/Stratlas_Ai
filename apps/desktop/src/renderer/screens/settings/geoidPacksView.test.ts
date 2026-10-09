import { describe, expect, it } from 'vitest';
import { geoidImportRequest, isGlobalGeoid, regionText, verticalText } from './geoidPacksView';

describe('geoid packs view', () => {
  it('reads a region and a vertical datum', () => {
    expect(regionText([-180, -90, 180, 90])).toBe('Worldwide');
    expect(regionText([112.5, -44, 154, -9])).toBe('112.5°E to 154°E, 44°S to 9°S');
    expect(regionText([-8.75, 49.5, 2.123, 61])).toBe('8.75°W to 2.12°E, 49.5°N to 61°N');
    expect(verticalText({ verticalEpsg: 5711 })).toBe('EPSG 5711');
    expect(verticalText({})).toBe('Not stated');
  });

  it('keeps the global grids and lets any other pack go', () => {
    expect(isGlobalGeoid({ id: 'egm96' })).toBe(true);
    expect(isGlobalGeoid({ id: 'EGM2008' })).toBe(true);
    expect(isGlobalGeoid({ id: 'AUSGeoid2020' })).toBe(false);
  });

  it('asks for a name, a licence and an attribution, and reads an EPSG code', () => {
    const base = {
      path: 'C:/grids/site.tif',
      name: ' Site geoid ',
      licence: 'CC0-1.0',
      attribution: 'Synthetic',
      verticalEpsg: '',
    };
    expect(geoidImportRequest(base)).toEqual({
      ok: true,
      request: {
        path: 'C:/grids/site.tif',
        name: 'Site geoid',
        licence: 'CC0-1.0',
        attribution: 'Synthetic',
      },
    });
    const r = geoidImportRequest({ ...base, verticalEpsg: 'EPSG:5711' });
    expect(r.ok && r.request.verticalEpsg).toBe(5711);
    expect(geoidImportRequest({ ...base, verticalEpsg: '57.1' })).toMatchObject({ ok: false });
    expect(geoidImportRequest({ ...base, name: ' ' })).toMatchObject({ ok: false });
    expect(geoidImportRequest({ ...base, licence: '' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('licence') as unknown,
    });
    expect(geoidImportRequest({ ...base, attribution: '' })).toMatchObject({ ok: false });
  });
});
