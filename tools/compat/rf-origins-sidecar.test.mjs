// RF origins (spec 2026-10-18-rf-coverage-simplify, "Data") are additive, pinned against the 0.21
// `aio.rf-sectors/1` schema (tools/compat/rf-sectors-v1, extracted from 6a2ba0dc):
// - who set each planned value lives in the sidecar `rf/sectors.origins.json` (`aio.rf-origins/1`),
//   a file 0.21 never opens;
// - `rf/sectors.json` as this build writes it (`splitRfOrigins`) has no origin key, so 0.19 to
//   0.21 read it, and their strict schema keeps every value.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v1 from './rf-sectors-v1/rf.mjs';

/** A plan in memory: one unit by the AI (equipment) and the rules (carrier), one by hand. */
function planned() {
  return {
    schema: 'aio.rf-sectors/1',
    sectors: [{ id: 'sec-a', name: 'Sector A', antennaIds: ['ant-a', 'ant-b'] }],
    antennas: [
      {
        antennaId: 'ant-a',
        equipment: { kind: 'aau', aau: 'generic-aau-64t' },
        etiltDeg: 4,
        active: true,
        origins: { equipment: { by: 'ai', confidence: 'medium' }, etiltDeg: { by: 'user' } },
        carriers: [
          {
            id: 'c1',
            tech: 'nr',
            band: 'n78',
            bandwidthMhz: 100,
            feederLossDb: 0,
            origin: { by: 'rules', confidence: 'low' },
          },
        ],
      },
      { antennaId: 'ant-b', active: true, carriers: [] },
    ],
    study: current.DEFAULT_RF_STUDY,
  };
}

describe('rf origins are additive', () => {
  it('0.21 refuses origin keys inside rf/sectors.json (why they live in a sidecar)', () => {
    expect(v1.parseRfSectors(planned()).ok).toBe(false);
  });

  it('0.21 reads the sectors file this build writes, keeping every value', () => {
    const { file } = current.splitRfOrigins(planned());
    const disk = JSON.parse(JSON.stringify(file));
    const old = v1.parseRfSectors(disk);
    expect(old.ok).toBe(true);
    expect(old.value).toEqual(current.RfSectorsFile.parse(disk));
  });

  it('the sidecar is a family 0.21 does not know, at its own path', () => {
    expect(v1.RF_SECTORS_PATH).toBe('rf/sectors.json');
    expect(current.RF_ORIGINS_PATH).toBe('rf/sectors.origins.json');
    expect(Object.values(v1)).not.toContain(current.RF_ORIGINS_PATH);
  });

  it('a file 0.21 saved opens here with every value counted as the person’s', () => {
    const { file } = current.splitRfOrigins(planned());
    const old = v1.parseRfSectors(JSON.parse(JSON.stringify(file)));
    const read = current.parseRfSectors(JSON.parse(JSON.stringify(old.value)));
    expect(read.ok).toBe(true);
    const merged = current.mergeRfOrigins(read.value, undefined);
    expect(merged.antennas.every((a) => a.origins === undefined)).toBe(true);
    expect(merged.antennas.flatMap((a) => a.carriers).every((c) => c.origin === undefined)).toBe(
      true,
    );
  });
});
