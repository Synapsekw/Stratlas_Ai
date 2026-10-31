import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayColour, flightlineColour, flightlinePoints, linesToDraw } from './flightlineModel';

describe('flightline model', () => {
  it('a flight line builds a polyline from its pose file in scene metres', () => {
    expect([...flightlinePoints([{ t: 0, pos: [1, 2, 3] }])]).toEqual([1, 2, 3]);
    const file = resolve(
      __dirname,
      '../../../../../packages/project/src/builder/flyability/__fixtures__/python-output/flight.json',
    );
    const { samples } = JSON.parse(readFileSync(file, 'utf8')) as {
      samples: { t: number; pos: [number, number, number] }[];
    };
    const pts = flightlinePoints(samples);
    expect(pts.length).toBeGreaterThanOrEqual(6);
    expect(pts.length % 3).toBe(0);
    expect([pts[0], pts[1], pts[2]]).toEqual([1, 1.5, -1]);
  });

  it('near-duplicate samples are merged', () => {
    const pts = flightlinePoints([
      { t: 0, pos: [0, 0, 0] },
      { t: 100, pos: [0.01, 0, 0] },
      { t: 200, pos: [1, 0, 0] },
    ]);
    expect([...pts]).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it('an unset colour follows the flight order', () => {
    expect(flightlineColour({}, 0)).toBe('var(--date-1)');
    expect(flightlineColour({}, 2)).toBe('var(--date-3)');
    expect(flightlineColour({ color: '#112233' }, 2)).toBe('#112233');
  });

  it('one colour mode paints every line the same', () => {
    expect(displayColour({}, 0, { colourMode: 'one' })).toBe(
      displayColour({ color: '#ff0000' }, 3, { colourMode: 'one' }),
    );
    expect(displayColour({ color: '#ff0000' }, 3, { colourMode: 'flight' })).toBe('#ff0000');
  });

  it('selected only keeps the selected flight, and all of them while none is selected', () => {
    const ls = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const on = { activeOnly: true };
    expect(linesToDraw(ls, {}, on, 'b')).toEqual([{ id: 'b' }]);
    expect(linesToDraw(ls, {}, on, null)).toHaveLength(3);
    expect(linesToDraw(ls, {}, on, 'not-a-flight')).toHaveLength(3);
    expect(linesToDraw(ls, { a: true }, { activeOnly: false }, 'b')).toHaveLength(2);
    // a selected flight that is switched off draws nothing
    expect(linesToDraw(ls, { b: true }, on, 'b')).toEqual([]);
  });
});
