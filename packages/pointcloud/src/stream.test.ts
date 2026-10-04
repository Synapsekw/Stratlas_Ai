import { describe, expect, it } from 'vitest';
import { IntervalGate, UploadQueue } from './stream';

const MB = 2 ** 20;

describe('upload queue', () => {
  it('attaches within the byte budget per frame and keeps the rest for later frames', () => {
    const q = new UploadQueue<string>(4 * MB, 100);
    for (const k of ['a', 'b', 'c', 'd', 'e']) q.push(k, 1.5 * MB);
    const frame = () => {
      const got: string[] = [];
      q.drain((x) => got.push(x));
      return got;
    };
    expect(frame()).toEqual(['a', 'b']);
    expect(frame()).toEqual(['c', 'd']);
    expect(frame()).toEqual(['e']);
    expect(frame()).toEqual([]);
    expect(q.size).toBe(0);
  });

  it('always lands one item, even one larger than the budget', () => {
    const q = new UploadQueue<string>(1 * MB, 100);
    q.push('huge', 20 * MB);
    q.push('small', 0.1 * MB);
    const got: string[] = [];
    expect(q.drain((x) => got.push(x))).toBe(20 * MB);
    expect(got).toEqual(['huge']);
    expect(q.size).toBe(1);
  });

  it('takes coarse octree levels first, then the oldest', () => {
    const q = new UploadQueue<string>(100 * MB, 100);
    q.push('d3-a', MB, 3);
    q.push('d1', MB, 1);
    q.push('d3-b', MB, 3);
    q.push('d0', MB, 0);
    const got: string[] = [];
    q.drain((x) => got.push(x));
    expect(got).toEqual(['d0', 'd1', 'd3-a', 'd3-b']);
  });

  it('stops when the frame time budget is spent', () => {
    const q = new UploadQueue<number>(100 * MB, 4);
    for (let i = 0; i < 10; i++) q.push(i, MB);
    let t = 0;
    const got: number[] = [];
    // each attach costs 1.5 ms
    q.drain(
      (x) => {
        got.push(x);
        t += 1.5;
      },
      () => t,
    );
    expect(got).toEqual([0, 1, 2]);
    expect(q.size).toBe(7);
  });

  it('drops the items of a removed layer and clears', () => {
    const q = new UploadQueue<{ layer: string }>();
    q.push({ layer: 'a' }, 1);
    q.push({ layer: 'b' }, 1);
    q.push({ layer: 'a' }, 1);
    expect(q.remove((x) => x.layer === 'a')).toHaveLength(2);
    expect(q.size).toBe(1);
    expect(q.bytes).toBe(1);
    expect(q.clear()).toEqual([{ layer: 'b' }]);
    expect(q.size).toBe(0);
  });
});

describe('interval gate', () => {
  it('passes once per interval', () => {
    const g = new IntervalGate(100);
    expect(g.due(0)).toBe(true);
    g.mark(0);
    expect(g.due(50)).toBe(false);
    expect(g.due(99.9)).toBe(false);
    expect(g.due(100)).toBe(true);
    g.mark(100);
    g.reset();
    expect(g.due(101)).toBe(true);
  });
});
