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
