import { SiteCalibration } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseCatalogue } from './catalogue/search';
import { createSiteTransform, f64Table, sampleTable } from './siteTransform';

/** Fixtures written by PROJ (`python/tests/geodesy_synth.py`): tables and 1,000 PROJ answers. */
const FIXTURES = ['utm39n-qatar', 'stateplane-usft', 'calibrated-local'] as const;

const dir = (name: string) => new URL(`./__fixtures__/site/${name}/`, import.meta.url);
const bytes = (name: string, file: string) =>
  new Uint8Array(readFileSync(new URL(file, dir(name))));
const json = (name: string, file: string): unknown =>
  JSON.parse(readFileSync(new URL(file, dir(name)), 'utf8'));

interface Points {
  points: [number, number, number, number, number, number][];
}

function load(name: string) {
  const header = json(name, 'site-transform.json') as { geoidGrid?: unknown };
  return createSiteTransform(header, {
    grid: bytes(name, 'site-grid.f64'),
    ...(header.geoidGrid ? { geoidGrid: bytes(name, 'geoid-site.f64') } : {}),
  });
}

describe('site transform parity with PROJ (1 mm at 1,000 points per fixture)', () => {
  for (const name of FIXTURES) {
    it(name, () => {
      const t = load(name);
      const { points } = json(name, 'points.json') as Points;
      expect(points).toHaveLength(1000);
      let worstH = 0;
      let worstV = 0;
      for (const [e, n, z, se, sn, sz] of points) {
        const r = t.toSite(e, n, z);
        expect(r).not.toBeNull();
        if (r?.z == null) throw new Error('outside the tables');
        worstH = Math.max(worstH, Math.hypot(r.e - se, r.n - sn));
        worstV = Math.max(worstV, Math.abs(r.z - sz));
      }
      expect(worstH).toBeLessThan(0.001);
      expect(worstV).toBeLessThan(0.001);
    });
  }

  it('names what it was computed with', () => {
    const cal = load('calibrated-local').header;
    expect(cal.calibration).toBe('cal-synth');
    expect(cal.geoid).toBe('synth-geoid');
    expect(cal.fingerprint).toMatch(/^sha256:/);
    expect(load('stateplane-usft').header.to).toEqual({ epsg: 2240 });
  });

  it('uses proj4js for a pure projection PROJ checked at 25 points', () => {
    const header = json('stateplane-usft', 'site-transform.json') as {
      proj4?: string;
      grid?: unknown;
      geoidGrid?: unknown;
    };
    expect(header.proj4).toContain('+units=us-ft');
    // horizontal only: without its tables the readout comes from proj4js
    delete header.grid;
    delete header.geoidGrid;
    const cat = parseCatalogue(
      gunzipSync(readFileSync(new URL('./catalogue/epsg.json.gz', import.meta.url))).toString(
        'utf8',
      ),
    );
    const from = cat.entries.find((e) => e.code === 26916)?.proj4;
    const t = createSiteTransform(header, {}, from);
    const { points } = json('stateplane-usft', 'points.json') as Points;
    for (const [e, n, , se, sn] of points.slice(0, 200)) {
      const r = t.toSite(e, n);
      if (!r) throw new Error('no readout');
      expect(Math.hypot(r.e - se, r.n - sn)).toBeLessThan(0.001);
    }
  });
});

describe('tables', () => {
  const grid = {
    file: 't.f64',
    originX: 100,
    originY: 200,
    spacingM: 2,
    cols: 3,
    rows: 2,
    bands: 1,
  };
  const le = (vals: number[]) => {
    const b = new Uint8Array(vals.length * 8);
    const dv = new DataView(b.buffer);
    vals.forEach((v, i) => {
      dv.setFloat64(i * 8, v, true);
    });
    return b;
  };

  it('interpolates bilinearly from the lower-left cell, rows north', () => {
    const t = f64Table(grid, le([0, 2, 4, 10, 12, 14]));
    expect(sampleTable(t, 100, 200)).toBe(0);
    expect(sampleTable(t, 104, 202)).toBe(14);
    expect(sampleTable(t, 101, 201)).toBeCloseTo(6, 12);
    expect(sampleTable(t, 99.9, 200)).toBeNull();
    expect(sampleTable(t, 104.1, 200)).toBeNull();
  });

  it('refuses a table whose size does not match its header, and nodata', () => {
    expect(() => f64Table(grid, le([1, 2]))).toThrow('header says');
    const t = f64Table(grid, le([NaN, 2, 4, 10, 12, 14]));
    expect(sampleTable(t, 100.5, 200.5)).toBeNull();
    expect(sampleTable(t, 103, 201)).not.toBeNull();
  });
});

describe('a calibration as geo.calibration writes it', () => {
  it('parses as the SiteCalibration contract, a draft with residuals', () => {
    const raw = JSON.parse(
      readFileSync(new URL('./__fixtures__/site/calibration-jobxml.json', import.meta.url), 'utf8'),
    ) as unknown;
    const cal = SiteCalibration.parse(raw);
    expect(cal.appliedAt).toBeUndefined();
    expect(cal.pairs).toHaveLength(6);
    for (const p of cal.pairs) {
      expect(p.residualH).toBeGreaterThanOrEqual(0);
      expect(Math.abs((p.residualH ?? 0) - (p.controllerResidualH ?? 0))).toBeLessThan(0.001);
    }
  });
});
