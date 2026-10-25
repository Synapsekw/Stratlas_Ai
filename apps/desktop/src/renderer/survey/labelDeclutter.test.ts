import { describe, expect, it } from 'vitest';
import { declutter, LABEL_GAP, type LabelBox } from './labelDeclutter';

const box = (id: string, x: number, y: number, more: Partial<LabelBox> = {}): LabelBox => ({
  id,
  x,
  y,
  w: 100,
  h: 20,
  selected: false,
  weight: 0,
  pile: true,
  ...more,
});

describe('declutter', () => {
  it('leaves labels that do not touch where they are', () => {
    const out = declutter([box('a', 0, 0), box('b', 200, 0)]);
    expect(out.get('a')).toEqual({ dy: 0, hidden: false });
    expect(out.get('b')).toEqual({ dy: 0, hidden: false });
  });

  it('keeps the larger pile in place, nudges the next up, hides the one that still collides', () => {
    const out = declutter([
      box('small', 10, 100, { weight: 50 }),
      box('big', 0, 100, { weight: 900 }),
      box('mid', 20, 100, { weight: 300 }),
    ]);
    expect(out.get('big')).toEqual({ dy: 0, hidden: false });
    expect(out.get('mid')).toEqual({ dy: -(20 + LABEL_GAP), hidden: false });
    expect(out.get('small')?.hidden).toBe(true);
  });

  it('puts a selected label first, whatever its volume', () => {
    const out = declutter([
      box('big', 0, 100, { weight: 900 }),
      box('picked', 0, 100, { weight: 10, selected: true }),
    ]);
    expect(out.get('picked')).toEqual({ dy: 0, hidden: false });
    expect(out.get('big')?.dy).toBe(-(20 + LABEL_GAP));
  });

  it('shows a hidden label while the pointer rests on its place', () => {
    const boxes = [
      box('big', 0, 100, { weight: 900 }),
      box('mid', 0, 100, { weight: 300 }),
      box('small', 0, 100, { weight: 50 }),
    ];
    expect(declutter(boxes).get('small')?.hidden).toBe(true);
    const hovered = declutter(boxes, { x: 50, y: 110 });
    // every label sits under the pointer; the order among them stays selected, then volume
    expect(hovered.get('big')?.hidden).toBe(false);
    const only = declutter(
      [box('big', 0, 100, { weight: 900 }), box('small', 60, 100, { weight: 50 })],
      { x: 150, y: 110 },
    );
    expect(only.get('small')).toEqual({ dy: 0, hidden: false });
    expect(only.get('big')?.dy).toBe(-(20 + LABEL_GAP));
  });

  describe('labels that are not pile labels (distances, areas) and the picked ones', () => {
    const NUDGE = -(20 + LABEL_GAP);

    it('a distance label is never hidden: it keeps its place and the piles give way', () => {
      const out = declutter([
        box('big', 0, 100, { weight: 900 }),
        box('mid', 0, 100, { weight: 300 }),
        box('line', 0, 100, { pile: false }),
      ]);
      expect(out.get('line')).toEqual({ dy: 0, hidden: false });
      expect(out.get('big')).toEqual({ dy: NUDGE, hidden: false });
      expect(out.get('mid')?.hidden).toBe(true);
    });

    it('labels that are not pile labels are only ever moved, however many share a place', () => {
      const out = declutter([
        box('a', 0, 100, { pile: false }),
        box('b', 0, 100, { pile: false }),
        box('c', 0, 100, { pile: false }),
        box('pile', 0, 100, { weight: 900 }),
      ]);
      for (const id of ['a', 'b', 'c']) expect(out.get(id)?.hidden).toBe(false);
      expect(new Set(['a', 'b', 'c'].map((id) => out.get(id)?.dy)).size).toBe(3);
      expect(out.get('pile')?.hidden).toBe(true);
    });

    it('a selected or hovered pile always shows, even among labels that are not piles', () => {
      const boxes = [
        box('line', 0, 100, { pile: false }),
        box('area', 0, 100, { pile: false }),
        box('picked', 0, 100, { weight: 1, selected: true }),
        box('under', 200, 100, { weight: 1 }),
        box('other', 200, 100, { pile: false }),
        box('other2', 200, 100, { pile: false }),
      ];
      const out = declutter(boxes, { x: 250, y: 110 });
      expect(out.get('picked')?.hidden).toBe(false);
      expect(out.get('under')?.hidden).toBe(false);
      for (const id of ['line', 'area', 'other', 'other2']) expect(out.get(id)?.hidden).toBe(false);
    });
  });
});
