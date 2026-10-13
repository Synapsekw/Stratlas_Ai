import { describe, expect, it } from 'vitest';
import { NO_MARKS, nextMarks } from './marks';

const order = ['a', 'b', 'c', 'd', 'e'];
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };
const plain = { ctrl: false, shift: false };

describe('nextMarks', () => {
  it('Ctrl toggles one row and moves the anchor', () => {
    const one = nextMarks(NO_MARKS, order, 'b', ctrl);
    expect([...one.marked]).toEqual(['b']);
    expect(one.anchor).toBe('b');
    expect([...nextMarks(one, order, 'b', ctrl).marked]).toEqual([]);
  });

  it('Shift marks the range in display order from the anchor, either way', () => {
    const from = nextMarks(NO_MARKS, order, 'b', ctrl);
    expect([...nextMarks(from, order, 'd', shift).marked]).toEqual(['b', 'c', 'd']);
    const back = nextMarks(nextMarks(NO_MARKS, order, 'd', ctrl), order, 'a', shift);
    expect([...back.marked].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('Shift without an anchor marks the row alone and anchors there', () => {
    const m = nextMarks(NO_MARKS, order, 'c', shift);
    expect([...m.marked]).toEqual(['c']);
    expect(m.anchor).toBe('c');
  });

  it('Shift from the keyboard ranges from the focused row when nothing anchors yet', () => {
    const one = nextMarks(NO_MARKS, order, 'c', { ...shift, from: 'b' });
    expect([...one.marked]).toEqual(['b', 'c']);
    expect(one.anchor).toBe('b');
    const two = nextMarks(one, order, 'd', { ...shift, from: 'c' });
    expect([...two.marked]).toEqual(['b', 'c', 'd']);
    // back up past the anchor: the range turns round it
    const back = nextMarks(nextMarks(two, order, 'b', { ...shift, from: 'c' }), order, 'a', {
      ...shift,
      from: 'b',
    });
    expect([...back.marked]).toEqual(['a', 'b']);
    expect(back.anchor).toBe('b');
  });

  it('a plain click clears the marks', () => {
    const m = nextMarks(nextMarks(NO_MARKS, order, 'a', ctrl), order, 'c', plain);
    expect(m).toEqual(NO_MARKS);
  });
});
