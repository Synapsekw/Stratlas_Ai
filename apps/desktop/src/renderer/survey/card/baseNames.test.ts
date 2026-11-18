import { BASE_NAMES, OLDER_MODE_NAMES, pickerBaseName } from '@aio/project/export';
import type { SurfaceRef } from '@aio/schema';
import { sideFor, sideOptions } from '@aio/survey';
import { t } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import { BASES, baseName, kitBaseName, OLDER_MODES } from './baseNames';

/** One side of every kind a person can read as a base, with the picker's name for it. */
const SIDES: [SurfaceRef, string][] = [
  [{ kind: 'smart' }, 'Toe surface'],
  [{ kind: 'reference', mode: 'perimeter-min' }, 'Lowest point'],
  [{ kind: 'fit-plane' }, 'Best-fit plane'],
  [{ kind: 'reference', mode: 'level', levelM: 12 }, 'Fixed level'],
  [{ kind: 'perimeter-mean' }, 'Average edge level'],
  [
    {
      kind: 'custom',
      vertices: [
        { e: 0, n: 0, z: 1 },
        { e: 1, n: 0, z: 1 },
        { e: 0, n: 1, z: 1 },
      ],
    },
    'Custom',
  ],
  [{ kind: 'reference', mode: 'perimeter-max' }, 'Highest point'],
  [{ kind: 'reference', mode: 'interior-max' }, 'Highest point inside'],
  [{ kind: 'reference', mode: 'interior-min' }, 'Lowest point inside'],
];

describe('one name per base', () => {
  it('names every base as the picker does, from the side itself', () => {
    for (const [ref, name] of SIDES) expect(baseName(ref, [], t)).toBe(name);
  });

  it('the catalogue and the names the CSV exports write are the same words', () => {
    expect(BASES.map((b) => b.id).sort()).toEqual(Object.keys(BASE_NAMES).sort());
    for (const b of BASES) expect(t(b.name)).toBe(BASE_NAMES[b.id]);
    expect(Object.keys(OLDER_MODES).sort()).toEqual(Object.keys(OLDER_MODE_NAMES).sort());
    for (const [mode, key] of Object.entries(OLDER_MODES))
      expect(t(key)).toBe(OLDER_MODE_NAMES[mode]);
    for (const [ref] of SIDES) expect(pickerBaseName(ref)).toBe(baseName(ref, [], t));
  });

  it('a survey or design side is not a base: the CSV keeps its own name', () => {
    expect(pickerBaseName({ kind: 'current' })).toBeNull();
    expect(pickerBaseName({ kind: 'previous' })).toBeNull();
    expect(pickerBaseName({ kind: 'survey', surface: 's1' })).toBeNull();
    expect(pickerBaseName({ kind: 'design', design: 'd', layer: 'l' })).toBeNull();
  });

  it('the options of "Several measurements at once" carry the name of the base they make', () => {
    const bases = sideOptions({ surfaces: [], captures: [] }).filter((o) => o.group === 'Bases');
    expect(bases.map((o) => o.label)).toEqual([
      'Fixed level',
      'Toe surface',
      'Best-fit plane',
      'Average edge level',
      'Custom',
    ]);
    for (const o of bases) expect(o.label).toBe(baseName(sideFor(o, []), [], t));
  });
});

describe('kit base names', () => {
  it('the kit tin base reads "Toe surface", as the engine\'s smart base does', () => {
    expect(kitBaseName('tin', t)).toBe('Toe surface');
    expect(kitBaseName('tin', t)).toBe(t('base.smart'));
  });

  it('names the other kit bases plainly, and an unknown id as it is', () => {
    expect(kitBaseName('plane', t)).toBe('Best-fit plane');
    expect(kitBaseName('low', t)).toBe('Lowest point');
    expect(kitBaseName('mystery', t)).toBe('mystery');
  });
});
