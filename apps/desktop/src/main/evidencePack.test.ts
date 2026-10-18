import { describe, expect, it } from 'vitest';
import {
  COMPONENT_EVIDENCE_PACK_FEATURE,
  EVIDENCE_PACK_FEATURE,
  evidencePackRefusal,
} from './evidencePack';

describe('pack gate for model.evidence', () => {
  it('requires the component-processing pack for new evidence jobs only', () => {
    expect(evidencePackRefusal('model.evidence', '0.13.0')).toBe(
      'Building engineering components needs processing tools 0.16.0 or later (these are 0.13.0). Update them in Settings, Processing tools.',
    );
    expect(evidencePackRefusal('model.evidence', '0.10.0')).toBe(
      'Building engineering components needs processing tools 0.16.0 or later (these are 0.10.0). Update them in Settings, Processing tools.',
    );
    expect(evidencePackRefusal('model.evidence', '0.13.1')).not.toBeNull();
    expect(evidencePackRefusal('model.evidence', '0.15.0')).not.toBeNull();
    expect(evidencePackRefusal('model.evidence', '0.16.0')).toBeNull();
    expect(evidencePackRefusal('model.evidence', 'dev')).toBeNull();
    expect(evidencePackRefusal('model.evidence', null)).toBeNull();
    expect(evidencePackRefusal('model.fit_cloud', '0.8.0')).toBeNull();
  });
  it('keeps saved legacy measurements compatible while enhanced resumes require their pack', () => {
    const legacy = { params: {}, packVersion: '0.13.1' };
    expect(evidencePackRefusal('model.evidence', '0.13.1', legacy)).toBeNull();
    expect(evidencePackRefusal('model.evidence', '0.13.0', legacy)).toContain('0.13.1');
    const enhanced = { params: { clouds: [{ layer: 'scan' }] }, packVersion: '0.16.0' };
    expect(evidencePackRefusal('model.evidence', '0.15.0', enhanced)).toContain('0.16.0');
    expect(evidencePackRefusal('model.evidence', '0.16.0', enhanced)).toBeNull();
    expect(evidencePackRefusal('model.evidence', '0.15.0', { params: { drawings: [] } })).toContain(
      '0.16.0',
    );
  });
  it('lists the feature for Settings, Processing tools', () => {
    expect(EVIDENCE_PACK_FEATURE).toEqual({
      label: 'Measuring an engineered asset',
      minVersion: '0.13.1',
    });
    expect(COMPONENT_EVIDENCE_PACK_FEATURE).toEqual({
      label: 'Building engineering components',
      minVersion: '0.16.0',
    });
  });
});
