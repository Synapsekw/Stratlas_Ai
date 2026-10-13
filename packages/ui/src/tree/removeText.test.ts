import { emptyRemovalPlan, type RemovalPlan } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { removeText } from './removeText';

const o = {
  dateLabel: (id: string) => ({ c1: '12 Oct 2026', c3: '2 Nov 2026' })[id] ?? id,
  size: () => '2.3 GB',
};
const plan = (p: Partial<RemovalPlan>): RemovalPlan => ({ ...emptyRemovalPlan(), ...p });

describe('removeText', () => {
  it('a photos layer: its run and map layers, the comparison, jobs, kept issues and originals', () => {
    const x = removeText(
      [{ layer: 'photos-a' }],
      plan({
        layers: [
          { id: 'photos-a', name: 'Flight A', kind: 'photos', why: 'asked' },
          { id: 'r3-ortho', name: 'Ortho', kind: 'raster', why: { madeBy: 'r3' } },
          { id: 'r3-dsm', name: 'DSM', kind: 'raster', why: { madeBy: 'r3' } },
          { id: 'heat', name: 'Heat', kind: 'raster', why: { madeBy: 'chg-1' } },
        ],
        runs: [{ id: 'r3', status: 'failed', why: { usedBy: 'photos-a' } }],
        changes: [{ id: 'chg-1', name: '12 Oct to 26 Oct', why: { usedBy: 'r3-dsm' } }],
        jobs: ['j1', 'j2'],
        touches: { issues: 2, walkPins: 0 },
        keptOutside: ['C:/Photos'],
        files: ['photogrammetry/r3'],
        bytes: 2_400_000_000,
      }),
      t,
      o,
    );
    expect(x.title).toBe('Delete Flight A?');
    expect(x.asked).toEqual(['Flight A']);
    expect(x.also).toEqual([
      'Run r3 and its 2 map layers',
      '1 dataset made from them',
      '1 comparison (12 Oct to 26 Oct)',
      '2 job folders',
    ]);
    expect(x.keeps).toEqual([
      "2 issues will show 'Dataset removed'",
      'Your original photos are not touched.',
    ]);
    expect(x.space).toBe('Space freed: 2.3 GB, for good when the project trash is emptied');
    expect(x.note).toBe(
      'Everything goes to the project trash and is deleted for good after seven days.',
    );
    expect(x.refused).toBeNull();
  });

  it('a run asked for: the title names the run and its layers are counted', () => {
    const x = removeText(
      [{ run: 'r3' }],
      plan({
        runs: [{ id: 'r3', status: 'failed', why: 'asked' }],
        layers: [{ id: 'r3-ortho', name: 'Ortho', kind: 'raster', why: { madeBy: 'r3' } }],
      }),
      t,
      o,
    );
    expect(x.title).toBe('Delete run r3?');
    expect(x.asked).toEqual(['Run r3']);
    expect(x.also).toEqual(['1 map layer made by run r3']);
  });

  it('a date: the title, the filed datasets, and a kept date says why', () => {
    const x = removeText(
      [{ capture: 'c3' }],
      plan({
        layers: [{ id: 'dsm-c', name: 'DSM', kind: 'raster', why: { filedUnder: 'c3' } }],
        keptCaptures: [{ id: 'c3', by: 'volume' }],
      }),
      t,
      o,
    );
    expect(x.title).toBe('Delete everything from 2 Nov 2026?');
    expect(x.asked).toEqual(['1 dataset filed under this date']);
    expect(x.keeps).toEqual(['The survey date 2 Nov 2026 stays: a volume uses it']);
    expect(x.space).toBeNull();
  });

  it('a date that goes: it says the date itself goes, first', () => {
    const x = removeText(
      [{ capture: 'c3' }],
      plan({
        layers: [{ id: 'dsm-c', name: 'DSM', kind: 'raster', why: { filedUnder: 'c3' } }],
        captures: ['c3'],
        files: ['rasters/dsm-c'],
        bytes: 10,
      }),
      t,
      o,
    );
    expect(x.asked).toEqual(['The survey date 2 Nov 2026', '1 dataset filed under this date']);
    expect(x.note).toBe(
      'Everything goes to the project trash and is deleted for good after seven days.',
    );
  });

  it('a date that takes a run: the run is listed with what goes', () => {
    const x = removeText(
      [{ capture: 'c3' }],
      plan({
        layers: [{ id: 'r9-ortho', name: 'Ortho', kind: 'raster', why: { filedUnder: 'c3' } }],
        runs: [{ id: 'r9', status: 'done', why: { filedUnder: 'c3' } }],
        captures: ['c3'],
        keptOutside: ['C:/Photos'],
        files: ['photogrammetry/r9', 'rasters/r9-ortho'],
        bytes: 10,
      }),
      t,
      o,
    );
    expect(x.asked).toEqual(['The survey date 2 Nov 2026', '1 dataset filed under this date']);
    expect(x.also).toEqual(['Run r9']);
    expect(x.keeps).toEqual(['Your original photos are not touched.']);
  });

  it('an empty date: only the date goes, and nothing goes to the project trash', () => {
    const x = removeText([{ capture: 'c3' }], plan({ captures: ['c3'] }), t, o);
    expect(x.title).toBe('Delete everything from 2 Nov 2026?');
    expect(x.asked).toEqual(['The survey date 2 Nov 2026']);
    expect(x.space).toBeNull();
    expect(x.note).toBeNull();
  });

  it('many rows: a counted title and at most eight names', () => {
    const layers = Array.from({ length: 10 }, (_, i) => ({
      id: `v${String(i)}`,
      name: `Clip ${String(i)}`,
      kind: 'video',
      why: 'asked' as const,
    }));
    const x = removeText(
      layers.map((l) => ({ layer: l.id })),
      plan({ layers }),
      t,
      o,
    );
    expect(x.title).toBe('Delete 10 datasets?');
    expect(x.asked).toHaveLength(9);
    expect(x.asked[8]).toBe('and 2 more');
  });

  it('a refused plan carries its reason', () => {
    const x = removeText(
      [{ run: 'r3' }],
      plan({ refused: 'Creating maps for run r3 is still running. Cancel it first.' }),
      t,
      o,
    );
    expect(x.refused).toBe('Creating maps for run r3 is still running. Cancel it first.');
  });
});
