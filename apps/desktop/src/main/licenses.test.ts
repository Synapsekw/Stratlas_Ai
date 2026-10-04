import { describe, expect, it } from 'vitest';
import { licenseEntries } from './licenses';

describe('licenseEntries', () => {
  it('flattens the pnpm licence report, sorted by name, without workspace packages', () => {
    const report = {
      MIT: [
        { name: 'zustand', versions: ['5.0.15'], license: 'MIT', homepage: 'https://zustand' },
        { name: '@aio/ui', versions: ['0.1.0'], license: 'MIT' },
        { name: 'react', versions: ['19.3.0', '19.2.0'], license: 'MIT', author: 'Meta' },
      ],
      'BSD-3-Clause': [{ name: 'maplibre-gl', versions: ['6.11.2'], license: 'BSD-3-Clause' }],
    };
    expect(licenseEntries(report)).toEqual([
      { name: 'maplibre-gl', version: '6.11.2', license: 'BSD-3-Clause' },
      { name: 'react', version: '19.3.0, 19.2.0', license: 'MIT', author: 'Meta' },
      { name: 'zustand', version: '5.0.15', license: 'MIT', homepage: 'https://zustand' },
    ]);
  });

  it('copes with an empty or odd report', () => {
    expect(licenseEntries({})).toEqual([]);
    expect(licenseEntries(null)).toEqual([]);
    expect(licenseEntries({ MIT: 'nope' })).toEqual([]);
  });
});
