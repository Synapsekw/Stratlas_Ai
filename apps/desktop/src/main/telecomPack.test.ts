import { readFileSync } from 'node:fs';
import { AntennasFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  ANTENNA_FLAG_PACK_FEATURE,
  ANTENNA_PACK_FEATURE,
  antennaPackRefusal,
  hasPersonOwned,
} from './telecomPack';

const contract = JSON.parse(
  readFileSync(
    new URL('../../../../packages/schema/src/__fixtures__/antennas-contract.json', import.meta.url),
    'utf8',
  ),
) as { example: { units: Record<string, unknown>[] }; flagged: Record<string, unknown> };
const detectedOnly = (): AntennasFile => {
  const units = contract.example.units.map((u) => ({ ...u, user: {} }));
  return AntennasFile.parse({ ...contract.example, units });
};
const withFlagged = (): AntennasFile =>
  AntennasFile.parse({
    ...contract.example,
    units: [...contract.example.units, contract.flagged],
  });

describe('pack gate for telecom.antennas', () => {
  it('requires processing tools 0.14.0 for telecom.antennas only', () => {
    expect(antennaPackRefusal('telecom.antennas', '0.13.1')).toBe(
      'Antenna detection needs processing tools 0.14.0 or later (these are 0.13.1). Update them in Settings, Processing tools.',
    );
    expect(antennaPackRefusal('telecom.antennas', '0.10.0')).toContain('(these are 0.10.0)');
    expect(antennaPackRefusal('telecom.antennas', '0.14.0')).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', '0.15.2')).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', 'dev')).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', null)).toBeNull();
    expect(antennaPackRefusal('model.evidence', '0.10.0')).toBeNull();
  });
  it('lists the feature for Settings, Processing tools', () => {
    expect(ANTENNA_PACK_FEATURE).toEqual({ label: 'Antenna detection', minVersion: '0.14.0' });
  });
});

describe('pack gate for telecom.flag', () => {
  it('requires 0.23.0 for telecom.flag', () => {
    expect(antennaPackRefusal('telecom.flag', '0.22.0')).toBe(
      'Antenna flagging needs processing tools 0.23.0 or later (these are 0.22.0). Update them in Settings, Processing tools.',
    );
    expect(antennaPackRefusal('telecom.flag', '0.23.0')).toBeNull();
    expect(antennaPackRefusal('telecom.flag', 'dev')).toBeNull();
    expect(antennaPackRefusal('telecom.flag', null)).toBeNull();
  });
  it('lists the feature', () => {
    expect(ANTENNA_FLAG_PACK_FEATURE).toEqual({ label: 'Antenna flagging', minVersion: '0.23.0' });
  });
  it('refuses telecom.antennas below 0.23.0 only when a person owns something in the file', () => {
    const msg =
      'Antenna flagging needs processing tools 0.23.0 or later (these are 0.22.0). Update them in Settings, Processing tools.';
    expect(antennaPackRefusal('telecom.antennas', '0.22.0', withFlagged())).toBe(msg);
    expect(antennaPackRefusal('telecom.antennas', '0.22.0', detectedOnly())).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', '0.22.0', null)).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', '0.23.0', withFlagged())).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', 'dev', withFlagged())).toBeNull();
  });
  it('knows person-owned units', () => {
    expect(hasPersonOwned(detectedOnly())).toBe(false);
    expect(hasPersonOwned(withFlagged())).toBe(true);
    const f = detectedOnly();
    const u = f.units[0];
    if (!u) throw new Error('no unit');
    u.downtiltDeg = {
      value: 3,
      basis: 'user',
      quality: { ...(u.azimuthGridDeg?.quality ?? { basis: 'geometry' }), basis: 'user' },
    } as never;
    expect(hasPersonOwned(f)).toBe(true);
  });
});
