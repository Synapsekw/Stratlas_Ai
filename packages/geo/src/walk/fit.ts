import type { Quat, WalkCalibration, WalkPin, WalkRawPath } from '@aio/schema';
import { MODEL_SURFACE } from '@aio/schema';
import { slerpQuat } from '../direction';
import {
  angleDiff,
  headingOf,
  levelStills,
  yawPitchRoll,
  type LevelStill,
  type XZ,
} from './horizontal';
import { applySim2, sim2FromPairs, sim2Through, sim2Yaw, type Sim2 } from './similarity2';

/*
 * The walk fit (design "The fit"): pins on drawings or on the model turn the walk's raw path
 * (the pipeline's own frame) into model x/z over time. Pure functions over plain arrays, run live
 * in the renderer and again in main when the pose file is written.
 */

/** Two pins closer than this on the target are refused. */
export const MIN_PIN_SPAN_M = 5;
/** Half width of the blend between two stretches at an inner pin, seconds. */
export const BLEND_S = 2;
/** The refusal of pins that are too close (or at the same raw position). */
export const PIN_SPAN_ERROR = 'Put the end pin at least 5 m from the start';

/** A drawing's affine from image px to model x/z (from its corners) and its base height. */
export interface SurfaceFrame {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  tz: number;
  baseY: number;
  provisional: boolean;
}

export interface WalkSurfaces {
  /** The drawing's frame; null when the drawing is gone. */
  drawing(id: string): SurfaceFrame | null;
}

const finiteXZ = (p: XZ): boolean => Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * A pin's target in the model: `[x, z]` and the ground height when known (the pin's own `y`, else
 * the drawing's base height). Null when its drawing is gone or the numbers are not finite.
 */
export function pinTarget(pin: WalkPin, s: WalkSurfaces): { xz: XZ; y: number | null } | null {
  let xz: XZ;
  let y: number | null = pin.y ?? null;
  if (pin.surface === MODEL_SURFACE) {
    xz = [pin.at[0], pin.at[1]];
  } else {
    const f = s.drawing(pin.surface);
    if (!f) return null;
    const [px, py] = pin.at;
    xz = [f.a * px + f.b * py + f.tx, f.c * px + f.d * py + f.tz];
    y ??= f.baseY;
  }
  if (!finiteXZ(xz)) return null;
  return { xz, y: y !== null && Number.isFinite(y) ? y : null };
}

export interface FitPin {
  /** The pin's index in the calibration's `pins`. */
  index: number;
  t: number;
  /** Model `[x, z]`; `[0, 0]` for an inactive pin (its drawing is gone). */
  target: XZ;
  active: boolean;
  /** Distance from the fit made without this pin, metres; null with fewer than two other pins. */
  residualM: number | null;
}

export interface WalkFitSample {
  xz: XZ;
  groundY: number;
  /** Camera heading in the model frame, a `Ry` angle (three.js: 0 looks down -Z, -pi/2 east). */
  headingRad: number;
  /** Interpolated across a break in the path (drawn dashed). */
  dashed: boolean;
}

export interface WalkFit {
  /** Model x/z and ground height at time t (seconds); null before two active pins. */
  at(t: number): WalkFitSample | null;
  /** Every pin, sorted by `t`. */
  pins: FitPin[];
  /** Stretches of the walk without a fit of their own (an unpinned segment), seconds. */
  gaps: { fromT: number; toT: number }[];
  pinsOnly: boolean;
  notToScale: boolean;
  /** Why the walk cannot be placed (the 5 m refusal), else null. */
  error: string | null;
}

/** What the pose file needs beyond {@link WalkFitSample}. */
export interface WalkFitDetail extends WalkFitSample {
  /** The fit's turn (a `Ry` angle) at t; null when the heading is the travel direction. */
  fitYaw: number | null;
  /** The levelled raw camera orientation from the stills at t, when known. */
  rawQ: Quat | null;
}

interface ActivePin {
  index: number;
  t: number;
  target: XZ;
  y: number | null;
}

interface SegFit {
  stills: LevelStill[];
  startT: number;
  endT: number;
  /** The pins' times; stretch k runs from pinT[k] to pinT[k + 1]. One pin: one stretch. */
  pinT: number[];
  sims: Sim2[];
}

interface Built {
  error: string | null;
  pinsOnly: boolean;
  gaps: { fromT: number; toT: number }[];
  at(t: number): WalkFitDetail | null;
}

const details = new WeakMap<WalkFit, (t: number) => WalkFitDetail | null>();

/** The fit at t with its turn and raw orientation (for the pose file). */
export function walkFitDetail(fit: WalkFit, t: number): WalkFitDetail | null {
  const d = details.get(fit);
  return d ? d(t) : null;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
const lerpXZ = (a: XZ, b: XZ, f: number): XZ => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
const dist = (a: XZ, b: XZ): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Index of the last element with `key <= t` (0 when t is before the first). */
function bracket<T>(items: readonly T[], key: (v: T) => number, t: number): number {
  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const item = items[mid];
    if (item !== undefined && key(item) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Registered stills interpolated at t (clamped to their range). */
function rawAt(stills: readonly LevelStill[], t: number): { xz: XZ; q: Quat | null } {
  const i = bracket(stills, (s) => s.t, t);
  const a = stills[i];
  const b = stills[i + 1] ?? a;
  if (!a || !b || !a.xz || !b.xz) return { xz: [0, 0], q: null };
  const span = b.t - a.t;
  const f = span > 0 ? clamp((t - a.t) / span, 0, 1) : 0;
  const q = a.q && b.q ? slerpQuat(a.q, b.q, f) : (a.q ?? b.q);
  return { xz: lerpXZ(a.xz, b.xz, f), q };
}

const smoothstep = (u: number): number => {
  const v = clamp(u, 0, 1);
  return 3 * v * v - 2 * v * v * v;
};

/** One fitted segment at t: model `[x, z]`, the fit's turn and the raw orientation. */
function evalSeg(seg: SegFit, t: number): { xz: XZ; fitYaw: number; rawQ: Quat | null } {
  const raw = rawAt(seg.stills, clamp(t, seg.startT, seg.endT));
  const n = seg.sims.length;
  const apply = (k: number): { xz: XZ; yaw: number } => {
    const sim = seg.sims[clamp(k, 0, n - 1)] ?? seg.sims[0];
    if (!sim) return { xz: raw.xz, yaw: 0 };
    return { xz: applySim2(sim, raw.xz), yaw: sim2Yaw(sim) };
  };
  if (n <= 1) {
    const r = apply(0);
    return { xz: r.xz, fitYaw: r.yaw, rawQ: raw.q };
  }
  const p = seg.pinT;
  const i = clamp(
    bracket(p, (v) => v, t),
    0,
    n - 1,
  );
  for (const j of [i, i + 1]) {
    if (j < 1 || j > n - 1) continue;
    const tp = p[j] ?? 0;
    const h = Math.min(BLEND_S, (tp - (p[j - 1] ?? tp)) / 2, ((p[j + 1] ?? tp) - tp) / 2);
    if (h > 0 && Math.abs(t - tp) < h) {
      const w = smoothstep((t - (tp - h)) / (2 * h));
      const A = apply(j - 1);
      const B = apply(j);
      return {
        xz: lerpXZ(A.xz, B.xz, w),
        fitYaw: A.yaw + w * angleDiff(B.yaw, A.yaw),
        rawQ: raw.q,
      };
    }
  }
  const r = apply(i);
  return { xz: r.xz, fitYaw: r.yaw, rawQ: raw.q };
}

function maxSpan(pins: readonly ActivePin[]): number {
  let m = 0;
  for (let i = 0; i < pins.length; i++)
    for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i];
      const b = pins[j];
      if (a && b) m = Math.max(m, dist(a.target, b.target));
    }
  return m;
}

/** Ground height at t: the pins' heights interpolated by time, else `fallback`. */
function groundAt(pins: readonly ActivePin[], fallback: number, t: number): number {
  const withY = pins.filter((p): p is ActivePin & { y: number } => p.y !== null);
  if (withY.length === 0) return fallback;
  const i = bracket(withY, (p) => p.t, t);
  const a = withY[i];
  const b = withY[i + 1];
  if (!a) return fallback;
  if (!b || t <= a.t) return a.y;
  const span = b.t - a.t;
  return span > 0 ? lerp(a.y, b.y, clamp((t - a.t) / span, 0, 1)) : a.y;
}

/** Pins-only: between pins by cumulative steps (or by time), held before and after. */
function buildPinsOnly(
  stills: readonly LevelStill[],
  pins: readonly ActivePin[],
  ground: (t: number) => number,
): Built['at'] {
  const bySteps = stills.some((s) => s.steps > 0);
  const progress = (t: number): number => {
    if (!bySteps) return t;
    const i = bracket(stills, (s) => s.t, t);
    const a = stills[i];
    const b = stills[i + 1] ?? a;
    if (!a || !b) return t;
    const span = b.t - a.t;
    return span > 0 ? lerp(a.steps, b.steps, clamp((t - a.t) / span, 0, 1)) : a.steps;
  };
  // Travel heading of each stretch, a still stretch borrowing its neighbour's.
  const raw: (number | null)[] = [];
  for (let k = 0; k + 1 < pins.length; k++) {
    const a = pins[k];
    const b = pins[k + 1];
    raw.push(
      a && b && dist(a.target, b.target) > 1e-9
        ? headingOf([b.target[0] - a.target[0], b.target[1] - a.target[1]])
        : null,
    );
  }
  const headings = raw.map((h, k) => {
    if (h !== null) return h;
    for (let d = 1; d < raw.length; d++) {
      const v = raw[k - d] ?? raw[k + d];
      if (v !== null && v !== undefined) return v;
    }
    return 0;
  });
  return (t) => {
    const first = pins[0];
    const last = pins[pins.length - 1];
    if (!first || !last) return null;
    let xz: XZ;
    let k: number;
    if (t <= first.t) {
      xz = first.target;
      k = 0;
    } else if (t >= last.t) {
      xz = last.target;
      k = headings.length - 1;
    } else {
      k = clamp(
        bracket(pins, (p) => p.t, t),
        0,
        pins.length - 2,
      );
      const a = pins[k];
      const b = pins[k + 1];
      if (!a || !b) return null;
      const u0 = progress(a.t);
      const u1 = progress(b.t);
      let f: number;
      if (u1 - u0 > 1e-9) f = (progress(t) - u0) / (u1 - u0);
      else f = b.t - a.t > 0 ? (t - a.t) / (b.t - a.t) : 0;
      xz = lerpXZ(a.target, b.target, clamp(f, 0, 1));
    }
    return {
      xz: [xz[0], xz[1]],
      groundY: ground(t),
      headingRad: headings[k] ?? 0,
      dashed: false,
      fitYaw: null,
      rawQ: null,
    };
  };
}

interface Anchor {
  t: number;
  xz: XZ;
  heading: number | null;
}

function build(
  stills: readonly LevelStill[],
  pinsOnly: boolean,
  pins: readonly ActivePin[],
  ground: (t: number) => number,
): Built {
  const none = { pinsOnly, gaps: [], at: () => null };
  if (pins.length < 2) return { ...none, error: null };
  if (maxSpan(pins) < MIN_PIN_SPAN_M) return { ...none, error: PIN_SPAN_ERROR };
  if (pinsOnly) return { error: null, pinsOnly, gaps: [], at: buildPinsOnly(stills, pins, ground) };

  // Registered stills by segment.
  const bySeg = new Map<number, LevelStill[]>();
  for (const s of stills) {
    if (s.segment === null || !s.xz) continue;
    const list = bySeg.get(s.segment) ?? [];
    list.push(s);
    bySeg.set(s.segment, list);
  }
  interface Draft {
    stills: LevelStill[];
    startT: number;
    endT: number;
    pins: ActivePin[];
    fit: SegFit | null;
  }
  const drafts: Draft[] = [...bySeg.values()]
    .map((list) => ({
      stills: list,
      startT: list[0]?.t ?? 0,
      endT: list[list.length - 1]?.t ?? 0,
      pins: [] as ActivePin[],
      fit: null,
    }))
    .sort((a, b) => a.startT - b.startT);
  const loose: ActivePin[] = [];
  for (const p of pins) {
    const d = drafts.find((g) => p.t >= g.startT && p.t <= g.endT);
    if (d) d.pins.push(p);
    else loose.push(p);
  }

  let sameRaw = false;
  for (const d of drafts) {
    if (d.pins.length < 2) continue;
    const raws = d.pins.map((p) => rawAt(d.stills, p.t).xz);
    const sims: (Sim2 | null)[] = [];
    for (let k = 0; k + 1 < d.pins.length; k++) {
      const a = d.pins[k];
      const b = d.pins[k + 1];
      const ra = raws[k];
      const rb = raws[k + 1];
      sims.push(a && b && ra && rb ? sim2FromPairs(ra, rb, a.target, b.target) : null);
    }
    if (sims.every((m) => m === null)) {
      sameRaw = true;
      continue;
    }
    const filled = sims.map((m, k): Sim2 => {
      if (m) return m;
      let near: Sim2 | null = null;
      for (let dd = 1; dd < sims.length && !near; dd++) near = sims[k - dd] ?? sims[k + dd] ?? null;
      const ra = raws[k] ?? [0, 0];
      const pin = d.pins[k];
      // `near` exists: at least one stretch is not degenerate.
      return near && pin
        ? sim2Through(near, ra, pin.target)
        : { s: 1, cos: 1, sin: 0, tx: 0, tz: 0 };
    });
    d.fit = {
      stills: d.stills,
      startT: d.startT,
      endT: d.endT,
      pinT: d.pins.map((p) => p.t),
      sims: filled,
    };
  }
  // One pin (or pins at one raw position): the neighbouring fit's turn and scale through the pin.
  const donors = drafts.filter((d) => d.fit);
  for (const d of drafts) {
    if (d.fit || d.pins.length === 0) continue;
    const pin = d.pins[0];
    let best: Draft | null = null;
    let bestGap = Infinity;
    for (const o of donors) {
      const gap = o.startT > d.endT ? o.startT - d.endT : d.startT - o.endT;
      if (gap < bestGap) {
        bestGap = gap;
        best = o;
      }
    }
    const of = best?.fit;
    if (!pin || !of) continue;
    const sim =
      (best && best.startT > d.endT ? of.sims[0] : of.sims[of.sims.length - 1]) ?? of.sims[0];
    if (!sim) continue;
    d.fit = {
      stills: d.stills,
      startT: d.startT,
      endT: d.endT,
      pinT: [pin.t],
      sims: [sim2Through(sim, rawAt(d.stills, pin.t).xz, pin.target)],
    };
  }
  const fitted = drafts.flatMap((d) => (d.fit ? [d.fit] : []));
  if (fitted.length === 0 && sameRaw) return { ...none, error: PIN_SPAN_ERROR };
  // Pins of segments left without a fit carry the dashed line too.
  for (const d of drafts) if (!d.fit) loose.push(...d.pins);

  const anchors: Anchor[] = [];
  for (const f of fitted) {
    for (const t of [f.startT, f.endT]) {
      const e = evalSeg(f, t);
      const yaw = e.rawQ ? yawPitchRoll(e.rawQ).yaw : 0;
      anchors.push({ t, xz: e.xz, heading: e.fitYaw + yaw });
    }
  }
  for (const p of loose) anchors.push({ t: p.t, xz: p.target, heading: null });
  anchors.sort((a, b) => a.t - b.t);

  const gaps: { fromT: number; toT: number }[] = [];
  const covered = (t: number) => fitted.some((f) => t >= f.startT && t <= f.endT);
  let run: { fromT: number; toT: number; registered: boolean } | null = null;
  for (const s of stills) {
    if (covered(s.t)) {
      if (run?.registered) gaps.push({ fromT: run.fromT, toT: run.toT });
      run = null;
      continue;
    }
    run ??= { fromT: s.t, toT: s.t, registered: false };
    run.toT = s.t;
    if (s.segment !== null) run.registered = true;
  }
  if (run?.registered) gaps.push({ fromT: run.fromT, toT: run.toT });

  const dashedAt = (t: number): { xz: XZ; heading: number } | null => {
    const first = anchors[0];
    if (!first) return null;
    const i = bracket(anchors, (a) => a.t, t);
    const a = anchors[i] ?? first;
    const b = anchors[i + 1];
    if (!b || t <= a.t) {
      const other = t <= a.t ? anchors[i + 1] : anchors[i - 1];
      let heading = a.heading;
      if (heading === null && other && dist(a.xz, other.xz) > 1e-9)
        heading =
          t <= a.t
            ? headingOf([other.xz[0] - a.xz[0], other.xz[1] - a.xz[1]])
            : headingOf([a.xz[0] - other.xz[0], a.xz[1] - other.xz[1]]);
      return { xz: [a.xz[0], a.xz[1]], heading: heading ?? 0 };
    }
    const span = b.t - a.t;
    const f = span > 0 ? clamp((t - a.t) / span, 0, 1) : 0;
    const d: XZ = [b.xz[0] - a.xz[0], b.xz[1] - a.xz[1]];
    const heading = Math.hypot(d[0], d[1]) > 1e-9 ? headingOf(d) : (a.heading ?? b.heading ?? 0);
    return { xz: lerpXZ(a.xz, b.xz, f), heading };
  };

  return {
    error: null,
    pinsOnly,
    gaps,
    at: (t) => {
      const seg = fitted.find((f) => t >= f.startT && t <= f.endT);
      if (seg) {
        const e = evalSeg(seg, t);
        const yaw = e.rawQ ? yawPitchRoll(e.rawQ).yaw : 0;
        return {
          xz: e.xz,
          groundY: ground(t),
          headingRad: angleDiff(e.fitYaw + yaw, 0),
          dashed: false,
          fitYaw: e.fitYaw,
          rawQ: e.rawQ,
        };
      }
      const d = dashedAt(t);
      if (!d) return null;
      return {
        xz: d.xz,
        groundY: ground(t),
        headingRad: angleDiff(d.heading, 0),
        dashed: true,
        fitYaw: null,
        rawQ: null,
      };
    },
  };
}

const sane = (d: WalkFitDetail | null): WalkFitDetail | null =>
  d && finiteXZ(d.xz) && Number.isFinite(d.groundY) && Number.isFinite(d.headingRad) ? d : null;

/**
 * Fit a walk to its pins (design "The fit", rules 1 to 10). `raw` null (no `raw-path.json` yet)
 * or `source: 'pins-only'` gives a pins-only fit.
 */
export function fitWalk(
  raw: WalkRawPath | null,
  cal: Pick<WalkCalibration, 'pins' | 'yawOffsetDeg'>,
  s: WalkSurfaces,
  durationS: number,
): WalkFit {
  const stills = raw ? levelStills(raw) : [];
  const pinsOnly = !raw || raw.source === 'pins-only' || !stills.some((st) => st.xz !== null);

  const resolved = cal.pins.map((pin, index) => {
    const target = Number.isFinite(pin.t) ? pinTarget(pin, s) : null;
    return { pin, index, target };
  });
  resolved.sort((a, b) => a.pin.t - b.pin.t || a.index - b.index);
  const active: ActivePin[] = resolved.flatMap((r) =>
    r.target ? [{ index: r.index, t: r.pin.t, target: r.target.xz, y: r.target.y }] : [],
  );

  // Ground fallback: the drawing's base height when the pins carry none.
  let baseY = 0;
  for (const r of resolved) {
    if (!r.target || r.pin.surface === MODEL_SURFACE) continue;
    const f = s.drawing(r.pin.surface);
    if (f && Number.isFinite(f.baseY)) {
      baseY = f.baseY;
      break;
    }
  }
  const groundFor = (pins: readonly ActivePin[]) => (t: number) => groundAt(pins, baseY, t);

  const maxT = Number.isFinite(durationS) && durationS > 0 ? durationS : Infinity;
  const clampT = (t: number) => clamp(t, 0, maxT);

  const main = build(stills, pinsOnly, active, groundFor(active));
  const detail = (t: number): WalkFitDetail | null =>
    Number.isFinite(t) ? sane(main.at(clampT(t))) : null;

  const residual = new Map<number, number>();
  if (!main.error && active.length >= 3) {
    for (const p of active) {
      const others = active.filter((o) => o !== p);
      const sub = build(stills, pinsOnly, others, groundFor(others));
      const r = sub.error ? null : sane(sub.at(clampT(p.t)));
      if (r) residual.set(p.index, dist(r.xz, p.target));
    }
  }

  const surfaces = new Set(resolved.filter((r) => r.target).map((r) => r.pin.surface));
  const only = surfaces.size === 1 ? [...surfaces][0] : undefined;
  const onlyFrame = only !== undefined && only !== MODEL_SURFACE ? s.drawing(only) : null;

  const fit: WalkFit = {
    at: (t) => {
      const d = detail(t);
      return d
        ? { xz: d.xz, groundY: d.groundY, headingRad: d.headingRad, dashed: d.dashed }
        : null;
    },
    pins: resolved.map((r) => ({
      index: r.index,
      t: r.pin.t,
      target: r.target ? r.target.xz : [0, 0],
      active: r.target !== null,
      residualM: residual.get(r.index) ?? null,
    })),
    gaps: main.gaps,
    pinsOnly,
    notToScale: onlyFrame?.provisional === true,
    error: main.error,
  };
  details.set(fit, detail);
  return fit;
}
