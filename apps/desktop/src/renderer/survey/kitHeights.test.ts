// Volumetrics redesign A3: converted kit piles take real heights (the kit DSM of their date, else
// the date's prepared surface).
import type { MeasurementsFile, ProjectManifest, SitePoint, SurveyMeasurement } from '@aio/schema';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { kitDsmHeightAt, kitRepairHeights } from './kitHeights';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Yard',
  crs: { epsg: 32640 },
  origin: [1000, 2000, 50],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const points: SitePoint[] = [
  [1000, 2000, 0],
  [1004, 2000, 0],
  [1004, 1997, 0],
];

const kitPile = (id: string, epoch: string | null, pts = points): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: `Pile ${id}`,
  scope: { kind: 'site' },
  points: pts,
  items: [],
  results: [],
  ...(epoch
    ? {
        series: [
          {
            item: 'i1',
            status: 'ok',
            cutM3: 0,
            fillM3: 1,
            netM3: 1,
            totalM3: 1,
            areaM2: 1,
            areaCutM2: 0,
            areaFillM2: 0,
            areaUnchangedM2: 0,
            uncoveredM2: 0,
            fromLabel: 'kit',
            toLabel: epoch,
            deadbandM: 0,
            usedDeadband: false,
            cellM: 0.1,
            engine: 'ts',
            fingerprint: `kit:${id}:${epoch}`,
            computedAt: '2026-10-24T00:00:00.000Z',
            carried: { from: 'kit', base: 'plane', pile: id, epoch },
          },
        ],
      }
    : {}),
  origin: { kind: 'kit-pile', pile: id },
  createdAt: '2026-10-24T00:00:00.000Z',
});

const fileOf = (...measurements: SurveyMeasurement[]): MeasurementsFile => ({
  schema: 'aio.measurements/1',
  measurements,
});

const none = () => Promise.resolve(new Float64Array(points.length).fill(Number.NaN));

describe('kitRepairHeights', () => {
  it('DSM heights win over the prepared surface', async () => {
    const groundAt = vi.fn((_c: string, drawn: readonly SitePoint[]) =>
      Promise.resolve(new Float64Array(drawn.length).fill(70)),
    );
    const heights = await kitRepairHeights(fileOf(kitPile('P01', 'e2')), manifest, {
      dsm: (epoch, e) => (epoch === 'e2' ? 40 + (e - 1000) : null),
      groundAt,
      captureOfEpoch: () => 'c2',
    });
    expect(heights.get('P01')).toEqual([40, 44, 44]);
    expect(groundAt).not.toHaveBeenCalled();
  });

  it("a missing DSM falls back to the prepared surface of the epoch's capture", async () => {
    const groundAt = vi.fn((capture: string, drawn: readonly SitePoint[]) =>
      Promise.resolve(
        capture === 'c2' ? Float64Array.from(drawn, (_p, i) => 60 + i) : new Float64Array(0),
      ),
    );
    const heights = await kitRepairHeights(fileOf(kitPile('P01', 'e2')), manifest, {
      dsm: () => null,
      groundAt,
      captureOfEpoch: (epoch) => (epoch === 'e2' ? 'c2' : null),
    });
    expect(heights.get('P01')).toEqual([60, 61, 62]);
    expect(groundAt).toHaveBeenCalledWith('c2', points, manifest);
  });

  it('nothing found gives no entry', async () => {
    const heights = await kitRepairHeights(fileOf(kitPile('P01', 'e2')), manifest, {
      dsm: () => null,
      groundAt: none,
      captureOfEpoch: () => 'c2',
    });
    expect(heights.size).toBe(0);
  });

  it('a pile a person edited, or one repaired already, is left alone', async () => {
    const edited = kitPile('P01', 'e2', [[1000, 2000, 51], ...points.slice(1)]);
    const file = { ...fileOf(edited, kitPile('P02', 'e2')), kitHeightsRepaired: ['P02'] };
    const heights = await kitRepairHeights(file, manifest, {
      dsm: () => 52,
      groundAt: none,
      captureOfEpoch: () => 'c2',
    });
    expect(heights.size).toBe(0);
  });

  it('a pile with no carried figure takes the date of its outline', async () => {
    const heights = await kitRepairHeights(fileOf(kitPile('P01', null)), manifest, {
      dsm: (epoch) => (epoch === 'e3' ? 53 : null),
      groundAt: none,
      captureOfEpoch: () => null,
      epochOfPile: (pile) => (pile === 'P01' ? 'e3' : null),
    });
    expect(heights.get('P01')).toEqual([53, 53, 53]);
  });
});

/** A kit `data/dsm_<epoch>.js` of one height (m) over E 990..1020, N 1980..2010 at 1 m. */
function dsmScript(epoch: string, heightM: number): string {
  const w = 30;
  const h = 30;
  const cm = Math.round((heightM - 50) * 100);
  // row-wise deltas: the first cell of each row holds the value, the rest 0
  const d = new Int16Array(w * h);
  for (let y = 0; y < h; y++) d[y * w] = cm;
  const valid = new Uint8Array(Math.ceil((w * h) / 8)).fill(255);
  const b64 = (u: Uint8Array) => deflateSync(Buffer.from(u.buffer)).toString('base64');
  return `window.VS_DSM=window.VS_DSM||{};window.VS_DSM["${epoch}"]=${JSON.stringify({
    res: 1,
    w,
    h,
    x0: 990,
    y1: 2010,
    zoff: 50,
    z: b64(new Uint8Array(d.buffer)),
    valid: b64(valid),
  })};`;
}

describe('kitDsmHeightAt', () => {
  it('loads each epoch once from the project and gives null where there is no file', async () => {
    const fetchText = vi.fn((url: string) =>
      Promise.resolve(
        url === 'aio://project/p1/legacy/data/dsm_e2.js' ? dsmScript('e2', 52) : null,
      ),
    );
    const at = await kitDsmHeightAt('p1', ['e1', 'e2', 'e2'], fetchText);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(at('e2', 1002, 1999)).toBeCloseTo(52, 6);
    expect(at('e1', 1002, 1999)).toBeNull();
    expect(at('e9', 1002, 1999)).toBeNull();
    // outside the grid
    expect(at('e2', 5000, 1999)).toBeNull();
  });

  it('a file that will not read gives null heights, never a throw', async () => {
    const at = await kitDsmHeightAt('p1', ['e1'], () => Promise.resolve('not a kit script'));
    expect(at('e1', 1002, 1999)).toBeNull();
    const failing = await kitDsmHeightAt('p1', ['e1'], () => Promise.reject(new Error('offline')));
    expect(failing('e1', 1002, 1999)).toBeNull();
  });
});
