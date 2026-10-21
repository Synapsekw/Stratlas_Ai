import { describe, expect, it } from 'vitest';
import { loadJournal } from './load';
import { readSegment } from './segment';
import { strictJsonProblem } from './strict';

/**
 * Journal lines are hashed as RFC 8785 text of what a parser reads, so a line two parsers could
 * read differently must not count: duplicate keys (which one wins?), lone surrogates (no UTF-8
 * form) and integers past 2^53 (rounded on parse) are refused with the line's number.
 */
describe('strict journal lines', () => {
  it('refuses a duplicate key, even nested', () => {
    const [top] = readSegment('{"id":"a","kind":"x","kind":"y"}\n');
    expect(top).toMatchObject({ line: 1, ok: false });
    expect(top?.ok === false && top.error).toMatch(/twice/);
    const [nested] = readSegment('{"payload":{"role":"viewer","role":"owner"}}\n');
    expect(nested?.ok).toBe(false);
  });

  it('refuses a duplicate key written with an escape', () => {
    const [l] = readSegment('{"kind":"x","\\u006bind":"y"}\n');
    expect(l?.ok).toBe(false);
  });

  it('refuses a lone surrogate in a value or a key', () => {
    expect(readSegment('{"name":"\\ud800"}\n')[0]?.ok).toBe(false);
    expect(readSegment('{"\\udc00":1}\n')[0]?.ok).toBe(false);
    // a proper pair is fine
    expect(readSegment('{"name":"\\ud83d\\ude00"}\n')[0]?.ok).toBe(true);
  });

  it('refuses an integer beyond 2^53 and a number that is not finite', () => {
    expect(readSegment('{"seq":9007199254740993}\n')[0]?.ok).toBe(false);
    expect(readSegment('{"seq":9007199254740992}\n')[0]?.ok).toBe(false);
    expect(readSegment('{"x":1e400}\n')[0]?.ok).toBe(false);
    expect(readSegment('{"seq":9007199254740991,"x":-1.5e-3}\n')[0]?.ok).toBe(true);
  });

  it('keeps ordinary lines, keys equal to values and the same key in sibling objects', () => {
    const [l] = readSegment(
      '{"a":"a","b":{"a":1},"c":[{"a":1},{"a":2}],"d":"x\\"y","e":true,"f":null}\n',
    );
    expect(l?.ok).toBe(true);
  });

  it('device and checkpoint files are read the same way', () => {
    const j = loadJournal(
      new Map([
        ['journal/devices/d_x.json', '{"id":"d_x","key":"a","key":"b"}'],
        ['journal/checkpoints/c.json', '{"id":"c","id":"d"}'],
      ]),
    );
    expect(j.devices.get('d_x')?.raw).toBeNull();
    expect(j.checkpoints[0]?.raw).toBeNull();
  });

  it('names nothing on valid text', () => {
    expect(strictJsonProblem('{"a":[1,2,{"b":"c"}]}')).toBeNull();
  });
});
