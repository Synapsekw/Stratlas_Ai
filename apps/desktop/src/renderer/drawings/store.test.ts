import { describe, expect, it } from 'vitest';
import { createDrawings, unplacedOf } from './store';

describe('the place tool session', () => {
  it('pairs a drawing point with the site point given after it', () => {
    const s = createDrawings();
    s.getState().startPlace('sheet-a');
    // a site point with nothing picked on the drawing is ignored
    s.getState().addSite([1, 2, 3], false);
    expect(s.getState().place?.pairs).toEqual([]);
    s.getState().pickDrawing([10, 20]);
    // picking again before the site point replaces the pending point
    s.getState().pickDrawing([30, 40]);
    s.getState().addSite([1, 2, 3], false);
    s.getState().pickDrawing([50, 60]);
    s.getState().addSite([4, 0, 6], true);
    expect(s.getState().place).toEqual({
      layerId: 'sheet-a',
      pending: null,
      pairs: [
        { px: [30, 40], local: [1, 2, 3] },
        { px: [50, 60], local: [4, 0, 6], horizontalOnly: true },
      ],
    });
    s.getState().removePair(0);
    expect(s.getState().place?.pairs).toHaveLength(1);
    s.getState().stopPlace();
    expect(s.getState().place).toBeNull();
  });

  it('opens the controls of one drawing row at a time', () => {
    const s = createDrawings();
    s.getState().toggleControls('a');
    s.getState().toggleControls('b');
    expect(s.getState().controls).toBe('b');
    s.getState().toggleControls('b');
    expect(s.getState().controls).toBeNull();
  });

  it('lists the drawings that are not placed', () => {
    const size = { width: 10, height: 10 };
    expect([
      ...unplacedOf({ a: { provisional: true, size }, b: { provisional: false, size } }),
    ]).toEqual(['a']);
  });
});
