import { describe, expect, it } from 'vitest';
import type { IssuePin } from './mesh';
import {
  clusterScreen,
  hitItem,
  layoutPins,
  parsePinFilter,
  pinPasses,
  placeLabels,
  sevRank,
  type ScreenPin,
} from './declutter';

const pin = (i: number, x: number, y: number, rank = 1): ScreenPin => ({ i, x, y, rank });

describe('pin filter', () => {
  it('shows every pin for all, none for off', () => {
    expect(pinPasses(1, 'all')).toBe(true);
    expect(pinPasses('uncertain', 'all')).toBe(true);
    expect(pinPasses(5, 'off')).toBe(false);
  });

  it('keeps severities at or above the threshold and drops uncertain', () => {
    expect(pinPasses(2, 2)).toBe(true);
    expect(pinPasses(3, 2)).toBe(true);
    expect(pinPasses(1, 2)).toBe(false);
    expect(pinPasses('uncertain', 2)).toBe(false);
  });

  it('parses a stored filter and falls back to all', () => {
    expect(parsePinFilter('off')).toBe('off');
    expect(parsePinFilter('3')).toBe(3);
    expect(parsePinFilter('nonsense')).toBe('all');
    expect(parsePinFilter(null)).toBe('all');
  });

  it('ranks uncertain below every graded level', () => {
    expect(sevRank('uncertain')).toBeLessThan(sevRank(1));
    expect(sevRank(3)).toBeGreaterThan(sevRank(2));
  });
});

describe('screen clustering', () => {
  it('leaves pins further apart than the radius alone', () => {
    const out = clusterScreen([pin(0, 0, 0), pin(1, 100, 0)], 30);
    expect(out.map((c) => c.members)).toEqual([[0], [1]]);
  });

  it('gathers pins within the radius into one cluster with a count', () => {
    const out = clusterScreen([pin(0, 0, 0), pin(1, 10, 5), pin(2, 20, -10), pin(3, 200, 200)], 30);
    expect(out.map((c) => c.members.length).sort()).toEqual([1, 3]);
  });

  it('seeds a cluster at its most severe pin and reports the top rank', () => {
    const out = clusterScreen([pin(0, 0, 0, 1), pin(1, 12, 0, 3), pin(2, 24, 0, 2)], 30);
    expect(out).toHaveLength(1);
    expect(out[0]?.top).toBe(3);
    expect(out[0]?.lead).toBe(1);
    expect(out[0]?.members.sort()).toEqual([0, 1, 2]);
  });

  it('places the cluster at the mean of its members', () => {
    const [c] = clusterScreen([pin(0, 0, 0), pin(1, 10, 20)], 30);
    expect([c?.x, c?.y]).toEqual([5, 10]);
  });

  it('clusters across grid cell borders', () => {
    // 29 and 31 sit in different 30 px cells but 2 px apart.
    const out = clusterScreen([pin(0, 29, 29), pin(1, 31, 31)], 30);
    expect(out).toHaveLength(1);
  });

  it('handles thousands of pins quickly', () => {
    const pins: ScreenPin[] = [];
    for (let i = 0; i < 5000; i++) pins.push(pin(i, (i * 37) % 1600, (i * 91) % 1000, i % 4));
    const t = performance.now();
    const out = clusterScreen(pins, 36);
    expect(performance.now() - t).toBeLessThan(40);
    expect(out.reduce((n, c) => n + c.members.length, 0)).toBe(5000);
  });
});

describe('label placement', () => {
  it('places labels in priority order and skips overlaps', () => {
    const got = placeLabels(
      [
        { id: 'a', x: 0, y: 0, w: 40, h: 14, priority: 1 },
        { id: 'b', x: 10, y: 2, w: 40, h: 14, priority: 5 },
        { id: 'c', x: 100, y: 0, w: 40, h: 14, priority: 0 },
      ],
      [],
      10,
    );
    expect(got).toEqual(['b', 'c']);
  });

  it('keeps labels off obstacles and stops at the budget', () => {
    const got = placeLabels(
      [
        { id: 'a', x: 0, y: 0, w: 40, h: 14, priority: 3 },
        { id: 'b', x: 100, y: 0, w: 40, h: 14, priority: 2 },
        { id: 'c', x: 200, y: 0, w: 40, h: 14, priority: 1 },
      ],
      [{ x: 5, y: 5, w: 4, h: 4 }],
      1,
    );
    expect(got).toEqual(['b']);
  });

  it('always places forced labels, even over others', () => {
    const got = placeLabels(
      [
        { id: 'a', x: 0, y: 0, w: 40, h: 14, priority: 3 },
        { id: 'sel', x: 5, y: 0, w: 40, h: 14, priority: 0, force: true },
      ],
      [],
      0,
    );
    expect(got).toEqual(['sel']);
  });
});

describe('pin layout', () => {
  const mk = (id: string, x: number, rank = 1, over: Partial<IssuePin> = {}): IssuePin => ({
    issueId: id,
    code: id.toUpperCase(),
    p: [x, 0, 0],
    color: `#00000${rank}`,
    selected: false,
    draft: false,
    rank,
    ...over,
  });
  // world x is the screen x; points with x < 0 are behind the camera
  const screen = (p: readonly number[]) => ((p[0] ?? 0) < 0 ? null : { x: p[0] ?? 0, y: 100 });
  const base = { screen, radius: 30, hoverId: null, width: 2000, height: 800 };

  it('draws far-apart pins one by one with their codes', () => {
    const out = layoutPins({ ...base, pins: [mk('a', 100), mk('b', 400)] });
    expect(out.items.map((i) => [i.kind, i.members.map((m) => m.issueId)])).toEqual([
      ['pin', ['a']],
      ['pin', ['b']],
    ]);
    expect(out.labels.map((l) => l.text).sort()).toEqual(['A', 'B']);
  });

  it('clusters close pins into a badge with a count, coloured by the worst member', () => {
    const out = layoutPins({ ...base, pins: [mk('a', 100, 1), mk('b', 110, 3), mk('c', 120, 2)] });
    expect(out.items).toHaveLength(1);
    const [c] = out.items;
    expect(c?.kind).toBe('cluster');
    expect(c?.color).toBe('#000003');
    expect(c?.world).toEqual([110, 0, 0]);
    expect(out.labels).toEqual([expect.objectContaining({ kind: 'count', text: '3' })]);
  });

  it('never clusters the selected pin and always labels it', () => {
    const out = layoutPins({
      ...base,
      pins: [mk('a', 100), mk('b', 105, 1, { selected: true }), mk('c', 110)],
    });
    expect(out.items.map((i) => i.kind).sort()).toEqual(['cluster', 'pin']);
    expect(out.labels.map((l) => l.text)).toContain('B');
  });

  it('skips pins behind the camera', () => {
    const out = layoutPins({ ...base, pins: [mk('a', -5), mk('b', 300)] });
    expect(out.items.flatMap((i) => i.members.map((m) => m.issueId))).toEqual(['b']);
  });

  it('leaves pins behind a surface out of the view and out of every cluster count', () => {
    // b and d sit on the far side of the model, under a and c on screen
    const back = new Set(['b', 'd']);
    const pins = [mk('a', 100, 1), mk('b', 104, 3), mk('c', 400), mk('d', 405), mk('e', 410)];
    const out = layoutPins({ ...base, pins, visible: (p) => !back.has(p.issueId) });
    expect(out.occluded).toBe(2);
    expect(out.items.map((i) => [i.kind, i.members.map((m) => m.issueId).sort()])).toEqual([
      ['pin', ['a']],
      ['cluster', ['c', 'e']],
    ]);
    // the badge takes its colour from the visible members only (b, rank 3, is hidden)
    expect(out.items[0]?.color).toBe('#000001');
    expect(out.labels.find((l) => l.kind === 'count')?.text).toBe('2');
    expect(hitItem(out.items, 104, 100)?.key).toBe('a');
  });

  it('keeps the selected pin even behind a surface', () => {
    const out = layoutPins({
      ...base,
      pins: [mk('s', 100, 1, { selected: true }), mk('t', 300)],
      visible: () => false,
    });
    expect(out.items.map((i) => i.key)).toEqual(['s']);
    expect(out.occluded).toBe(1);
  });

  it('hit-tests the item under the cursor, preferring the selected pin', () => {
    const out = layoutPins({
      ...base,
      pins: [mk('a', 100), mk('b', 300), mk('s', 304, 1, { selected: true })],
    });
    expect(hitItem(out.items, 101, 101)?.key).toBe('a');
    expect(hitItem(out.items, 302, 100)?.key).toBe('s');
    expect(hitItem(out.items, 200, 100)).toBeNull();
  });

  it('hides codes when the view is crowded, except the hovered pin', () => {
    const pins = Array.from({ length: 120 }, (_, k) => mk(`p${k}`, 40 + k * 40));
    const crowded = layoutPins({ ...base, width: 6000, pins, hoverId: 'p7' });
    expect(crowded.items).toHaveLength(120);
    expect(crowded.labels.filter((l) => l.kind === 'code').map((l) => l.text)).toEqual(['P7']);
  });
});
