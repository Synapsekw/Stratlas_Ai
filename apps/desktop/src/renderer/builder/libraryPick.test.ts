import type { LibraryClass, SeverityTemplate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { libraryChoices, pickedEntries } from './libraryPick';

const lib: LibraryClass[] = [
  { label: 'Crack', color: '#e5484d' },
  { label: 'Spalling', color: '#7cc46b', hotkey: 's' },
];
const template: SeverityTemplate = {
  id: 'general-inspection',
  label: 'General',
  source: 'Built in',
  model: {
    id: 'g',
    name: 'G',
    levels: [{ value: 1, label: 'Minor', color: '#000000', criteria: '' }],
  },
  catalogue: {
    id: 'c',
    name: 'C',
    assetType: 'asset',
    classes: [{ id: 'crack', label: 'crack', color: '#000000', severityModel: 'g' }],
  },
};

describe('class library in the wizard', () => {
  it('marks library classes the template has already (any case)', () => {
    expect(libraryChoices(lib, template).map((c) => [c.cls.label, c.inTemplate])).toEqual([
      ['Crack', true],
      ['Spalling', false],
    ]);
    expect(libraryChoices(lib, undefined).every((c) => !c.inTemplate)).toBe(true);
  });

  it('adds only ticked classes the template does not have', () => {
    expect(
      pickedEntries(lib, new Set(['Crack', 'Spalling']), template).map((c) => c.label),
    ).toEqual(['Spalling']);
  });
});
