export interface LabelBox {
  id: string;
  /** Screen rectangle of the expanded label, CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Higher wins a collision. */
  priority: number;
}

/**
 * Greedy label placement: forced labels first, then by priority; a label that would overlap one
 * already placed collapses to a dot. Returns the ids that stay expanded. A uniform grid keeps it
 * near linear for hundreds of tags.
 */
export function declutter(items: readonly LabelBox[], forced: ReadonlySet<string> = new Set()) {
  const order = [...items].sort((a, b) => {
    const fa = forced.has(a.id) ? 1 : 0;
    const fb = forced.has(b.id) ? 1 : 0;
    return fb - fa || b.priority - a.priority;
  });
  const CELL = 128;
  const grid = new Map<string, LabelBox[]>();
  const cells = (b: LabelBox) => {
    const out: string[] = [];
    for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++)
      for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++)
        out.push(`${cx},${cy}`);
    return out;
  };
  const hit = (a: LabelBox, b: LabelBox) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  const expanded = new Set<string>();
  for (const b of order) {
    const keys = cells(b);
    const collides = keys.some((k) => grid.get(k)?.some((o) => hit(o, b)));
    if (collides && !forced.has(b.id)) continue;
    expanded.add(b.id);
    for (const k of keys) {
      const list = grid.get(k);
      if (list) list.push(b);
      else grid.set(k, [b]);
    }
  }
  return expanded;
}

/** A screen rectangle in CSS pixels of the stage. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A callout to place: an anchor dot with a leader rising to a plate on its right or left. */
export interface CalloutItem {
  id: string;
  /** Anchor on screen. */
  ax: number;
  ay: number;
  /** Plate size. */
  w: number;
  h: number;
  /** Leader rise above the anchor and run sideways to the plate. */
  up: number;
  run: number;
  /** Higher wins a collision. */
  priority: number;
}

export type CalloutSide = 'right' | 'left';

/** Where the leader meets the plate, from the plate's top edge. */
export const LEADER_Y = 15;
/** Horizontal tail of the leader into the plate. */
export const LEADER_TAIL = 10;

export function plateRect(c: CalloutItem, side: CalloutSide): ScreenRect {
  const y = c.ay - c.up - LEADER_Y;
  const reach = c.run + LEADER_TAIL;
  return side === 'right'
    ? { x: c.ax + reach, y, w: c.w, h: c.h }
    : { x: c.ax - reach - c.w, y, w: c.w, h: c.h };
}

const overlaps = (a: ScreenRect, b: ScreenRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inside = (x: number, y: number, r: ScreenRect, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

/** Does the segment p-q touch the rectangle? (Liang-Barsky clipping.) */
export function segmentHitsRect(
  px: number,
  py: number,
  qx: number,
  qy: number,
  r: ScreenRect,
): boolean {
  const dx = qx - px;
  const dy = qy - py;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, px - r.x],
    [dx, r.x + r.w - px],
    [-dy, py - r.y],
    [dy, r.y + r.h - py],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function leaderHits(c: CalloutItem, side: CalloutSide, r: ScreenRect): boolean {
  const s = side === 'right' ? 1 : -1;
  const kx = c.ax + s * c.run;
  const ky = c.ay - c.up;
  return (
    segmentHitsRect(c.ax, c.ay, kx, ky, r) || segmentHitsRect(kx, ky, kx + s * LEADER_TAIL, ky, r)
  );
}

export interface PlaceOptions {
  /** Ids that expand whatever they overlap (selection, hover). */
  forced?: ReadonlySet<string>;
  /** Screen areas covered by other UI (video window, toolbars): no dot, leader or plate there. */
  keepOut?: readonly ScreenRect[];
  /** Areas plates must not cover (issue pins and their codes); dots and leaders may. */
  obstacles?: readonly ScreenRect[];
  /** Stage size; plates stay inside it. */
  width?: number;
  height?: number;
}

export interface Placement {
  /** Expanded callouts and the side their plate sits on. */
  sides: Map<string, CalloutSide>;
  /** Callouts whose anchor sits under other UI: not drawn at all. */
  hidden: Set<string>;
}

/**
 * Greedy callout placement. Forced callouts first, then by priority; each tries its plate on the
 * right, then on the left, and expands on the first side whose plate stays on the stage, clear of
 * other UI, issue pins and plates already placed, with a leader that does not cross other UI.
 * Callouts that fit nowhere stay a dot; anchors under other UI are hidden.
 */
export function placeCallouts(items: readonly CalloutItem[], opts: PlaceOptions = {}): Placement {
  const forced = opts.forced ?? new Set<string>();
  const keepOut = opts.keepOut ?? [];
  const obstacles = opts.obstacles ?? [];
  const order = [...items].sort((a, b) => {
    const fa = forced.has(a.id) ? 1 : 0;
    const fb = forced.has(b.id) ? 1 : 0;
    return fb - fa || b.priority - a.priority;
  });
  const placed: ScreenRect[] = [];
  const sides = new Map<string, CalloutSide>();
  const hidden = new Set<string>();
  const inBounds = (r: ScreenRect) =>
    (opts.width === undefined || (r.x >= 0 && r.x + r.w <= opts.width)) &&
    (opts.height === undefined || (r.y >= 0 && r.y + r.h <= opts.height));

  for (const c of order) {
    if (keepOut.some((r) => inside(c.ax, c.ay, r, 6))) {
      hidden.add(c.id);
      continue;
    }
    const must = forced.has(c.id);
    for (const side of ['right', 'left'] as const) {
      const plate = plateRect(c, side);
      if (!inBounds(plate)) continue;
      if (keepOut.some((r) => overlaps(plate, r) || leaderHits(c, side, r))) continue;
      if (obstacles.some((r) => overlaps(plate, r))) continue;
      if (!must && placed.some((r) => overlaps(plate, r))) continue;
      sides.set(c.id, side);
      placed.push(plate);
      break;
    }
  }
  return { sides, hidden };
}

const CHAR_PX = 6.6;
/** Label width from text length (mono 10.5 px), so placement never measures the DOM per frame. */
export function estimateLabelWidth(lines: readonly string[]): number {
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return Math.ceil(longest * CHAR_PX + 22);
}

/** Thin-space grouped metres: 12 mm, 1.235 m, 12.35 m, 1 234.6 m. */
export function formatMetres(d: number): string {
  if (d < 1) return `${Math.round(d * 1000)} mm`;
  const digits = d < 10 ? 3 : d < 1000 ? 2 : 1;
  const [int = '0', frac] = d.toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped}${frac ? `.${frac}` : ''} m`;
}

/** Rolling frame timing for the dev overlay. */
export class FrameStats {
  private readonly dts: number[] = [];
  private last: number | null = null;

  constructor(private readonly window = 120) {}

  tick(now: number): void {
    if (this.last !== null) {
      const dt = now - this.last;
      if (dt < 1000) {
        this.dts.push(dt);
        if (this.dts.length > this.window) this.dts.shift();
      }
    }
    this.last = now;
  }

  fps(): number {
    if (!this.dts.length) return 0;
    const avg = this.dts.reduce((a, b) => a + b, 0) / this.dts.length;
    return avg > 0 ? 1000 / avg : 0;
  }

  worstMs(): number {
    return this.dts.reduce((a, b) => Math.max(a, b), 0);
  }

  reset(): void {
    this.dts.length = 0;
    this.last = null;
  }
}
