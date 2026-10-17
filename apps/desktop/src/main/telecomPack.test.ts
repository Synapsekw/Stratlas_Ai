import { describe, expect, it } from 'vitest';
import { ANTENNA_PACK_FEATURE, antennaPackRefusal } from './telecomPack';

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
