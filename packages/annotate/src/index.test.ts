import { describe, expect, it } from 'vitest';
import { nextIssueCode } from './index';

describe('nextIssueCode', () => {
  it('starts at 01', () => {
    expect(nextIssueCode([], 'F')).toBe('F01');
  });

  it('continues after the highest', () => {
    expect(nextIssueCode(['F01', 'F11', 'D03'], 'F')).toBe('F12');
  });

  it('rolls past 99', () => {
    expect(nextIssueCode(['F99'], 'F')).toBe('F100');
  });

  it('rejects a bad prefix', () => {
    expect(() => nextIssueCode([], 'f')).toThrow('capital letters');
  });
});
