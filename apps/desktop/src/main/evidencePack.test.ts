import { describe, expect, it } from 'vitest';
import { EVIDENCE_PACK_FEATURE, evidencePackRefusal } from './evidencePack';

describe('pack gate for model.evidence', () => {
  it('requires the repaired processing tools for model.evidence only', () => {
    expect(evidencePackRefusal('model.evidence', '0.13.0')).toBe(
      'Measuring an engineered asset needs processing tools 0.13.1 or later (these are 0.13.0). Update them in Settings, Processing tools.',
    );
    expect(evidencePackRefusal('model.evidence', '0.10.0')).toBe(
      'Measuring an engineered asset needs processing tools 0.13.1 or later (these are 0.10.0). Update them in Settings, Processing tools.',
    );
    expect(evidencePackRefusal('model.evidence', '0.13.1')).toBeNull();
    expect(evidencePackRefusal('model.evidence', '0.14.0')).toBeNull();
    expect(evidencePackRefusal('model.evidence', 'dev')).toBeNull();
    expect(evidencePackRefusal('model.evidence', null)).toBeNull();
    expect(evidencePackRefusal('model.fit_cloud', '0.8.0')).toBeNull();
  });
  it('lists the feature for Settings, Processing tools', () => {
    expect(EVIDENCE_PACK_FEATURE).toEqual({
      label: 'Measuring an engineered asset',
      minVersion: '0.13.1',
    });
  });
});
