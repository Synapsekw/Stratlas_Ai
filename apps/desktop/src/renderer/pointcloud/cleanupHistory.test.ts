import { emptyCleanup, noiseCopyPath } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { HISTORY_CAP, initial, push, redo, referencedCopies, undo } from './cleanupHistory';

const r = (n: number) => ({ ...emptyCleanup('a'), hiddenClasses: [n] });

describe('cleanup history', () => {
  it('pushes, undoes and redoes snapshots', () => {
    let h = initial(null);
    h = push(h, r(1));
    h = push(h, r(2));
    expect(h.present).toEqual(r(2));
    const u = undo(h);
    expect(u?.present).toEqual(r(1));
    const back = u && redo(u);
    expect(back?.present).toEqual(r(2));
    expect(undo(initial(null))).toBeNull();
    expect(redo(h)).toBeNull();
  });

  it('a new step drops the redo steps; the same recipe again is no step', () => {
    const h = push(push(initial(null), r(1)), r(2));
    const u = undo(h);
    if (!u) throw new Error('no undo');
    const n = push(u, r(3));
    expect(n.future).toEqual([]);
    expect(push(n, r(3))).toBe(n);
  });

  it('keeps at most 50 steps back', () => {
    let h = initial(null);
    for (let i = 0; i < 80; i++) h = push(h, r(i));
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toEqual(r(29));
  });

  it('names every noise copy the history holds', () => {
    const noise = (id: string) => ({
      path: noiseCopyPath('a', id),
      params: { outlier: { meanK: 8, multiplier: 2 } },
      marked: 1,
      total: 2,
      runId: id,
    });
    let h = push(initial(null), { ...emptyCleanup('a'), noise: noise('j1') });
    h = push(h, { ...emptyCleanup('a'), noise: noise('j2') });
    const u = undo(h);
    expect(u && referencedCopies(u).sort()).toEqual([
      noiseCopyPath('a', 'j1'),
      noiseCopyPath('a', 'j2'),
    ]);
  });
});
