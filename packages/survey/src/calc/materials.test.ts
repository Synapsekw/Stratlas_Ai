import { describe, expect, it } from 'vitest';
import {
  densityOn,
  MATERIAL_PALETTE,
  materialColour,
  materialIdFrom,
  materialsFromCsv,
  materialsToCsv,
  mergeMaterials,
  withDensityFrom,
} from './materials';

const BOM = String.fromCharCode(0xfeff);

const SITE = [
  {
    id: 'crushed-20',
    name: 'Crushed 20 mm',
    code: 'C20',
    densityTPerM3: 1.6,
    swell: { loose: 1.3, compacted: 1.05 },
  },
  { id: 'washed-sand', name: 'Washed sand, fine', densityTPerM3: 1.55 },
];

describe('site materials as CSV', () => {
  it('round trips', () => {
    const csv = materialsToCsv(SITE);
    expect(csv.split('\r\n')[0]).toBe('id,name,code,density_t_per_m3,swell_loose,swell_compacted');
    expect(csv).toContain('"Washed sand, fine"');
    const back = materialsFromCsv(csv);
    expect(back.problems).toEqual([]);
    expect(back.materials).toEqual(SITE);
  });

  it('keeps a name that a spreadsheet would run as a formula as text, and reads it back', () => {
    const risky = [{ id: 'x', name: '=HYPERLINK("http://x")', code: '-1', densityTPerM3: 1.6 }];
    const csv = materialsToCsv(risky);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")",'-1,1.6`);
    expect(materialsFromCsv(csv).materials).toEqual(risky);
  });

  it('reads a semicolon file with a BOM, decimal commas, columns in any order and bad rows', () => {
    const text =
      BOM +
      'name;id;density;loose;compacted\n' +
      'Base course;base;2,1;1,2;0,95\n' +
      'Topsoil;top;;;\n' +
      'Clay;clay;heavy;;\n' +
      'Rock;rock;2.6;1.5;\n' +
      'Again;base;1;;\n';
    const r = materialsFromCsv(text);
    expect(r.materials).toEqual([
      {
        id: 'base',
        name: 'Base course',
        densityTPerM3: 2.1,
        swell: { loose: 1.2, compacted: 0.95 },
      },
      { id: 'top', name: 'Topsoil' },
    ]);
    expect(r.problems).toEqual([
      'Line 4: a number column holds text.',
      'Line 5: give both swell factors (loose and compacted) or neither.',
      'Line 6: the id "base" is used twice.',
    ]);
  });

  it('refuses a file without the id and name columns', () => {
    expect(materialsFromCsv('a,b\n1,2\n').problems[0]).toMatch(/id and name/);
  });

  it('merges by id and makes safe ids', () => {
    const merged = mergeMaterials(SITE, [
      { id: 'washed-sand', name: 'Washed sand', densityTPerM3: 1.5 },
      { id: 'gravel', name: 'Gravel' },
    ]);
    expect(merged.map((m) => [m.id, m.name])).toEqual([
      ['crushed-20', 'Crushed 20 mm'],
      ['washed-sand', 'Washed sand'],
      ['gravel', 'Gravel'],
    ]);
    expect(materialIdFrom('Crushed 20 mm', new Set(['crushed-20-mm']))).toBe('crushed-20-mm-2');
    expect(materialIdFrom('  ', new Set())).toBe('material');
  });
});

describe('densities on a survey date', () => {
  // three surveys; d0 has no date (Review Focus 3)
  const DAYS: Record<string, number> = { d1: 10, d2: 20, d3: 30 };
  const dateOf = (c: string): number | null => DAYS[c] ?? null;
  const dated = {
    id: 'agg',
    name: 'Aggregate',
    densityTPerM3: 1.7,
    densityHistory: [
      { fromCapture: 'd3', tPerM3: 1.7 },
      { fromCapture: 'd2', tPerM3: 1.62 },
    ],
  };

  it('takes the latest entry on or before the date, the first before any', () => {
    expect(densityOn(dated, 'd1', dateOf)).toBe(1.62);
    expect(densityOn(dated, 'd2', dateOf)).toBe(1.62);
    expect(densityOn(dated, 'd3', dateOf)).toBe(1.7);
  });

  it('falls back to densityTPerM3 for an undated capture or without a history', () => {
    expect(densityOn(dated, 'd0', dateOf)).toBe(1.7);
    expect(densityOn({ id: 's', name: 'Sand', densityTPerM3: 1.5 }, 'd2', dateOf)).toBe(1.5);
    expect(densityOn({ id: 's', name: 'Sand' }, 'd2', dateOf)).toBeNull();
  });

  it('skips history entries whose capture has no date without throwing', () => {
    const odd = {
      id: 'x',
      name: 'X',
      densityTPerM3: 2,
      densityHistory: [
        { fromCapture: 'd0', tPerM3: 9 },
        { fromCapture: 'd2', tPerM3: 2 },
      ],
    };
    expect(densityOn(odd, 'd1', dateOf)).toBe(2);
    expect(densityOn(odd, 'd3', dateOf)).toBe(2);
  });

  it('withDensityFrom seeds the earlier density from the earliest survey and keeps densityTPerM3 at the newest', () => {
    // Review Focus 4: three surveys, edit from the second
    const before = { id: 'agg', name: 'Aggregate', densityTPerM3: 1.6 };
    const after = withDensityFrom(before, 'd2', 1.62, 'd1', dateOf);
    expect(after.densityHistory).toEqual([
      { fromCapture: 'd1', tPerM3: 1.6 },
      { fromCapture: 'd2', tPerM3: 1.62 },
    ]);
    expect(after.densityTPerM3).toBe(1.62);
    expect(densityOn(after, 'd1', dateOf)).toBe(1.6);
    expect(densityOn(after, 'd2', dateOf)).toBe(1.62);
    expect(densityOn(after, 'd3', dateOf)).toBe(1.62);
    expect(before).toEqual({ id: 'agg', name: 'Aggregate', densityTPerM3: 1.6 });
  });

  it('withDensityFrom replaces an entry of the same date and sorts by date', () => {
    const one = withDensityFrom(
      { id: 'agg', name: 'Aggregate', densityTPerM3: 1.6 },
      'd3',
      1.8,
      'd1',
      dateOf,
    );
    const two = withDensityFrom(one, 'd2', 1.7, 'd1', dateOf);
    expect(two.densityHistory?.map((e) => e.fromCapture)).toEqual(['d1', 'd2', 'd3']);
    expect(two.densityTPerM3).toBe(1.8);
    const three = withDensityFrom(two, 'd3', 1.75, 'd1', dateOf);
    expect(three.densityHistory).toHaveLength(3);
    expect(three.densityTPerM3).toBe(1.75);
  });

  it('withDensityFrom on a material without a density seeds nothing', () => {
    const m = withDensityFrom({ id: 'c', name: 'Clay' }, 'd2', 1.9, 'd1', dateOf);
    expect(m.densityHistory).toEqual([{ fromCapture: 'd2', tPerM3: 1.9 }]);
    expect(m.densityTPerM3).toBe(1.9);
    // an edit from the earliest date replaces the single density without a seed entry
    const e = withDensityFrom({ id: 's', name: 'S', densityTPerM3: 1.5 }, 'd1', 1.4, 'd1', dateOf);
    expect(e.densityHistory).toEqual([{ fromCapture: 'd1', tPerM3: 1.4 }]);
  });
});

describe('material colours', () => {
  it('a material colour wins, else the palette by place', () => {
    expect(MATERIAL_PALETTE).toHaveLength(8);
    expect(MATERIAL_PALETTE[0]).toBe('--mat-1');
    expect(materialColour({ id: 'a', name: 'A', colour: '#abcdef' }, 0)).toBe('#abcdef');
    expect(materialColour({ id: 'a', name: 'A' }, 2)).toBe('var(--mat-3)');
    expect(materialColour({ id: 'a', name: 'A' }, 9)).toBe('var(--mat-2)');
  });
});
