import { describe, expect, it } from 'vitest';
import { createSectionStore, filterSections } from './sectionState';

function memory(initial?: string): Storage {
  const m = new Map<string, string>(initial ? [['quadrion.sections', initial]] : []);
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as unknown as Storage;
}

describe('filterSections', () => {
  const sections = [
    { id: 'a', items: ['ruler', 'angle'] },
    { id: 'b', items: ['cloud'] },
  ];
  it('drops sections with no match and keeps only matching items', () => {
    expect(filterSections(sections, (s) => s.startsWith('r'))).toEqual([
      { id: 'a', items: ['ruler'] },
    ]);
  });
  it('keeps everything when all match, nothing when none do', () => {
    expect(filterSections(sections, () => true)).toHaveLength(2);
    expect(filterSections(sections, () => false)).toEqual([]);
  });
});

describe('section store', () => {
  it('persists per bench and restores', () => {
    const storage = memory();
    const s = createSectionStore(storage);
    s.getState().toggle('measure', 'a', false);
    const again = createSectionStore(storage);
    expect(again.getState().byBench.measure?.ids.a).toBe(true);
    expect(again.getState().byBench.display).toBeUndefined();
  });
  it('ignores malformed storage and survives a throwing one', () => {
    expect(
      createSectionStore(memory('{"measure":{"ids":{"a":"x"},"all":3}}')).getState().byBench,
    ).toEqual({ measure: { ids: {} } });
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const s = createSectionStore(bad);
    expect(() => {
      s.getState().setAll('measure', true);
    }).not.toThrow();
  });
});
