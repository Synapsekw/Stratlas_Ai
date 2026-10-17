import { RF_COVERAGE_MIN_PACK } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { RF_PACK_FEATURE, rfPackRefusal } from './rfPack';

describe('pack gate for rf.coverage', () => {
  it('refuses an older pack with the update message, for rf.coverage only', () => {
    expect(rfPackRefusal('rf.coverage', '0.13.1')).toBe(
      `Coverage prediction for telecom sites needs processing tools ${RF_COVERAGE_MIN_PACK} or later (these are 0.13.1). Update them in Settings, Processing tools.`,
    );
    expect(rfPackRefusal('rf.coverage', RF_COVERAGE_MIN_PACK)).toBeNull();
    expect(rfPackRefusal('rf.coverage', '99.0.0')).toBeNull();
    expect(rfPackRefusal('rf.coverage', 'dev')).toBeNull();
    expect(rfPackRefusal('rf.coverage', null)).toBeNull();
    expect(rfPackRefusal('telecom.antennas', '0.1.0')).toBeNull();
  });
  it('lists the feature for Settings, Processing tools', () => {
    expect(RF_PACK_FEATURE).toEqual({
      label: 'Coverage prediction for telecom sites',
      minVersion: RF_COVERAGE_MIN_PACK,
    });
  });
});
