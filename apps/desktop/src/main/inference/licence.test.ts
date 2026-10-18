import { describe, expect, it } from 'vitest';
import { licenceProblem, licenceWarning } from './licence';

describe('licence gate for detector models', () => {
  it('refuses only a missing licence', () => {
    for (const l of ['', '   ', '()'])
      expect(licenceProblem(l), l).toBe(
        'The model card gives no licence. Models without a licence cannot be imported.',
      );
    for (const l of ['MIT', 'AGPL-3.0-only', 'CC-BY-NC-4.0', 'NOASSERTION', 'Proprietary-Thing'])
      expect(licenceProblem(l), l).toBeNull();
  });

  it('gives no warning for permissive licences and expressions of them', () => {
    for (const l of [
      'MIT',
      'Apache-2.0',
      'BSD-3-Clause',
      'CC0-1.0',
      'CC-BY-4.0',
      'Apache-2.0 OR MIT',
      '(MIT AND BSD-2-Clause)',
      'Apache-2.0 WITH LLVM-exception',
    ])
      expect(licenceWarning(l), l).toBeNull();
  });

  it('gives no warning for a commercial licence the person holds (LicenseRef)', () => {
    expect(licenceWarning('LicenseRef-Ultralytics-Enterprise')).toBeNull();
  });

  it('warns copyleft for the GPL family and other share-alike or restricted weights', () => {
    for (const l of [
      'AGPL-3.0',
      'AGPL-3.0-only',
      'GPL-3.0-only',
      'GPL-2.0+',
      'GPL-3.0-or-later',
      'LGPL-2.1-only',
      'MPL-2.0',
      'EPL-2.0',
      'EUPL-1.2',
      'OSL-3.0',
      'SSPL-1.0',
      'CC-BY-SA-4.0',
      'CC-BY-ND-4.0',
      'OpenRAIL-M',
      'CreativeML-OpenRAIL-M',
      'Llama-3.1-Community',
      'Gemma',
      'GPL-2.0-only WITH Classpath-exception-2.0',
    ])
      expect(licenceWarning(l), l).toBe('copyleft');
  });

  it('warns non-commercial for CC-BY-NC in all its forms', () => {
    for (const l of ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-4.0'])
      expect(licenceWarning(l), l).toBe('non-commercial');
  });

  it('warns unknown for anything else', () => {
    for (const l of ['NOASSERTION', 'Proprietary-Thing', 'WTFPL-ish'])
      expect(licenceWarning(l), l).toBe('unknown');
    expect(licenceWarning('')).toBe('unknown');
  });

  it('AND takes the strictest part', () => {
    expect(licenceWarning('MIT AND AGPL-3.0')).toBe('copyleft');
    expect(licenceWarning('MIT AND CC-BY-NC-4.0')).toBe('non-commercial');
    expect(licenceWarning('AGPL-3.0 AND CC-BY-NC-4.0')).toBe('non-commercial');
    expect(licenceWarning('AGPL-3.0 AND Odd-Thing')).toBe('unknown');
  });

  it('OR: one clean alternative is enough, else the mildest warning', () => {
    expect(licenceWarning('AGPL-3.0 OR MIT')).toBeNull();
    expect(licenceWarning('CC-BY-NC-4.0 OR LicenseRef-Ultralytics-Enterprise')).toBeNull();
    expect(licenceWarning('(MIT AND GPL-3.0-only) OR Apache-2.0')).toBeNull();
    // mildest: copyleft < non-commercial < unknown
    expect(licenceWarning('CC-BY-NC-4.0 OR AGPL-3.0')).toBe('copyleft');
    expect(licenceWarning('Odd-Thing OR CC-BY-NC-4.0')).toBe('non-commercial');
    expect(licenceWarning('Odd-Thing OR GPL-3.0-only')).toBe('copyleft');
  });
});
