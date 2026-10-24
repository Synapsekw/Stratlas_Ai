import type { VlmDetector } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { checkOptions, sameCheck, type DetectorItem } from './checks';

const CLASSES = [
  { id: 'corrosion', label: 'Corrosion' },
  { id: 'crack', label: 'Crack' },
];
const detector = (id: string, name: string): DetectorItem => ({
  where: 'library',
  detector: { id, name, classId: 'corrosion', threshold: 0.7 } as unknown as VlmDetector,
  modelMismatch: false,
});
const DETECTORS = [detector('rust-v1', 'Rust finder')];

describe('Ask AI checks', () => {
  it('offers everything, then each class, then each installed detector', () => {
    expect(checkOptions(CLASSES, DETECTORS, 'auto')).toEqual([
      { check: { kind: 'everything' }, label: "Everything in this project's classes" },
      { check: { kind: 'class', classId: 'corrosion' }, label: 'Corrosion' },
      { check: { kind: 'class', classId: 'crack' }, label: 'Crack' },
      {
        check: { kind: 'detector', where: 'library', id: 'rust-v1' },
        label: 'Rust finder (local detector)',
      },
    ]);
  });

  it('offers no local detector under Cloud', () => {
    expect(checkOptions(CLASSES, DETECTORS, 'cloud').map((o) => o.check.kind)).toEqual([
      'everything',
      'class',
      'class',
    ]);
  });

  it('compares checks by what they look for', () => {
    expect(sameCheck({ kind: 'everything' }, { kind: 'everything' })).toBe(true);
    expect(sameCheck({ kind: 'class', classId: 'a' }, { kind: 'class', classId: 'a' })).toBe(true);
    expect(sameCheck({ kind: 'class', classId: 'a' }, { kind: 'class', classId: 'b' })).toBe(false);
    expect(
      sameCheck(
        { kind: 'detector', where: 'library', id: 'x' },
        { kind: 'detector', where: 'project', id: 'x' },
      ),
    ).toBe(false);
    expect(sameCheck({ kind: 'everything' }, { kind: 'class', classId: 'a' })).toBe(false);
  });
});
