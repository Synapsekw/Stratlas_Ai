import { describe, expect, it } from 'vitest';
import { parseFlight } from './flight';

const good = {
  schema: 'aio.flight/1',
  startUtcMs: 1676970000000,
  lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
  samples: [
    { t: 0, pos: [0, 10, 0], q: [0, 0, 0, 1] },
    { t: 100, pos: [1, 10, 0], q: [0, 0, 0, 1] },
  ],
};

describe('parseFlight', () => {
  it('accepts a valid aio.flight/1 document', () => {
    const f = parseFlight(good);
    expect(f.startUtcMs).toBe(1676970000000);
    expect(f.lens).toEqual({ model: 'ftheta', hfovDeg: 114, aspect: 1.7778 });
    expect(f.samples).toHaveLength(2);
    expect(f.durationMs).toBe(100);
  });

  it('accepts a JSON string', () => {
    expect(parseFlight(JSON.stringify(good)).samples).toHaveLength(2);
  });

  it('rejects another schema tag', () => {
    expect(() => parseFlight({ ...good, schema: 'aio.flight/2' })).toThrow(
      'Flight file: expected schema "aio.flight/1"',
    );
  });

  it('rejects malformed JSON text with a clear message', () => {
    expect(() => parseFlight('{nope')).toThrow('Flight file is not valid JSON');
  });

  it('names the bad sample', () => {
    const bad = { ...good, samples: [good.samples[0], { t: 100, pos: [1, 2], q: [0, 0, 0, 1] }] };
    expect(() => parseFlight(bad)).toThrow('Flight file: sample 1');
  });

  it('rejects samples out of time order', () => {
    const bad = { ...good, samples: [good.samples[1], good.samples[0]] };
    expect(() => parseFlight(bad)).toThrow('not sorted by time');
  });

  it('rejects an empty sample list', () => {
    expect(() => parseFlight({ ...good, samples: [] })).toThrow('at least one sample');
  });

  it('rejects a bad lens', () => {
    expect(() =>
      parseFlight({ ...good, lens: { model: 'pinhole', hfovDeg: 200, aspect: 1 } }),
    ).toThrow('Flight file: lens');
  });

  it('normalises quaternions and rejects zero ones', () => {
    const f = parseFlight({ ...good, samples: [{ t: 0, pos: [0, 0, 0], q: [0, 0, 0, 2] }] });
    expect(f.samples[0]?.q).toEqual([0, 0, 0, 1]);
    expect(() =>
      parseFlight({ ...good, samples: [{ t: 0, pos: [0, 0, 0], q: [0, 0, 0, 0] }] }),
    ).toThrow('zero quaternion');
  });
});
