import type { Issue, Vec3 } from '@aio/schema';
import type { IssuePin } from './mesh';

/**
 * Which issue pins to draw: every pin, none, or only graded severities at or above a level
 * (uncertain issues are left out once a level is chosen).
 */
export type PinFilter = 'all' | 'off' | number;

export function pinPasses(severity: Issue['severity'], filter: PinFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'off') return false;
  return severity !== 'uncertain' && severity >= filter;
}

/** Read a stored filter (`all`, `off` or a level as text); anything else means all. */
export function parsePinFilter(v: string | null | undefined): PinFilter {
  if (v === 'off') return 'off';
  const n = Number(v);
  return v && Number.isInteger(n) ? n : 'all';
}

/** Severity as a number for ordering: uncertain below every graded level. */
export const sevRank = (s: Issue['severity']): number => (s === 'uncertain' ? -1 : s);

/** A pin projected to the screen: `i` is the caller's index, `rank` from `sevRank`. */
export interface ScreenPin {
  i: number;
  x: number;
  y: number;
  rank: number;
}

export interface ScreenCluster {
  /** Caller indices of the members. */
  members: number[];
  /** Mean screen position of the members. */
  x: number;
  y: number;
  /** Highest rank among the members, and the member that holds it (the seed). */
  top: number;
  lead: number;
}

/**
 * Greedy radius clustering in screen space (supercluster style): the most severe pin that is
 * still free seeds a cluster and takes every free pin within `radius` pixels. A spatial hash
 * keeps it linear, so thousands of pins cluster in a millisecond or two.
 */
export function clusterScreen(pins: readonly ScreenPin[], radius: number): ScreenCluster[] {
  const cell = Math.max(1, radius);
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;
  pins.forEach((p, k) => {
    const id = key(Math.floor(p.x / cell), Math.floor(p.y / cell));
    const bucket = grid.get(id);
    if (bucket) bucket.push(k);
    else grid.set(id, [k]);
  });
  const order = pins.map((_, k) => k).sort((a, b) => (pins[b]?.rank ?? 0) - (pins[a]?.rank ?? 0));
  const taken = new Uint8Array(pins.length);
  const r2 = radius * radius;
  const out: ScreenCluster[] = [];
  for (const k of order) {
    if (taken[k]) continue;
    const seed = pins[k];
    if (!seed) continue;
    taken[k] = 1;
    const members = [seed.i];
    let sx = seed.x;
    let sy = seed.y;
    const cx = Math.floor(seed.x / cell);
    const cy = Math.floor(seed.y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const j of grid.get(key(gx, gy)) ?? []) {
          if (taken[j]) continue;
          const q = pins[j];
          if (!q) continue;
          const dx = q.x - seed.x;
          const dy = q.y - seed.y;
          if (dx * dx + dy * dy > r2) continue;
          taken[j] = 1;
          members.push(q.i);
          sx += q.x;
          sy += q.y;
        }
      }
    }
    out.push({
      members,
      x: sx / members.length,
      y: sy / members.length,
      top: seed.rank,
      lead: seed.i,
    });
  }
  return out;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelCandidate extends Rect {
  id: string;
  priority: number;
  /** Selected or hovered: always placed, outside the budget. */
  force?: boolean;
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Greedy label placement: forced labels first, then by priority, each only where it overlaps
 * no placed label and no obstacle (pins, badges, UI), up to `budget` unforced labels.
 * Returns the ids placed, in placement order.
 */
export function placeLabels(
  cands: readonly LabelCandidate[],
  obstacles: readonly Rect[],
  budget: number,
): string[] {
  const sorted = [...cands].sort(
    (a, b) => Number(b.force ?? false) - Number(a.force ?? false) || b.priority - a.priority,
  );
  const placed: Rect[] = [];
  const out: string[] = [];
  let free = budget;
  for (const c of sorted) {
    if (c.force) {
      placed.push(c);
      out.push(c.id);
      continue;
    }
    if (free <= 0) break;
    if (placed.some((p) => overlaps(p, c)) || obstacles.some((o) => overlaps(o, c))) continue;
    placed.push(c);
    out.push(c.id);
    free--;
  }
  return out;
}

// ---- the 3D pin layout ----

/** Pin disc and cluster badge diameters in CSS pixels. */
export const PIN_PX = 12;
export const SELECTED_PX = 17;
export const clusterPx = (n: number) => Math.min(40, 20 + 4 * Math.log2(n));
/** Codes show only while at most this many pins and badges are on screen. */
export const UNCROWDED = 50;
/** Most codes drawn at once besides the selected and hovered pin. */
export const CODE_BUDGET = 14;

export interface PinItem {
  /** Stable key: the issue id of a single pin, `c:` + lead issue id of a cluster. */
  key: string;
  kind: 'pin' | 'cluster';
  members: IssuePin[];
  /** Screen position (CSS pixels from the canvas top left). */
  x: number;
  y: number;
  /** World position: the pin, or the mean of the cluster members. */
  world: Vec3;
  /** Pin colour, or the colour of the most severe member. */
  color: string;
  size: number;
  selected: boolean;
  draft: boolean;
}

export interface PinLabel {
  key: string;
  kind: 'code' | 'count';
  text: string;
  x: number;
  y: number;
  color: string;
}

export interface PinLayoutInput {
  pins: readonly IssuePin[];
  /** World to CSS pixels, null when behind the camera or off screen. */
  screen: (p: Vec3) => { x: number; y: number } | null;
  radius: number;
  hoverId: string | null;
  width: number;
  height: number;
  /**
   * Whether a pin can be seen (not behind a surface). Hidden pins are left out entirely: no disc,
   * no code, and no count in a cluster badge. The selected pin always shows.
   */
  visible?: (pin: IssuePin) => boolean;
}

const CODE_H = 16;
const codeWidth = (code: string) => 7.4 * code.length + 12;

export interface PinLayout {
  items: PinItem[];
  labels: PinLabel[];
  /** Pins on screen but hidden behind a surface. */
  occluded: number;
}

/**
 * Lay out issue pins for one view: project, drop the pins behind a surface, cluster the rest in
 * screen space (the selected pin stays on its own), and choose the labels: a count on every
 * cluster badge, codes for the selected and hovered pin always and for other pins only while the
 * view is uncrowded and the code fits without touching another label or pin.
 */
export function layoutPins(input: PinLayoutInput): PinLayout {
  const { pins, screen, radius, hoverId, visible } = input;
  const items: PinItem[] = [];
  const free: ScreenPin[] = [];
  const at: { x: number; y: number }[] = [];
  let occluded = 0;
  pins.forEach((pin, i) => {
    const s = screen(pin.p);
    at[i] = s ?? { x: NaN, y: NaN };
    if (!s) return;
    if (pin.selected) {
      items.push(single(pin, s));
      return;
    }
    if (visible && !visible(pin)) {
      occluded++;
      return;
    }
    free.push({ i, x: s.x, y: s.y, rank: pin.rank });
  });
  for (const c of clusterScreen(free, radius)) {
    const members = c.members.map((i) => pins[i]).filter((p): p is IssuePin => !!p);
    const lead = pins[c.lead];
    if (!lead) continue;
    if (members.length === 1) {
      items.push(single(lead, at[c.lead] ?? c));
      continue;
    }
    const w: Vec3 = [0, 0, 0];
    for (const m of members) for (let k = 0; k < 3; k++) w[k] = (w[k] ?? 0) + (m.p[k] ?? 0);
    items.push({
      key: `c:${lead.issueId}`,
      kind: 'cluster',
      members,
      x: c.x,
      y: c.y,
      world: [w[0] / members.length, w[1] / members.length, w[2] / members.length],
      color: lead.color,
      size: clusterPx(members.length),
      selected: false,
      draft: members.every((m) => m.draft),
    });
  }

  const labels: PinLabel[] = [];
  for (const it of items) {
    if (it.kind === 'cluster') {
      labels.push({
        key: it.key,
        kind: 'count',
        text: String(it.members.length),
        x: it.x,
        y: it.y,
        color: it.color,
      });
    }
  }
  const singles = items.filter((i) => i.kind === 'pin');
  const budget = items.length <= UNCROWDED ? CODE_BUDGET : 0;
  const cands: LabelCandidate[] = singles.map((it) => {
    const pin = it.members[0];
    const code = pin?.code ?? '';
    const forced = it.selected || pin?.issueId === hoverId;
    return {
      id: it.key,
      x: it.x + it.size / 2 + 3,
      y: it.y - CODE_H / 2,
      w: codeWidth(code),
      h: CODE_H,
      priority: pin?.rank ?? 0,
      ...(forced ? { force: true } : {}),
    };
  });
  const discs: Rect[] = items.map((it) => ({
    x: it.x - it.size / 2,
    y: it.y - it.size / 2,
    w: it.size,
    h: it.size,
  }));
  const placed = new Set(placeLabels(cands, discs, budget));
  for (const it of singles) {
    if (!placed.has(it.key)) continue;
    const pin = it.members[0];
    if (!pin) continue;
    labels.push({
      key: it.key,
      kind: 'code',
      text: pin.code,
      x: it.x + it.size / 2 + 3,
      y: it.y,
      color: pin.color,
    });
  }
  return { items, labels, occluded };
}

function single(pin: IssuePin, s: { x: number; y: number }): PinItem {
  return {
    key: pin.issueId,
    kind: 'pin',
    members: [pin],
    x: s.x,
    y: s.y,
    world: pin.p,
    color: pin.color,
    size: pin.selected ? SELECTED_PX : PIN_PX,
    selected: pin.selected,
    draft: pin.draft,
  };
}

/** The item under a screen point (topmost: selected, then clusters, then pins), or null. */
export function hitItem(items: readonly PinItem[], x: number, y: number, slop = 3): PinItem | null {
  let best: PinItem | null = null;
  let bestD = Infinity;
  for (const it of items) {
    const d = Math.hypot(it.x - x, it.y - y);
    if (d > it.size / 2 + slop) continue;
    const score = d - (it.selected ? 100 : 0);
    if (score < bestD) {
      bestD = score;
      best = it;
    }
  }
  return best;
}
