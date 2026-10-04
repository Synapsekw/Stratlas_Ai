import type { BoundaryEdit, VolumesFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { applyEdits, registerCsv, registerRows, sortRows, totals } from './register';

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

describe('registerRows', () => {
  it('lists every pile on a date and base, absent piles included', () => {
    const rows = registerRows(applyEdits(file(), []), 'e1', 'plane');
    expect(rows.map((r) => [r.id, r.present, r.net])).toEqual([
      ['P01', true, 110],
      ['P02', false, null],
    ]);
    expect(rows[0]).toMatchObject({ fill: 111, cut: 1, change: -50, edited: false });
  });

  it('sorts by any column, absent values last', () => {
    const rows = registerRows(applyEdits(file(), []), 'e1', 'tin');
    expect(sortRows(rows, 'net', 'desc').map((r) => r.id)).toEqual(['P01', 'P02']);
    expect(sortRows(rows, 'net', 'asc').map((r) => r.id)).toEqual(['P01', 'P02']);
    expect(sortRows(rows, 'change', 'desc').map((r) => r.id)).toEqual(['P02', 'P01']);
    expect(sortRows(rows, 'id', 'desc').map((r) => r.id)).toEqual(['P02', 'P01']);
  });
});

describe('totals', () => {
  it('sums net, fill, cut and area of the piles present', () => {
    expect(totals(applyEdits(file(), [edit]), 'e2', 'tin')).toEqual({
      net: 370,
      fill: 372,
      cut: 2,
      areaM2: 220,
      piles: 2,
    });
  });
});

describe('registerCsv', () => {
  it('writes one row per pile with every date and base, change, density and boundary', () => {
    const csv = registerCsv(file(), applyEdits(file(), [edit]), 1.6);
    const [head, r1, r2, end] = csv.split('\n');
    expect(head?.split(',').slice(0, 6)).toEqual([
      'pile',
      'name',
      'status',
      'e1_date',
      'e1_area_m2',
      'e1_height_m',
    ]);
    expect(head).toContain('e2_vol_tin_fill_m3,e2_vol_tin_cut_m3,e2_vol_tin_net_m3');
    expect(head?.endsWith('change_cut_m3,change_fill_m3,change_net_m3,density_t_m3,boundary')).toBe(
      true,
    );
    expect(r1?.startsWith('P01,Pile 01,matched,2020-12-31,100,5,101,1,100,')).toBe(true);
    expect(r1?.endsWith(',1,-49,-50,1.6,edited 10 Jan 2021')).toBe(true);
    expect(r2).toContain('P02,Pile 02,new,2020-12-31,,,');
    expect(r2?.endsWith('automatic')).toBe(true);
    expect(end).toBe('');
  });

  it('quotes fields that hold commas', () => {
    const f = file();
    const p = f.piles[0];
    if (p) p.name = 'Pile 01, north';
    expect(registerCsv(f, applyEdits(f, []), 1.6)).toContain('"Pile 01, north"');
  });
});
