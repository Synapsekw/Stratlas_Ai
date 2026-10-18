import { describe, expect, it } from 'vitest';
import type { AntennaUnit, RfSector } from '@aio/schema';
import { unit } from '../__fixtures__/rfData';
import { planSectors } from './sectors';

const units = (azs: number[]): AntennaUnit[] => azs.map((a, i) => unit(`u${String(i)}`, a));
const draft = (id: string, az: number) => unit(id, az, { status: 'draft' });
const noCrs = (id: string) => unit(id, 10, { convergenceDeg: null });

describe('planSectors', () => {
  it('groups by bearing when there are no sectors', () => {
    const r = planSectors(units([0, 120, 240]), []);
    expect(r.regrouped).toBe(true);
    expect(r.sectors.map((s) => s.name)).toEqual(['S1', 'S2', 'S3']);
  });
  it('keeps existing sectors, names and membership', () => {
    const cur: RfSector[] = [{ id: 'sec-a', name: 'North', antennaIds: ['u0'] }];
    const r = planSectors(units([0, 120]), cur);
    expect(r.sectors[0]).toEqual({ id: 'sec-a', name: 'North', antennaIds: ['u0'] });
    expect(r.regrouped).toBe(false);
  });
  it('adds an unsectored unit to the nearest sector within 30°, else a new one', () => {
    const cur: RfSector[] = [{ id: 'sec-a', name: 'North', antennaIds: ['u0'] }];
    const r = planSectors(units([0, 20, 180]), cur);
    expect(r.sectors.find((s) => s.id === 'sec-a')?.antennaIds).toEqual(['u0', 'u1']);
    expect(r.sectors.some((s) => s.antennaIds.includes('u2') && s.id !== 'sec-a')).toBe(true);
  });
  it('lists drafts and units without a bearing as left out', () => {
    const r = planSectors([...units([0]), draft('d1', 90), noCrs('n1')], []);
    expect(r.leftOut).toEqual(
      expect.arrayContaining([
        { unitId: 'd1', reason: 'draft' },
        { unitId: 'n1', reason: 'no-azimuth' },
      ]),
    );
    expect(r.sectors.flatMap((s) => s.antennaIds)).toEqual(['u0']);
  });
  it('maps other reasons and never puts them in a sector', () => {
    const us = [
      unit('k', 0, { kind: 'dish' }),
      unit('r', 0, { status: 'rejected' }),
      unit('i', 0, { user: { active: false } }),
    ];
    const r = planSectors(us, []);
    expect(r.leftOut).toEqual([
      { unitId: 'k', reason: 'not-panel' },
      { unitId: 'r', reason: 'rejected' },
      { unitId: 'i', reason: 'inactive' },
    ]);
    expect(r.sectors).toEqual([]);
  });
  it('uses the next free sec-s<n> id for a new sector', () => {
    const cur: RfSector[] = [{ id: 'sec-s1', name: 'S1', antennaIds: ['u0'] }];
    const r = planSectors(units([0, 180]), cur);
    expect(r.sectors.map((s) => s.id)).toEqual(['sec-s1', 'sec-s2']);
  });
  it('does not mutate the current sectors', () => {
    const cur: RfSector[] = [{ id: 'sec-a', name: 'North', antennaIds: ['u0'] }];
    planSectors(units([0, 20]), cur);
    expect(cur[0]?.antennaIds).toEqual(['u0']);
  });
});
