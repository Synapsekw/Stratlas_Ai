import { describe, expect, it } from 'vitest';
import { EVIDENCE_PACK_FEATURE, evidencePackRefusal } from './evidencePack';

describe('pack gate for model.evidence', () => {
  it('asks for processing tools 0.11.0 for model.evidence only', () => {
    expect(evidencePackRefusal('model.evidence', '0.10.0')).toBe(
      'Measuring an engineered asset needs processing tools 0.11.0 or later (these are 0.10.0). Update them in Settings, Processing tools.',
    );
    expect(evidencePackRefusal('model.evidence', '0.11.0')).toBeNull();
    expect(evidencePackRefusal('model.evidence', '0.12.0')).toBeNull();
    expect(evidencePackRefusal('model.evidence', 'dev')).toBeNull();
    expect(evidencePackRefusal('model.evidence', null)).toBeNull();
    expect(evidencePackRefusal('model.fit_cloud', '0.8.0')).toBeNull();
  });
  it('lists the feature for Settings, Processing tools', () => {
    expect(EVIDENCE_PACK_FEATURE).toEqual({
      label: 'Measuring an engineered asset',
      minVersion: '0.11.0',
    });
  });
});
