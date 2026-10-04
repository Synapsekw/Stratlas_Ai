import { describe, expect, it } from 'vitest';
import { defaultSize } from './pool';

describe('defaultSize', () => {
  it('uses half the logical cores, between 2 and 8 workers', () => {
    expect(defaultSize(24)).toBe(8);
    expect(defaultSize(6)).toBe(3);
    expect(defaultSize(1)).toBe(2);
  });
});
