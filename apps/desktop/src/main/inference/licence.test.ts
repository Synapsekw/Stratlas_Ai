import { describe, expect, it } from 'vitest';
import { licenceProblem } from './licence';

describe('licence gate for detector models', () => {
  it('allows permissive licences and expressions of them', () => {
    for (const l of [
      'MIT',
      'Apache-2.0',
      'BSD-3-Clause',
      'CC0-1.0',
      'Apache-2.0 OR MIT',
      '(MIT AND BSD-2-Clause)',
    ])
      expect(licenceProblem(l), l).toBeNull();
  });

  it('allows a commercial licence the person holds (LicenseRef)', () => {
    expect(licenceProblem('LicenseRef-Ultralytics-Enterprise')).toBeNull();
  });

  it('refuses copyleft and non-commercial weights with the reason', () => {
    expect(licenceProblem('AGPL-3.0-only')).toBe(
      'AGPL-3.0-only is not allowed for detector models in this app (copyleft or non-commercial). Weights trained with Ultralytics YOLO are AGPL-3.0 unless you hold an Ultralytics Enterprise licence (then set the card licence to LicenseRef-Ultralytics-Enterprise).',
    );
    expect(licenceProblem('GPL-3.0-or-later')).toContain('GPL-3.0-or-later is not allowed');
    expect(licenceProblem('CC-BY-NC-4.0')).toContain('not allowed');
    expect(licenceProblem('MIT AND AGPL-3.0')).toContain('AGPL-3.0 is not allowed');
  });

  it('allows an OR choice when one side is allowed', () => {
    expect(licenceProblem('AGPL-3.0 OR MIT')).toBeNull();
  });

  it('refuses unknown or missing licences', () => {
    expect(licenceProblem('')).toBe(
      'The model card gives no licence. Models without a licence cannot be imported.',
    );
    expect(licenceProblem('NOASSERTION')).toContain(
      'NOASSERTION is not a licence this app accepts',
    );
    expect(licenceProblem('Proprietary-Thing')).toContain(
      'Proprietary-Thing is not a licence this app accepts',
    );
  });
});
