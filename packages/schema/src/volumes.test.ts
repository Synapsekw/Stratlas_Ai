import { describe, expect, it } from 'vitest';
import { BoundaryEditsFile, ipc, VolumesFile, type BoundaryEdit } from './index';

const fcn = (net: number) => ({ fill: net + 1, cut: 1, net });
const vols = (net: number) => ({ tin: fcn(net), plane: fcn(net), avg: fcn(net), low: fcn(net) });
const ring: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, -10],
  [0, -10],
];

/** The shape the Masafi importer writes (packages/project masafi.ts). */
function volumesFile() {
  return {
    schema: 'aio.volumes/1',
    source: 'Volumetric Survey Kit',
    units: { volume: 'm3', area: 'm2', length: 'm' },
    frame: 'rings are [x, z] in the project local frame',
    densityTPerM3: 1.6,
    swell: 1,
    deadbandM: 0.1,
    defaultBase: 'tin',
    bases: [
      { id: 'tin', label: 'Triangulated toe' },
      { id: 'plane', label: 'Best-fit toe plane' },
      { id: 'avg', label: 'Average toe height' },
      { id: 'low', label: 'Lowest toe point' },
    ],
    captures: [
      { epoch: 'e1', captureId: 'survey-1', date: '2020-12-31', label: '31 Dec 2020' },
      { epoch: 'e2', captureId: 'survey-2', date: '2021-01-10', label: '10 Jan 2021' },
    ],
    piles: [
      {
        id: 'P01',
        name: 'Pile 01',
        material: null,
        status: 'matched',
        centreEN: [212706.5, 3201762.76],
        zoneRing: ring,
        change: { fill: 0, cut: 0.1, net: -0.1 },
        epochs: {
          e1: {
            captureId: 'survey-1',
            areaM2: 398.3,
            topM: 69.66,
            heightM: 9.29,
            surveyErrM3: 5.1,
            groundToeFrac: 0.35,
            node: 'P01_e1',
            ring,
            volumes: vols(1754),
          },
        },
      },
    ],
    totals: { e1: { tin: 1754, plane: 1, avg: 1, low: 1, area_m2: 398.3 } },
    pileChange: fcn(-1),
    siteChange: { ...fcn(-2), area_m2: 10 },
    aoi: ring,
    excluded: [{ reason: 'Bund', ring }],
    check: { tolerance: 0.005 },
  };
}

function edit(over: Partial<BoundaryEdit> = {}): BoundaryEdit {
  return {
    pile: 'P01',
    epoch: 'e2',
    ring,
    volumes: vols(1500),
    areaM2: 100,
    topM: 69.5,
    heightM: 9,
    autoNet: 1819.1,
    updatedAt: '2026-10-04T10:00:00.000Z',
    ...over,
  };
}

describe('volumes.json (aio.volumes/1)', () => {
  it('accepts the file the Masafi importer writes', () => {
    const r = VolumesFile.safeParse(volumesFile());
    expect(r.success, r.error?.message).toBe(true);
  });

  it('accepts optional grid locations and capture layers', () => {
    const f = {
      ...volumesFile(),
      grids: {
        format: 'vs-kit-js',
        piles: 'legacy/data/piles/{id}.js',
        dsm: 'legacy/data/dsm_{epoch}.js',
        coarse: 'legacy/data/vol.js',
      },
      captures: [
        { epoch: 'e1', captureId: 'c1', date: '2020-12-31', label: 'a', layers: ['terrain-1'] },
      ],
    };
    expect(VolumesFile.safeParse(f).success).toBe(true);
  });

  it('rejects an unknown default base', () => {
    expect(VolumesFile.safeParse({ ...volumesFile(), defaultBase: 'mean' }).success).toBe(false);
  });

  it('rejects a pile date without all four bases', () => {
    const f = volumesFile();
    const e1 = f.piles[0]?.epochs.e1;
    if (!e1) throw new Error('fixture');
    const three: Partial<typeof e1.volumes> = { ...e1.volumes };
    delete three.low;
    expect(
      VolumesFile.safeParse({
        ...f,
        piles: [{ ...f.piles[0], epochs: { e1: { ...e1, volumes: three } } }],
      }).success,
    ).toBe(false);
  });
});

describe('edits/boundaries.json (aio.boundaries/1)', () => {
  it('accepts hand-edited toe lines', () => {
    const r = BoundaryEditsFile.safeParse({
      schema: 'aio.boundaries/1',
      edits: [edit(), edit({ epoch: 'e1', author: 'D' })],
    });
    expect(r.success, r.error?.message).toBe(true);
  });

  it('rejects a ring with fewer than three points', () => {
    const r = BoundaryEditsFile.safeParse({
      schema: 'aio.boundaries/1',
      edits: [edit({ ring: ring.slice(0, 2) })],
    });
    expect(r.success).toBe(false);
  });

  it('rejects two edits of the same pile and date', () => {
    const r = BoundaryEditsFile.safeParse({ schema: 'aio.boundaries/1', edits: [edit(), edit()] });
    expect(r.success).toBe(false);
  });

  it('is written through project:writeBoundaries, validated in main', () => {
    const req = ipc['project:writeBoundaries'].request;
    const file = { schema: 'aio.boundaries/1', edits: [edit()] };
    expect(req.safeParse({ projectId: 'masafi', file }).success).toBe(true);
    expect(req.safeParse({ projectId: '', file }).success).toBe(false);
    expect(req.safeParse({ projectId: 'masafi', file, path: 'C:/x' }).success).toBe(false);
    expect(ipc['project:writeBoundaries'].response.safeParse({ ok: true }).success).toBe(true);
  });
});
