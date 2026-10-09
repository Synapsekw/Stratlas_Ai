import { describe, expect, it } from 'vitest';
import { materialIdFrom, materialsFromCsv, materialsToCsv, mergeMaterials } from './materials';

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
