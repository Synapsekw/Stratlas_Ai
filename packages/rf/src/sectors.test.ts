import { describe, expect, it } from 'vitest';
import type { RfSectorsFile } from '@aio/schema';
import {
  SECTOR_GAP_DEG,
  findOrphans,
  groupSectors,
  proposeSectors,
  reassignOrphan,
  removeOrphan,
  unitEligibility,
  type RfUnit,
} from './sectors';

function unit(id: string, az: number | null, over: Partial<RfUnit> = {}): RfUnit {
  return {
    id,
    kind: 'panel',
    status: 'accepted',
    azimuthGridDeg: az === null ? undefined : { value: az },
    convergenceDeg: 0,
    ...over,
  };
}

describe('groupSectors', () => {
  it('uses a 30 degree gap', () => {
    expect(SECTOR_GAP_DEG).toBe(30);
  });

  it('groups three sectors and names them S1, S2, S3 clockwise from north', () => {
    const s = groupSectors([
      { id: 'ant-c1', trueAzimuthDeg: 242 },
      { id: 'ant-a1', trueAzimuthDeg: 2 },
      { id: 'ant-b1', trueAzimuthDeg: 118 },
      { id: 'ant-a2', trueAzimuthDeg: 8 },
      { id: 'ant-b2', trueAzimuthDeg: 125 },
      { id: 'ant-c2', trueAzimuthDeg: 236 },
    ]);
    expect(s.map((x) => x.name)).toEqual(['S1', 'S2', 'S3']);
    expect(s.map((x) => x.id)).toEqual(['sec-s1', 'sec-s2', 'sec-s3']);
    expect(s.map((x) => [...x.antennaIds].sort())).toEqual([
      ['ant-a1', 'ant-a2'],
      ['ant-b1', 'ant-b2'],
      ['ant-c1', 'ant-c2'],
    ]);
    expect(s[0]?.meanBearingDeg).toBeCloseTo(5, 9);
  });

  it('keeps 359 and 1 degrees in one sector across north', () => {
    const s = groupSectors([
      { id: 'ant-x', trueAzimuthDeg: 359 },
      { id: 'ant-y', trueAzimuthDeg: 1 },
      { id: 'ant-z', trueAzimuthDeg: 180 },
    ]);
    expect(s).toHaveLength(2);
    expect([...(s[0]?.antennaIds ?? [])].sort()).toEqual(['ant-x', 'ant-y']);
    expect(s[0]?.name).toBe('S1');
    expect(Math.min(s[0]?.meanBearingDeg ?? 99, 360 - (s[0]?.meanBearingDeg ?? 99))).toBeLessThan(
      1e-9,
    );
    expect(s[1]?.antennaIds).toEqual(['ant-z']);
  });

  it('chains neighbours within 30 degrees and splits beyond', () => {
    expect(
      groupSectors([
        { id: 'ant-a', trueAzimuthDeg: 0 },
        { id: 'ant-b', trueAzimuthDeg: 30 },
      ]),
    ).toHaveLength(1);
    expect(
      groupSectors([
        { id: 'ant-a', trueAzimuthDeg: 0 },
        { id: 'ant-b', trueAzimuthDeg: 31 },
      ]),
    ).toHaveLength(2);
  });

  it('returns nothing for no units', () => {
    expect(groupSectors([])).toEqual([]);
  });
});

describe('unitEligibility', () => {
  it('takes accepted panels by default', () => {
    expect(unitEligibility(unit('ant-a', 10))).toEqual({
      eligible: true,
      reason: null,
      canInclude: true,
      unreviewed: false,
    });
  });
  it('lists short units greyed, includable by hand', () => {
    const u = unit('ant-a', 10, { kind: 'short' });
    expect(unitEligibility(u)).toMatchObject({
      eligible: false,
      reason: 'short',
      canInclude: true,
    });
    expect(unitEligibility(u, { included: true })).toMatchObject({ eligible: true, reason: null });
  });
  it('never takes dishes or other units', () => {
    for (const kind of ['dish', 'other'] as const) {
      expect(unitEligibility(unit('ant-a', 10, { kind }), { included: true })).toMatchObject({
        eligible: false,
        reason: kind,
        canInclude: false,
      });
    }
  });
  it('previews draft units by hand and marks them unreviewed', () => {
    const u = unit('ant-a', 10, { status: 'draft' });
    expect(unitEligibility(u)).toMatchObject({
      eligible: false,
      reason: 'draft',
      canInclude: true,
    });
    expect(unitEligibility(u, { included: true })).toMatchObject({
      eligible: true,
      unreviewed: true,
    });
  });
  it('refuses rejected, not-found, inactive, no-azimuth and no-CRS units with a reason', () => {
    expect(unitEligibility(unit('ant-a', 10, { status: 'rejected' })).reason).toBe('rejected');
    expect(unitEligibility(unit('ant-a', 10, { notFoundInLatest: true })).reason).toBe('not-found');
    expect(unitEligibility(unit('ant-a', 10), { rfActive: false }).reason).toBe('inactive');
    expect(unitEligibility(unit('ant-a', 10, { user: { active: false } })).reason).toBe('inactive');
    expect(unitEligibility(unit('ant-a', null)).reason).toBe('no-azimuth');
    expect(unitEligibility(unit('ant-a', 10, { convergenceDeg: null })).reason).toBe('no-crs');
    expect(
      unitEligibility(unit('ant-a', 10, { convergenceDeg: null }), { included: true }).eligible,
    ).toBe(false);
  });
});

describe('proposeSectors', () => {
  it('groups eligible units on true azimuth (grid azimuth + convergence)', () => {
    const units = [
      unit('ant-a', 355, { convergenceDeg: 10 }), // true 5
      unit('ant-b', 0, { convergenceDeg: 10 }), // true 10
      unit('ant-c', 170, { convergenceDeg: 10 }), // true 180
      unit('ant-d', 90, { kind: 'dish', convergenceDeg: 10 }),
    ];
    const s = proposeSectors(units);
    expect(s.map((x) => x.antennaIds)).toEqual([['ant-a', 'ant-b'], ['ant-c']]);
  });
  it('includes units picked by hand', () => {
    const units = [unit('ant-a', 10), unit('ant-s', 200, { kind: 'short' })];
    expect(proposeSectors(units)).toHaveLength(1);
    expect(proposeSectors(units, new Set(['ant-s']))).toHaveLength(2);
  });
});

describe('orphans', () => {
  const file: Pick<RfSectorsFile, 'sectors' | 'antennas'> = {
    sectors: [
      { id: 'sec-s1', name: 'S1', antennaIds: ['ant-a', 'ant-gone'] },
      { id: 'sec-s2', name: 'S2', antennaIds: ['ant-rej'] },
    ],
    antennas: [
      { antennaId: 'ant-a', active: true, carriers: [] },
      { antennaId: 'ant-gone', active: true, carriers: [], etiltDeg: 4 },
      { antennaId: 'ant-rej', active: true, carriers: [] },
      { antennaId: 'ant-nf', active: true, carriers: [] },
    ],
  };
  const units = [
    unit('ant-a', 10),
    unit('ant-rej', 120, { status: 'rejected' }),
    unit('ant-nf', 240, { notFoundInLatest: true }),
    unit('ant-new', 15),
  ];

  it('flags removed, rejected and not-found units, never deleting them', () => {
    expect(findOrphans(file, units)).toEqual([
      { antennaId: 'ant-gone', reason: 'removed', sectorId: 'sec-s1' },
      { antennaId: 'ant-rej', reason: 'rejected', sectorId: 'sec-s2' },
      { antennaId: 'ant-nf', reason: 'not-found', sectorId: null },
    ]);
    expect(file.antennas).toHaveLength(4);
  });

  it('removes an orphan from the settings and its sector', () => {
    const out = removeOrphan(file, 'ant-gone');
    expect(out.antennas.map((a) => a.antennaId)).toEqual(['ant-a', 'ant-rej', 'ant-nf']);
    expect(out.sectors[0]?.antennaIds).toEqual(['ant-a']);
    expect(file.sectors[0]?.antennaIds).toEqual(['ant-a', 'ant-gone']);
  });

  it('reassigns an orphan to another unit, keeping its settings and sector', () => {
    const out = reassignOrphan(file, 'ant-gone', 'ant-new');
    expect(out.antennas.find((a) => a.antennaId === 'ant-new')?.etiltDeg).toBe(4);
    expect(out.antennas.some((a) => a.antennaId === 'ant-gone')).toBe(false);
    expect(out.sectors[0]?.antennaIds).toEqual(['ant-a', 'ant-new']);
  });

  it('refuses to reassign onto a unit that already has settings', () => {
    expect(() => reassignOrphan(file, 'ant-gone', 'ant-a')).toThrow(/already has RF settings/);
  });
});
