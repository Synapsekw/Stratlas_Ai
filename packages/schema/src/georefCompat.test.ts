import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromCompatGeoreference, readGlbGeoref } from './georefCompat';

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/georef/compat.synthetic.json', import.meta.url), 'utf8'),
) as { model_to_source_enh_column_major: number[]; [key: string]: unknown };

describe('compat georeference', () => {
  it('maps the synthetic compat structure to aio.georef/1', () => {
    const r = fromCompatGeoreference(fixture);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.georef.crs).toEqual({ epsg: 32633 });
    expect(r.georef.anchor).toEqual([400000.125, 5600000.25, 12.5]);
    expect(r.georef.heading.status).toBe('assumed-grid');
    expect(r.georef.vertical).toEqual({ datum: 'unknown', status: 'unknown' });
    expect(r.georef.provenance.by).toBe('compat');
  });
  it('refuses axes other than east, up, south', () => {
    const bad = { ...fixture, model_axes: { x: 'grid east', y: 'grid north', z: 'up' } };
    const r = fromCompatGeoreference(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('axes');
  });
  it('refuses a non-finite matrix', () => {
    const bad = {
      ...fixture,
      model_to_source_enh_column_major: [
        ...fixture.model_to_source_enh_column_major.slice(0, 15),
        null,
      ],
    };
    expect(fromCompatGeoreference(bad).ok).toBe(false);
  });
  it('reads aio first, then compat, else absent; foreign extras are absent', () => {
    expect(readGlbGeoref({ generator: 'x', somethingElse: 1 }).kind).toBe('absent');
    expect(readGlbGeoref(undefined).kind).toBe('absent');
    expect(readGlbGeoref({ georeference: fixture }).kind).toBe('compat');
    expect(readGlbGeoref({ aioGeoref: { schema: 'aio.georef/1' } }).kind).toBe('invalid');
  });
});
