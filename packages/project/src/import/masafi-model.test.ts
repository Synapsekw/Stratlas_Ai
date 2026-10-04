import { describe, expect, it } from 'vitest';
import { ClassCatalogue, SeverityModel } from '@aio/schema';
import {
  STOCKPILE_CATALOGUE,
  STOCKPILE_SEVERITY_MODEL,
  formatM3,
  orthoPyramidPlan,
  pileNode,
  pileTags,
  volumeCheck,
} from './masafi-model';

describe('stockpile severity model and classes', () => {
  it('is a valid 1 to 3 model', () => {
    const m = SeverityModel.parse(STOCKPILE_SEVERITY_MODEL);
    expect(m.name).toBe('Stockpile');
    expect(m.levels.map((l) => l.value)).toEqual([1, 2, 3]);
  });

  it('offers spillage, unsafe slope and encroachment on that model', () => {
    const c = ClassCatalogue.parse(STOCKPILE_CATALOGUE);
    expect(c.classes.map((k) => k.label)).toEqual(['Spillage', 'Unsafe slope', 'Encroachment']);
    for (const k of c.classes) expect(k.severityModel).toBe(STOCKPILE_SEVERITY_MODEL.id);
  });
});

describe('ortho pyramid plan', () => {
  // finest level 5 has 16 x 18 tiles; coarser levels halve
  const tiles = [
    { z: 5, x: 15, y: 17 },
    { z: 5, x: 0, y: 3 },
    { z: 4, x: 7, y: 8 },
    { z: 2, x: 1, y: 2 },
  ];

  it('spans a whole number of tiles at every kept level', () => {
    const p = orthoPyramidPlan(tiles, 2);
    expect(p.levels).toEqual([
      { z: 2, cols: 2, rows: 3 },
      { z: 3, cols: 4, rows: 6 },
      { z: 4, cols: 8, rows: 12 },
      { z: 5, cols: 16, rows: 24 },
    ]);
  });

  it('lists every tile of every level, flagging the ones the source lacks', () => {
    const p = orthoPyramidPlan(tiles, 2);
    expect(p.tiles).toHaveLength(6 + 24 + 96 + 384);
    expect(p.tiles.find((t) => t.z === 5 && t.x === 15 && t.y === 17)?.present).toBe(true);
    expect(p.tiles.find((t) => t.z === 5 && t.x === 15 && t.y === 23)?.present).toBe(false);
  });
});

describe('pile tags', () => {
  it('names a node per pile and date and labels it with the default-base volume', () => {
    expect(pileNode('P07', 'e2')).toBe('P07_e2');
    const tags = pileTags(
      [
        { id: 'P01', net: 1819.1 },
        { id: 'P02', net: 11378.7 },
      ],
      'e2',
    );
    expect(tags).toEqual([
      { node: 'P01_e2', tag: 'P01', area: '1,819 m³' },
      { node: 'P02_e2', tag: 'P02', area: '11,379 m³' },
    ]);
  });

  it('formats volumes with thousands separators', () => {
    expect(formatM3(1234567.4)).toBe('1,234,567 m³');
    expect(formatM3(-12.6)).toBe('-13 m³');
  });
});

describe('volume check', () => {
  it('reports the largest relative difference to the kit figures', () => {
    const c = volumeCheck([
      { pile: 'P01', epoch: 'e1', base: 'tin', computed: 100.2, kit: 100 },
      { pile: 'P02', epoch: 'e2', base: 'low', computed: 99, kit: 100 },
      { pile: 'P03', epoch: 'e2', base: 'avg', computed: 0.05, kit: 0 },
    ]);
    expect(c.maxRel).toBeCloseTo(0.01, 10);
    expect(c.worst).toMatchObject({ pile: 'P02', epoch: 'e2', base: 'low' });
    expect(c.within(0.005)).toBe(false);
    expect(c.within(0.02)).toBe(true);
  });
});
