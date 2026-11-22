/**
 * Spreading pile badges that would sit on each other. Shared by the printed pages (`chrome.tsx`,
 * in millimetres) and the offline view (`viewer.ts`, in pixels of the map as drawn), so both
 * follow one rule. Pure, and it imports nothing: the offline view's script is bundled from this
 * folder alone.
 */

/** A badge after spreading: where it is drawn, its true place, and whether it was moved. */
export interface SpreadMarker {
  at: [number, number];
  anchor: [number, number];
  /** Moved far enough from its true place to need a leader back to it. */
  moved: boolean;
}

/** A box on a picture that badges keep clear of (the north chip, the scale bar). */
export interface KeepClear {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room kept between two badges, as a share of their diameter. */
const SPREAD_GAP = 1.12;
const SPREAD_ROUNDS = 80;

/**
 * Badges of one `radius` that would overlap are moved apart (D9), each pair along the line between
 * them (two at one point: along a direction fixed by their order, so the result never changes
 * between prints), moved off the `avoid` boxes by the shortest way, and kept inside `bounds` when
 * given. Every badge keeps its true place as `anchor`, to draw a leader to. Badges that already
 * stand clear do not move. Pure.
 */
export function spreadMarkers(
  points: readonly (readonly [number, number])[],
  radius: number,
  bounds?: { width: number; height: number },
  avoid: readonly KeepClear[] = [],
): SpreadMarker[] {
  const at = points.map((p): [number, number] => [p[0], p[1]]);
  const min = 2 * radius * SPREAD_GAP;
  const within = (v: number, size: number) =>
    size <= 2 * radius ? size / 2 : Math.min(Math.max(v, radius), size - radius);
  const clamp = (p: [number, number]) => {
    if (!bounds) return;
    p[0] = within(p[0], bounds.width);
    p[1] = within(p[1], bounds.height);
  };
  for (let round = 0; round < SPREAD_ROUNDS; round++) {
    let pushed = false;
    for (let i = 0; i < at.length; i++)
      for (let j = i + 1; j < at.length; j++) {
        const a = at[i];
        const b = at[j];
        if (!a || !b) continue;
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        const gap = Math.hypot(dx, dy);
        if (gap >= min - 1e-9) continue;
        let d = gap;
        if (d < 1e-9) {
          // two at one point: a direction their order fixes
          const angle = (i * 7 + j) * 2.399963;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d = 1;
        }
        const push = (min - gap) / 2;
        a[0] -= (dx / d) * push;
        a[1] -= (dy / d) * push;
        b[0] += (dx / d) * push;
        b[1] += (dy / d) * push;
        clamp(a);
        clamp(b);
        pushed = true;
      }
    for (const p of at)
      for (const box of avoid) {
        // the box grown by the badge's radius: a centre inside it means the badge covers the box
        const x0 = box.x - radius;
        const x1 = box.x + box.width + radius;
        const y0 = box.y - radius;
        const y1 = box.y + box.height + radius;
        if (!(p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1)) continue;
        const fits = (v: number, size: number | undefined) =>
          size === undefined || (v >= radius && v <= size - radius);
        // the shortest way out that stays on the picture
        const ways = [
          { d: p[0] - x0, x: x0, y: p[1], ok: fits(x0, bounds?.width) },
          { d: x1 - p[0], x: x1, y: p[1], ok: fits(x1, bounds?.width) },
          { d: p[1] - y0, x: p[0], y: y0, ok: fits(y0, bounds?.height) },
          { d: y1 - p[1], x: p[0], y: y1, ok: fits(y1, bounds?.height) },
        ]
          .filter((w) => w.ok)
          .sort((a, b) => a.d - b.d);
        const way = ways[0];
        if (!way) continue;
        p[0] = way.x;
        p[1] = way.y;
        pushed = true;
      }
    if (!pushed) break;
  }
  return at.map((p, k) => {
    const anchor: [number, number] = [points[k]?.[0] ?? p[0], points[k]?.[1] ?? p[1]];
    return { at: p, anchor, moved: Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) > radius * 0.2 };
  });
}
