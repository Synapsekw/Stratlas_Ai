import { RECORD_KINDS } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { lww, MERGE_RULES, type Stamped } from './index';

const at = (hlc: string, op: string, value: number): Stamped<number> => ({ hlc, op, value });

describe('@aio/merge (T0)', () => {
  it('has a rule for every record kind an op can target', () => {
    expect(Object.keys(MERGE_RULES).sort()).toEqual([...RECORD_KINDS].sort());
    expect(MERGE_RULES.issue).toBe('lww-field');
    expect(MERGE_RULES.comment).toBe('grow-only');
  });

  it('picks the last writer by clock, whatever the order of arrival', () => {
    const a = at('1790000000000.0000.d_a', 'aa', 3);
    const b = at('1790000000000.0001.d_a', 'bb', 4);
    const c = at('1790000000000.0001.d_a', 'cc', 5);
    expect(lww(a, b)).toBe(b);
    expect(lww(b, a)).toBe(b);
    expect(lww(b, c)).toBe(lww(c, b));
    expect(lww(lww(a, b), c)).toBe(lww(a, lww(b, c)));
    expect(lww(a, a)).toBe(a);
  });
});
