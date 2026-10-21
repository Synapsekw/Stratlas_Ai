import { describe, expect, it } from 'vitest';
import { csvText } from './csv';

describe('csvText', () => {
  it.each(['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx'])(
    'neutralises %j',
    (v) => {
      expect(csvText(v)).toBe(`'${v}`);
    },
  );

  it('leaves ordinary text alone', () => {
    expect(csvText('Cracked pane')).toBe('Cracked pane');
    expect(csvText('')).toBe('');
    expect(csvText('a=b')).toBe('a=b');
  });
});
