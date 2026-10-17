import { describe, expect, it } from 'vitest';
import { evaluatePoint, margins, subcarrierCount, type MarginSettings } from './budget';
import { parametricFromPort, makeTwoCutPattern, type AntennaPattern } from './pattern';
import { pathLossDb, type PathLossSetup } from './propagation';
import {
  NO_SERVER,
  OVERLAP_WINDOW_DB,
  computePreview,
  pathLossGrid,
  pixelCentre,
  servePreview,
  type PreviewGrid,
  type PreviewInput,
  type PreviewMessage,
  type PreviewPort,
  type PreviewReply,
  type PreviewSource,
} from './preview';

const MARGINS: MarginSettings = {
  marginPreset: 'in-car',
  bodyLossDb: 3,
  edgeProbability: 0.9,
  shadowSigmaDb: 8,
};
const CARRIER = { tech: 'lte', bandwidthMHz: 20 } as const;
const UE = 1.5;
const SITE = { east: 500_123.4, north: 2_700_456.7 };

function twoCut(): AntennaPattern {
  const h = Array.from({ length: 360 }, (_, i) => {
    const a = i > 180 ? 360 - i : i;
    return Math.min(12 * (a / 65) ** 2, 25);
  });
  const v = Array.from({ length: 360 }, (_, i) => {
    const a = i > 180 ? i - 360 : i;
    return Math.min(12 * ((a - 6) / 7) ** 2, 20);
  });
  return makeTwoCutPattern(h, v, 28);
}

function setupFor(heightM: number): PathLossSetup {
  return { model: 'tr38901', environment: 'uma', frequencyMHz: 1842.5, hBsM: heightM, hUtM: UE };
}

function makeGrid(size: number, res: number): PreviewGrid {
  const half = (size * res) / 2;
  return {
    width: size,
    height: size,
    resolutionM: res,
    originEast: SITE.east - half,
    originNorth: SITE.north + half,
  };
}

interface SourceSpec {
  az: number;
  conv: number;
  mech: number;
  pattern: AntennaPattern;
  power: number;
  height: number;
  offset: [number, number];
}

function sectorsFor(grid: PreviewGrid, specs: SourceSpec[][]): PreviewInput['sectors'] {
  return specs.map((sector, si) => ({
    id: `sec-s${String(si + 1)}`,
    sources: sector.map((s): PreviewSource => ({
      east: SITE.east + s.offset[0],
      north: SITE.north + s.offset[1],
      heightM: s.height,
      azimuthGridDeg: s.az,
      convergenceDeg: s.conv,
      mechanicalDowntiltDeg: s.mech,
      pattern: s.pattern,
      portPowerDbm: s.power,
      subcarriers: subcarrierCount(CARRIER),
      feederLossDb: 0.5,
      antennaGainDbi: 17.5,
      pathLossDb: pathLossGrid(
        grid,
        { east: SITE.east + s.offset[0], north: SITE.north + s.offset[1] },
        setupFor(s.height),
      ),
    })),
  }));
}

const SPECS: SourceSpec[][] = [
  [
    {
      az: 10,
      conv: 1.5,
      mech: 4,
      pattern: parametricFromPort({ hBeamwidthDeg: 65, vBeamwidthDeg: 7, frontToBackDb: 25 }, 6),
      power: 46,
      height: 30,
      offset: [0.6, -0.4],
    },
    {
      az: 25,
      conv: 1.5,
      mech: 0,
      pattern: twoCut(),
      power: 43,
      height: 27,
      offset: [0.6, 0.4],
    },
  ],
  [
    {
      az: 130,
      conv: 1.5,
      mech: 2,
      pattern: parametricFromPort({ hBeamwidthDeg: 65, vBeamwidthDeg: 7, frontToBackDb: 25 }, 2),
      power: 46,
      height: 30,
      offset: [0, 0],
    },
  ],
  [
    {
      az: 250,
      conv: 1.5,
      mech: 8,
      pattern: parametricFromPort({ hBeamwidthDeg: 90, vBeamwidthDeg: 10, frontToBackDb: 30 }, 0),
      power: 40,
      height: 25,
      offset: [-0.5, 0],
    },
  ],
];

describe('pathLossGrid', () => {
  it('holds the path loss at each pixel centre, from the 2D distance to the antenna', () => {
    const grid = makeGrid(16, 20);
    const pl = pathLossGrid(grid, SITE, setupFor(30));
    expect(pl).toBeInstanceOf(Float32Array);
    for (const [c, r] of [
      [0, 0],
      [7, 9],
      [15, 3],
    ] as const) {
      const p = pixelCentre(grid, c, r);
      const d = Math.hypot(p.east - SITE.east, p.north - SITE.north);
      expect(pl[r * 16 + c]).toBeCloseTo(pathLossDb(setupFor(30), d), 3);
    }
  });
  it('leaves pixels beyond the radius as NaN', () => {
    const grid = makeGrid(16, 20);
    const pl = pathLossGrid(grid, SITE, setupFor(30), 100);
    expect(Number.isNaN(pl[0])).toBe(true);
    expect(Number.isNaN(pl[8 * 16 + 8])).toBe(false);
  });
});

describe('computePreview', () => {
  it('matches a direct per-pixel computation on a 64 x 64 synthetic grid', () => {
    const grid = makeGrid(64, 25);
    const sectors = sectorsFor(grid, SPECS);
    const marginDb = margins(MARGINS).totalDb;
    const out = computePreview({ grid, ueHeightM: UE, marginDb, sectors });

    let maxErr = 0;
    const seen = new Set<number>();
    for (let r = 0; r < grid.height; r++) {
      for (let c = 0; c < grid.width; c++) {
        const i = r * grid.width + c;
        const p = pixelCentre(grid, c, r);
        const perSector = SPECS.map((sector, si) =>
          Math.max(
            ...sector.map((s, k) => {
              const src = sectors[si]?.sources[k];
              if (!src) throw new Error('missing source');
              return evaluatePoint({
                directionGrid: {
                  east: p.east - src.east,
                  north: p.north - src.north,
                  up: UE - s.height,
                },
                azimuthGridDeg: s.az,
                convergenceDeg: s.conv,
                mechanicalDowntiltDeg: s.mech,
                pattern: s.pattern,
                portPowerDbm: s.power,
                carrier: CARRIER,
                feederLossDb: 0.5,
                antennaGainDbi: 17.5,
                pathLossDb: src.pathLossDb[i] ?? Number.NaN,
                margins: MARGINS,
              }).rsrpDbm;
            }),
          ),
        );
        const best = Math.max(...perSector);
        const bestIdx = perSector.indexOf(best);
        const overlap = perSector.filter((v) => v >= best - OVERLAP_WINDOW_DB).length;
        maxErr = Math.max(maxErr, Math.abs((out.rsrpDbm[i] ?? Number.NaN) - best));
        expect(out.bestServer[i]).toBe(bestIdx);
        expect(out.overlap[i]).toBe(overlap);
        seen.add(bestIdx);
      }
    }
    expect(maxErr).toBeLessThan(1e-3);
    expect([...seen].sort()).toEqual([0, 1, 2]);
    expect(out.sectorIds).toEqual(['sec-s1', 'sec-s2', 'sec-s3']);
  });

  it('writes NaN, no server and no overlap where no sector has path loss', () => {
    const grid = makeGrid(8, 10);
    const sectors = sectorsFor(grid, [SPECS[1] ?? []]);
    const pl = sectors[0]?.sources[0]?.pathLossDb;
    if (!pl) throw new Error('missing');
    pl[0] = Number.NaN;
    const out = computePreview({ grid, ueHeightM: UE, marginDb: 0, sectors });
    expect(Number.isNaN(out.rsrpDbm[0])).toBe(true);
    expect(out.bestServer[0]).toBe(NO_SERVER);
    expect(out.overlap[0]).toBe(0);
    expect(out.bestServer[1]).toBe(0);
    expect(out.overlap[1]).toBe(1);
  });

  it('refuses a source without a convergence or with a path-loss grid of the wrong size', () => {
    const grid = makeGrid(8, 10);
    const sectors = sectorsFor(grid, [SPECS[1] ?? []]);
    const src = sectors[0]?.sources[0];
    if (!src) throw new Error('missing');
    expect(() =>
      computePreview({
        grid,
        ueHeightM: UE,
        marginDb: 0,
        sectors: [{ id: 'sec-a', sources: [{ ...src, convergenceDeg: null }] }],
      }),
    ).toThrow(/CRS/);
    expect(() =>
      computePreview({
        grid,
        ueHeightM: UE,
        marginDb: 0,
        sectors: [{ id: 'sec-a', sources: [{ ...src, pathLossDb: new Float32Array(3) }] }],
      }),
    ).toThrow(/64 values/);
  });

  it('runs a 280 k pixel, 3-sector preview (timing logged, not asserted)', () => {
    const grid = makeGrid(530, 10); // 280,900 pixels: 10 m out to about 2.65 km each way
    const sectors = sectorsFor(
      grid,
      SPECS.map((s) => s.slice(0, 1)),
    );
    const input = { grid, ueHeightM: UE, marginDb: margins(MARGINS).totalDb, sectors };
    computePreview(input); // warm up the JIT
    const runs: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      computePreview(input);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    const median = runs[2] ?? Number.NaN;
    // eslint-disable-next-line no-console -- the measured time, for the task report
    console.log(
      `[rf preview] ${String(grid.width * grid.height)} px x 3 sectors: median ${median.toFixed(1)} ms (runs ${runs.map((r) => r.toFixed(1)).join(', ')} ms; budget 150 ms)`,
    );
    expect(Number.isFinite(median)).toBe(true);
  });
});

describe('servePreview', () => {
  function fakePort() {
    const sent: { message: PreviewReply; transfer: ArrayBuffer[] }[] = [];
    const port: PreviewPort = {
      onmessage: null,
      postMessage(message, transfer) {
        sent.push({ message, transfer });
      },
    };
    const send = (data: PreviewMessage) => port.onmessage?.({ data });
    return { port, sent, send };
  }

  it('caches path-loss grids by key and answers previews with transferable buffers', () => {
    const { port, sent, send } = fakePort();
    servePreview(port);
    const grid = makeGrid(8, 10);
    const [sector] = sectorsFor(grid, [SPECS[1] ?? []]);
    const src = sector?.sources[0];
    if (!src) throw new Error('missing');
    send({ type: 'path-loss:set', key: 'sec-s2/b3', pathLossDb: src.pathLossDb });
    const { pathLossDb, ...settings } = src;
    expect(pathLossDb).toBeInstanceOf(Float32Array);
    send({
      type: 'preview',
      id: 7,
      input: {
        grid,
        ueHeightM: UE,
        marginDb: 0,
        sectors: [{ id: 'sec-s2', sources: [{ ...settings, pathLossKey: 'sec-s2/b3' }] }],
      },
    });
    const reply = sent.at(-1);
    expect(reply?.message).toMatchObject({ type: 'preview', id: 7, ok: true });
    if (!reply?.message.ok) throw new Error('no reply');
    const direct = computePreview({
      grid,
      ueHeightM: UE,
      marginDb: 0,
      sectors: [sector],
    });
    expect(Array.from(reply.message.output.rsrpDbm)).toEqual(Array.from(direct.rsrpDbm));
    expect(reply.transfer).toHaveLength(3);
  });

  it('answers an unknown path-loss key with an error, and drops keys', () => {
    const { port, sent, send } = fakePort();
    servePreview(port);
    const grid = makeGrid(8, 10);
    send({ type: 'path-loss:set', key: 'k', pathLossDb: new Float32Array(64) });
    send({ type: 'path-loss:drop', key: 'k' });
    const [sector] = sectorsFor(grid, [SPECS[1] ?? []]);
    const src = sector?.sources[0];
    if (!src) throw new Error('missing');
    const { pathLossDb, ...settings } = src;
    expect(pathLossDb).toBeInstanceOf(Float32Array);
    send({
      type: 'preview',
      id: 8,
      input: {
        grid,
        ueHeightM: UE,
        marginDb: 0,
        sectors: [{ id: 'sec-a', sources: [{ ...settings, pathLossKey: 'k' }] }],
      },
    });
    expect(sent.at(-1)?.message).toMatchObject({ type: 'preview', id: 8, ok: false });
    const m = sent.at(-1)?.message;
    expect(m && !m.ok ? m.error : '').toMatch(/k/);
  });
});
