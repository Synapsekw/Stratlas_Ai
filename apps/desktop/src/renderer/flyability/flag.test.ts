import { describe, expect, it } from 'vitest';
import { isInspectorUiOn } from './flag';

describe('the Flyability import flag', () => {
  it('the shipped flag is on', () => {
    expect(isInspectorUiOn()).toBe(true);
  });
});
