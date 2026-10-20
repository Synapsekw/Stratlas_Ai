import type { BoundaryEdit, VolumesFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { applyEdits } from './register';

const fc = (net: number, cut = 1) => ({ fill: net + cut, cut, net });
const v4 = (net: number) => ({
  tin: fc(net),
  plane: fc(net + 10),
  avg: fc(net + 20),
  low: fc(net + 30),
});
const ring: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, -1],
];
const ep = (captureId: string, net: number) => ({
  captureId,
  areaM2: 100,
  topM: 60,
  heightM: 5,
  surveyErrM3: 1.5,
  ring,
  volumes: v4(net),
});

function file(): VolumesFile {
  return {
    schema: 'aio.volumes/1',
    densityTPerM3: 1.6,
    deadbandM: 0.1,
    defaultBase: 'tin',
    bases: [
      { id: 'tin', label: 'Triangulated toe' },
      { id: 'plane', label: 'Best-fit toe plane' },
      { id: 'avg', label: 'Average toe height' },
      { id: 'low', label: 'Lowest toe point' },
    ],
    captures: [
      { epoch: 'e1', captureId: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
      { epoch: 'e2', captureId: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
    ],
    piles: [
      {
        id: 'P01',
        name: 'Pile 01',
        status: 'matched',
        zoneRing: ring,
        change: fc(-50),
        epochs: { e1: ep('c1', 100), e2: ep('c2', 50) },
      },
      {
        id: 'P02',
        name: 'Pile 02',
        status: 'new',
        zoneRing: ring,
        change: fc(300),
        epochs: { e2: ep('c2', 300) },
      },
    ],
    totals: {},
    pileChange: fc(0),
    siteChange: fc(0),
  };
}

const edit: BoundaryEdit = {
  pile: 'P01',
  epoch: 'e2',
  ring: [
    [0, 0],
    [2, 0],
    [2, -2],
  ],
  volumes: v4(70),
  areaM2: 120,
  topM: 61,
  heightM: 6,
  autoNet: 50,
  updatedAt: '2026-10-04T10:00:00.000Z',
};

describe('applyEdits', () => {
  it('replaces the automatic toe line and volumes of edited piles and dates', () => {
    const piles = applyEdits(file(), [edit]);
    const p1 = piles.find((p) => p.id === 'P01');
    expect(p1?.epochs.e2?.volumes.tin.net).toBe(70);
    expect(p1?.epochs.e2?.ring).toEqual(edit.ring);
    expect(p1?.epochs.e2?.areaM2).toBe(120);
    expect(p1?.edited).toEqual(['e2']);
    expect(p1?.epochs.e1?.volumes.tin.net).toBe(100);
    expect(piles.find((p) => p.id === 'P02')?.edited).toEqual([]);
  });

  it('leaves the input untouched', () => {
    const f = file();
    applyEdits(f, [edit]);
    expect(f.piles[0]?.epochs.e2?.volumes.tin.net).toBe(50);
  });
});
