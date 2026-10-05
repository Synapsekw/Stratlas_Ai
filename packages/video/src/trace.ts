import { isEngineStage, type ClientRectLike, type SceneHandle } from '@aio/engine';
import type { CameraOrientation, PoseSample, Vec3 } from '@aio/schema';
import { Group, Vector3, type InterleavedBufferAttribute, type PerspectiveCamera } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import {
  formatClipTime,
  formatDistance,
  placeLabels,
  pointAtDistance,
  tickDistances,
  tickStep,
  traceProfile,
  traceReadout,
  vertexBefore,
  type Box,
  type LabelCandidate,
  type TraceProfile,
} from './traceMath';

/** Words of the telemetry HUD and the trace labels; the app passes them from its catalogue. */
export interface TraceLabels {
  title: string;
  distance: string;
  agl: string;
  elevation: string;
  speed: string;
  heading: string;
  gimbal: string;
  clipTime: string;
  start: string;
}

export const DEFAULT_TRACE_LABELS: TraceLabels = {
  title: 'TELEMETRY',
  distance: 'DIST',
  agl: 'AGL',
  elevation: 'EL',
  speed: 'GS',
  heading: 'HDG',
  gimbal: 'GMB',
  clipTime: 'T+',
  start: 'START',
};

/** What the rig hands the trace each frame. */
export interface TraceFrame {
  clipId: string;
  samples: readonly PoseSample[];
  /** Clip window in flight time (ms since the flight start). */
  clipStartMs: number;
  clipEndMs: number;
  /** Playhead in flight time. */
  flightMs: number;
  offset: Vec3 | null;
  orientation: CameraOrientation | null;
  /** Calibrated camera position now. */
  pos: Vector3;
  originH: number;
  /** The drone-eye view: the HUD docks, the trace stays. */
  droneEye: boolean;
}

// Mission colours (sRGB approximations of the tokens, see @aio/engine PALETTE)
const ACC = 0x54d4b5;
const AMBER = 0xffc857;
const OV = 0xdfe6ee;

/** Ground under the path is sampled at most this many times per clip. */
const GROUND_SAMPLES = 400;
/** Milliseconds of ground rays per frame. */
const RAY_BUDGET_MS = 2;
/** Tick bar half length and label offset, CSS pixels. */
const TICK_PX = 6;
const KEEP_OUT_MS = 250;
/** Stage labels the trace labels keep clear of. */
const STAGE_LABELS = '[data-callout] > div, .ann-pin-labels > *, .aio-mk';
/** Drop lines stand at least this many pixels apart. */
const DROP_PX = 130;

const SVG_NS = 'http://www.w3.org/2000/svg';

function lineMaterial(o: {
  color: number;
  width: number;
  opacity: number;
  depthTest: boolean;
  dashed?: boolean;
}): LineMaterial {
  const m = new LineMaterial({
    color: o.color,
    linewidth: o.width,
    transparent: true,
    opacity: o.opacity,
    depthTest: o.depthTest,
    depthWrite: false,
    dashed: o.dashed ?? false,
  });
  if (o.dashed) {
    m.dashSize = 7;
    m.gapSize = 6;
  }
  return m;
}

/** A segments geometry with room for `cap` segments, written in place. */
function segmentsGeometry(cap: number): { geo: LineSegmentsGeometry; arr: Float32Array } {
  const geo = new LineSegmentsGeometry();
  geo.setPositions(new Float32Array(cap * 6));
  const start = geo.getAttribute('instanceStart') as InterleavedBufferAttribute;
  geo.instanceCount = 0;
  return { geo, arr: start.data.array as Float32Array };
}

function touch(geo: LineSegmentsGeometry) {
  const start = geo.getAttribute('instanceStart') as InterleavedBufferAttribute;
  start.data.needsUpdate = true;
}

const el = (tag: string, css: string, cls?: string): HTMLElement => {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (cls) e.className = cls;
  return e;
};

const PLATE_CSS = [
  'position:absolute',
  'left:0',
  'top:0',
  'pointer-events:none',
  'white-space:nowrap',
  'will-change:transform',
  'background:var(--scrim, oklch(0.13 0.01 250 / .84))',
  'border:1px solid var(--line-strong, oklch(0.36 0.012 250))',
  'border-left:2px solid var(--acc, oklch(0.79 0.115 172))',
  'border-radius:2px',
  'color:var(--ov, oklch(0.96 0.008 250))',
  "font:500 11px/15px var(--f-mono, 'IBM Plex Mono', ui-monospace, monospace)",
  'font-variant-numeric:tabular-nums',
  'padding:4px 8px 5px 7px',
  'box-shadow:0 6px 18px oklch(0.08 0.01 250 / .45)',
].join(';');

const TICK_CSS = [
  'position:absolute',
  'left:0',
  'top:0',
  'pointer-events:none',
  'white-space:nowrap',
  'will-change:transform',
  "font:500 10px/13px var(--f-mono, 'IBM Plex Mono', ui-monospace, monospace)",
  'font-variant-numeric:tabular-nums',
  'color:oklch(0.9 0.12 85)',
  'background:oklch(0.13 0.01 250 / .72)',
  'padding:0 4px',
  'border-radius:2px',
].join(';');

const HUD_ROWS: [keyof TraceLabels, string][] = [
  ['distance', 'distance'],
  ['clipTime', 'clip'],
  ['agl', 'agl'],
  ['elevation', 'el'],
  ['speed', 'speed'],
  ['heading', 'heading'],
  ['gimbal', 'gimbal'],
];

/** The HTML half of the trace: HUD plate with its leader, tick labels and the start tag. */
class TraceOverlay {
  readonly root: HTMLDivElement;
  readonly hud: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly keys = new Map<string, HTMLSpanElement>();
  private readonly values = new Map<string, HTMLSpanElement>();
  private readonly leader: SVGSVGElement;
  private readonly leaderLine: SVGPolylineElement;
  private readonly leaderDot: SVGCircleElement;
  readonly start: HTMLDivElement;
  private readonly pool: HTMLDivElement[] = [];
  private used = 0;
  hudW = 0;
  hudH = 0;

  constructor(host: HTMLElement) {
    this.root = el(
      'div',
      'position:absolute;inset:0;pointer-events:none;z-index:2;overflow:hidden;contain:strict',
      'aio-trace',
    ) as HTMLDivElement;
    this.root.setAttribute('aria-hidden', 'true');
    this.root.dataset.testid = 'drone-trace';
    this.leader = document.createElementNS(SVG_NS, 'svg');
    this.leader.setAttribute(
      'style',
      'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible',
    );
    this.leaderLine = document.createElementNS(SVG_NS, 'polyline');
    this.leaderLine.setAttribute('fill', 'none');
    this.leaderLine.setAttribute('stroke', 'oklch(0.79 0.115 172 / .8)');
    this.leaderLine.setAttribute('stroke-width', '1');
    this.leaderDot = document.createElementNS(SVG_NS, 'circle');
    this.leaderDot.setAttribute('r', '2');
    this.leaderDot.setAttribute('fill', 'oklch(0.79 0.115 172)');
    this.leader.append(this.leaderLine, this.leaderDot);

    this.hud = el('div', PLATE_CSS) as HTMLDivElement;
    this.hud.dataset.traceHud = '';
    this.title = el(
      'span',
      'display:block;font-weight:600;font-size:10px;line-height:14px;letter-spacing:.08em;color:var(--acc, oklch(0.79 0.115 172));margin-bottom:2px',
    );
    const grid = el(
      'div',
      'display:grid;grid-template-columns:auto auto auto auto;column-gap:7px;row-gap:0',
    );
    for (const [, id] of HUD_ROWS) {
      const k = el('span', 'color:var(--ov-dim, oklch(0.96 0.008 250 / .55))');
      const v = el('span', 'text-align:right;min-width:7ch');
      v.dataset.hud = id;
      this.keys.set(id, k);
      this.values.set(id, v);
      grid.append(k, v);
    }
    this.hud.append(this.title, grid);

    this.start = el(
      'div',
      [
        TICK_CSS,
        'color:var(--acc, oklch(0.79 0.115 172))',
        'font-weight:600',
        'letter-spacing:.06em',
        'border:1px solid oklch(0.79 0.115 172 / .55)',
      ].join(';'),
    ) as HTMLDivElement;
    this.start.dataset.traceStart = '';
    this.root.append(this.leader, this.start, this.hud);
    host.appendChild(this.root);
  }

  setLabels(l: TraceLabels) {
    this.title.textContent = l.title;
    for (const [key, id] of HUD_ROWS) {
      const k = this.keys.get(id);
      if (k) k.textContent = l[key];
    }
    this.start.textContent = l.start;
    this.hudW = 0;
  }

  setValue(id: string, text: string, raw?: number) {
    const v = this.values.get(id);
    if (!v) return;
    if (v.textContent !== text) v.textContent = text;
    if (raw !== undefined) v.dataset.value = raw.toFixed(2);
  }

  measure() {
    if (this.hudW > 0) return;
    this.hudW = this.hud.offsetWidth;
    this.hudH = this.hud.offsetHeight;
  }

  setLeader(points: [number, number][] | null) {
    if (!points) {
      this.leader.style.display = 'none';
      return;
    }
    this.leader.style.display = '';
    this.leaderLine.setAttribute('points', points.map((p) => p.join(',')).join(' '));
    const [x, y] = points[0] ?? [0, 0];
    this.leaderDot.setAttribute('cx', String(x));
    this.leaderDot.setAttribute('cy', String(y));
  }

  beginLabels() {
    this.used = 0;
  }

  label(text: string, x: number, y: number) {
    let e = this.pool[this.used];
    if (!e) {
      e = el('div', TICK_CSS) as HTMLDivElement;
      e.dataset.traceTick = '';
      this.root.insertBefore(e, this.hud);
      this.pool.push(e);
    }
    this.used++;
    if (e.textContent !== text) e.textContent = text;
    e.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    e.style.display = '';
  }

  endLabels() {
    for (let i = this.used; i < this.pool.length; i++) {
      const e = this.pool[i];
      if (e && e.style.display !== 'none') e.style.display = 'none';
    }
  }

  setVisible(v: boolean) {
    const d = v ? '' : 'none';
    if (this.root.style.display !== d) this.root.style.display = d;
  }

  dispose() {
    this.root.remove();
  }
}

/** The stage canvas; absent on stand-in scenes (unit tests). */
function canvasOf(h: SceneHandle): HTMLCanvasElement | null {
  return (h.renderer as Partial<SceneHandle['renderer']> | undefined)?.domElement ?? null;
}

/** Estimated label width for a mono 10 px text, CSS pixels. */
const labelWidth = (text: string) => Math.ceil(text.length * 6.1 + 8);

/**
 * The tactical drone trace of the active clip (founder feedback on the fusion scenes): the path
 * flown from the clip start to the playhead drawn bright, the rest of the clip faint and dashed, a
 * shadow track straight down on the model, terrain or ground, thin drop lines from air to ground,
 * distance ticks every 1 to 1000 m by zoom with labels, a start tag, and a telemetry HUD beside
 * the drone (docked in a corner when the drone is off screen or in the drone-eye view).
 * Geometry is written in place; ground heights come from rays shot a few per frame.
 */
export class DroneTrace {
  readonly group = new Group();
  private readonly ahead: Line2;
  private readonly flown: Line2;
  private readonly flownGhost: Line2;
  private readonly shadow: Line2;
  private readonly drops: LineSegments2;
  private readonly dropsArr: Float32Array;
  private readonly ticks: LineSegments2;
  private readonly ticksArr: Float32Array;
  private readonly nadir: LineSegments2;
  private readonly mats: LineMaterial[] = [];
  private overlay: TraceOverlay | null = null;
  private labels: TraceLabels = DEFAULT_TRACE_LABELS;
  private enabled = true;

  private profile: TraceProfile | null = null;
  private key = '';
  /** Index of the flown vertex whose segment end currently holds the live position. */
  private headSeg = -1;
  /** Ground heights every `groundStep` metres along the clip (NaN: not yet known). */
  private ground = new Float64Array(0);
  private groundStep = 1;
  private groundDone = 0;
  private shadowArr: Float32Array | null = null;

  private keepOut: Box[] = [];
  /** Index of the HUD place used last frame. */
  private hudSpot = -1;
  private labelOut: Box[] = [];
  private keepOutAt = -Infinity;
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  /** Last readout values, for tests and the e2e (window.__stratlas). */
  lastReadout: { distanceM: number; step: number; ticks: number; labels: number } | null = null;

  constructor(private readonly handle: SceneHandle) {
    this.group.name = 'DroneTrace';
    this.group.visible = false;
    const aheadMat = lineMaterial({
      color: OV,
      width: 1.5,
      opacity: 0.4,
      depthTest: false,
      dashed: true,
    });
    const flownMat = lineMaterial({ color: ACC, width: 3, opacity: 1, depthTest: true });
    const ghostMat = lineMaterial({ color: ACC, width: 2, opacity: 0.38, depthTest: false });
    const shadowMat = lineMaterial({ color: ACC, width: 1.5, opacity: 0.55, depthTest: true });
    const dropMat = lineMaterial({ color: ACC, width: 1, opacity: 0.4, depthTest: true });
    const tickMat = lineMaterial({ color: AMBER, width: 2, opacity: 1, depthTest: false });
    const nadirMat = lineMaterial({ color: ACC, width: 1.5, opacity: 0.9, depthTest: false });
    this.mats.push(aheadMat, flownMat, ghostMat, shadowMat, dropMat, tickMat, nadirMat);

    const geo = new LineGeometry();
    geo.setPositions([0, 0, 0, 0, 0, 0]);
    this.ahead = new Line2(geo, aheadMat);
    const flownGeo = new LineGeometry();
    flownGeo.setPositions([0, 0, 0, 0, 0, 0]);
    this.flown = new Line2(flownGeo, flownMat);
    this.flownGhost = new Line2(flownGeo, ghostMat);
    const shadowGeo = new LineGeometry();
    shadowGeo.setPositions([0, 0, 0, 0, 0, 0]);
    this.shadow = new Line2(shadowGeo, shadowMat);
    const drops = segmentsGeometry(400);
    this.drops = new LineSegments2(drops.geo, dropMat);
    this.dropsArr = drops.arr;
    const ticks = segmentsGeometry(320);
    this.ticks = new LineSegments2(ticks.geo, tickMat);
    this.ticksArr = ticks.arr;
    // nadir: a ring and a cross on the ground under the drone, unit size, scaled per frame
    const ring: number[] = [];
    const n = 32;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const b = ((i + 1) / n) * Math.PI * 2;
      ring.push(Math.cos(a), 0, Math.sin(a), Math.cos(b), 0, Math.sin(b));
    }
    ring.push(-1.6, 0, 0, -0.5, 0, 0, 0.5, 0, 0, 1.6, 0, 0);
    ring.push(0, 0, -1.6, 0, 0, -0.5, 0, 0, 0.5, 0, 0, 1.6);
    const nadirGeo = new LineSegmentsGeometry();
    nadirGeo.setPositions(ring);
    this.nadir = new LineSegments2(nadirGeo, nadirMat);

    const order: [Line2 | LineSegments2, number][] = [
      [this.shadow, 4],
      [this.drops, 5],
      [this.ahead, 6],
      [this.flownGhost, 7],
      [this.flown, 8],
      [this.ticks, 9],
      [this.nadir, 9],
    ];
    for (const [o, r] of order) {
      o.renderOrder = r;
      o.frustumCulled = false;
      this.group.add(o);
    }
    const host = canvasOf(handle)?.parentElement;
    if (host && typeof document !== 'undefined') {
      this.overlay = new TraceOverlay(host);
      this.overlay.setLabels(this.labels);
      this.overlay.setVisible(false);
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.hide();
    this.handle.requestRender();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setLabels(l: TraceLabels) {
    this.labels = l;
    this.overlay?.setLabels(l);
    this.handle.requestRender();
  }

  hide() {
    this.group.visible = false;
    this.overlay?.setVisible(false);
  }

  /** Forget the ground under the path (models loaded or hidden since). */
  invalidateGround() {
    this.key = '';
  }

  private rebuild(f: TraceFrame) {
    const p = traceProfile(f.samples, f.clipStartMs, f.clipEndMs, f.offset);
    this.profile = p;
    this.headSeg = -1;
    const pts = Array.from(p.pos, (x) => x);
    if (pts.length < 6) pts.push(pts[0] ?? 0, pts[1] ?? 0, pts[2] ?? 0);
    this.ahead.geometry.setPositions(pts);
    this.ahead.computeLineDistances();
    this.flown.geometry.setPositions(pts);
    // ground samples
    const steps = Math.max(1, Math.min(GROUND_SAMPLES, Math.ceil(p.length / 0.25)));
    this.groundStep = p.length / steps || 1;
    this.ground = new Float64Array(steps + 1).fill(Number.NaN);
    this.groundDone = 0;
    const sg = this.shadow.geometry;
    sg.setPositions(new Float32Array((steps + 1) * 3));
    const start = sg.getAttribute('instanceStart') as InterleavedBufferAttribute;
    this.shadowArr = start.data.array as Float32Array;
    sg.instanceCount = 0;
  }

  /** Shoot ground rays for a couple of milliseconds; true while some are left. */
  private sampleGround(): boolean {
    const p = this.profile;
    const arr = this.shadowArr;
    if (!p || !arr || this.groundDone >= this.ground.length) return false;
    const t0 = performance.now();
    const down = this.v2.set(0, -1, 0);
    while (this.groundDone < this.ground.length && performance.now() - t0 < RAY_BUDGET_MS) {
      const k = this.groundDone++;
      const at = pointAtDistance(p, k * this.groundStep).pos;
      const hit = this.handle.raycastRay(this.v.set(at[0], at[1], at[2]), down);
      const y = hit && hit.point.y <= at[1] ? hit.point.y : Math.min(0, at[1]);
      this.ground[k] = y;
      // the shadow polyline as segments: k-1 -> k
      if (k > 0) {
        const prev = pointAtDistance(p, (k - 1) * this.groundStep).pos;
        const lift = this.lift();
        const o = (k - 1) * 6;
        arr[o] = prev[0];
        arr[o + 1] = (this.ground[k - 1] ?? 0) + lift;
        arr[o + 2] = prev[2];
        arr[o + 3] = at[0];
        arr[o + 4] = y + lift;
        arr[o + 5] = at[2];
      }
    }
    touch(this.shadow.geometry);
    return this.groundDone < this.ground.length;
  }

  /** Lift of ground drawings above the surface, metres (scales with the clip). */
  private lift(): number {
    return Math.max(0.02, Math.min(0.4, (this.profile?.length ?? 0) / 2000));
  }

  /** Ground y under distance `d`, interpolated from the samples so far (null: unknown). */
  groundAt(d: number): number | null {
    const x = d / this.groundStep;
    const i = Math.floor(x);
    const a = this.ground[i];
    const b = this.ground[Math.min(this.ground.length - 1, i + 1)];
    if (a === undefined || Number.isNaN(a)) return null;
    if (b === undefined || Number.isNaN(b)) return a;
    return a + (b - a) * (x - i);
  }

  private metresPerPx(cam: PerspectiveCamera, at: Vector3, heightPx: number): number {
    const depth = Math.max(0.01, this.v.copy(at).applyMatrix4(cam.matrixWorldInverse).z * -1);
    return (2 * depth * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, heightPx);
  }

  /** CSS pixel position of a world point, or null behind the camera. */
  private screen(cam: PerspectiveCamera, p: Vector3, w: number, h: number) {
    const v = this.v.copy(p).project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  /**
   * The app's UI over the stage (toolbars, video window, readouts) and, separately, the labels
   * drawn on it (component callouts, issue codes, photo and panorama markers), in stage pixels.
   * Read at most every KEEP_OUT_MS: the rects cost a layout read.
   */
  private uiKeepOut(origin: DOMRect): { ui: Box[]; labels: Box[] } {
    const now = performance.now();
    if (now - this.keepOutAt < KEEP_OUT_MS) return { ui: this.keepOut, labels: this.labelOut };
    this.keepOutAt = now;
    const h = this.handle;
    const box = (r: ClientRectLike, pad: number): Box => ({
      x: r.left - origin.left - pad,
      y: r.top - origin.top - pad,
      w: r.right - r.left + 2 * pad,
      h: r.bottom - r.top + 2 * pad,
    });
    const real = (r: ClientRectLike) => r.right > r.left && r.bottom > r.top;
    this.keepOut = (isEngineStage(h) ? h.uiKeepOut() : []).filter(real).map((r) => box(r, 6));
    const host = canvasOf(h)?.parentElement;
    this.labelOut = host
      ? [...host.querySelectorAll(STAGE_LABELS)]
          .map((e) => e.getBoundingClientRect())
          .filter(real)
          .map((r) => box(r, 2))
      : [];
    return { ui: this.keepOut, labels: this.labelOut };
  }

  /** Draw the trace for this frame; `null` hides it. */
  update(f: TraceFrame | null) {
    if (!f || !this.enabled) {
      this.hide();
      return;
    }
    const key = `${f.clipId}|${f.clipStartMs}|${f.clipEndMs}|${f.offset?.join(',') ?? ''}`;
    if (key !== this.key) {
      this.key = key;
      this.rebuild(f);
    }
    const p = this.profile;
    if (!p) return;
    if (this.sampleGround()) this.handle.requestRender();
    this.group.visible = true;

    const cam = this.handle.camera;
    cam.updateMatrixWorld();
    const canvas = canvasOf(this.handle);
    if (!canvas) return;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const mpp = this.metresPerPx(cam, f.pos, H);

    // flown trail: segments up to the playhead, the last one ending at the drone
    const fg = this.flown.geometry;
    const start = fg.getAttribute('instanceStart') as InterleavedBufferAttribute;
    const data = start.data;
    const arr = data.array as Float32Array;
    const k = Math.min(p.n - 2, vertexBefore(p, f.flightMs));
    if (this.headSeg >= 0 && this.headSeg !== k) {
      // restore the segment that held the live end
      const o = this.headSeg * 6 + 3;
      arr[o] = p.pos[(this.headSeg + 1) * 3] ?? 0;
      arr[o + 1] = p.pos[(this.headSeg + 1) * 3 + 1] ?? 0;
      arr[o + 2] = p.pos[(this.headSeg + 1) * 3 + 2] ?? 0;
    }
    const inClip = f.flightMs >= (p.t[0] ?? 0);
    if (k >= 0 && inClip) {
      const o = k * 6 + 3;
      arr[o] = f.pos.x;
      arr[o + 1] = f.pos.y;
      arr[o + 2] = f.pos.z;
      this.headSeg = k;
    }
    data.needsUpdate = true;
    fg.instanceCount = inClip ? k + 1 : 0;
    const aheadMat = this.ahead.material;
    aheadMat.dashScale = 1 / Math.max(1e-4, mpp);

    // distance flown and the readout
    const flownM = inClip
      ? Math.min(
          p.length,
          Math.max(
            0,
            (p.dist[k] ?? 0) +
              this.v
                .set(
                  (p.pos[k * 3] ?? 0) - f.pos.x,
                  (p.pos[k * 3 + 1] ?? 0) - f.pos.y,
                  (p.pos[k * 3 + 2] ?? 0) - f.pos.z,
                )
                .length(),
          ),
        )
      : 0;
    const groundY = this.groundAt(flownM);

    // shadow up to the playhead
    const sg = this.shadow.geometry;
    sg.instanceCount = Math.max(
      0,
      Math.min(this.groundDone - 1, Math.ceil(flownM / this.groundStep)),
    );

    // ticks and drop lines
    const step = tickStep(mpp, p.length);
    const ds = tickDistances(step, flownM);
    const lift = this.lift();
    let t = 0;
    let dn = 0;
    const da = this.dropsArr;
    const ta = this.ticksArr;
    const tickPts: { d: number; pos: Vector3 }[] = [];
    for (const d of ds) {
      const at = pointAtDistance(p, d);
      const pos = new Vector3(at.pos[0], at.pos[1], at.pos[2]);
      tickPts.push({ d, pos });
      const half = TICK_PX * this.metresPerPx(cam, pos, H) * (d % (step * 5) === 0 ? 1.5 : 1);
      // horizontal bar across the direction of travel
      const nx = -at.dir[1] * half;
      const nz = at.dir[0] * half;
      ta.set([pos.x - nx, pos.y, pos.z - nz, pos.x + nx, pos.y, pos.z + nz], t * 6);
      t++;
    }
    // drop lines from air to ground, sparser than the ticks so they never read as a curtain
    for (const d of tickDistances(tickStep(mpp, p.length, DROP_PX), flownM)) {
      const gy = this.groundAt(d);
      if (gy === null || dn >= 399) continue;
      const at = pointAtDistance(p, d).pos;
      da.set([at[0], at[1], at[2], at[0], gy + lift, at[2]], dn * 6);
      dn++;
    }
    // the live drop line from the drone
    if (groundY !== null && inClip) {
      da.set([f.pos.x, f.pos.y, f.pos.z, f.pos.x, groundY + lift, f.pos.z], dn * 6);
      dn++;
    }
    this.ticks.geometry.instanceCount = t;
    touch(this.ticks.geometry);
    this.drops.geometry.instanceCount = dn;
    touch(this.drops.geometry);
    this.nadir.visible = groundY !== null && inClip;
    if (groundY !== null) {
      const r = 9 * mpp;
      this.nadir.position.set(f.pos.x, groundY + lift, f.pos.z);
      this.nadir.scale.setScalar(Math.max(1e-3, r));
    }

    const o = this.overlay;
    if (!o) return;
    o.setVisible(true);
    const r = traceReadout({
      samples: f.samples,
      flightMs: f.flightMs,
      clipStartMs: f.clipStartMs,
      profile: p,
      offset: f.offset,
      orientation: f.orientation,
      groundY,
      originH: f.originH,
    });
    o.setValue('distance', formatDistance(flownM), flownM);
    o.setValue('clip', formatClipTime(r.clipS), r.clipS);
    o.setValue('agl', r.aglM === null ? '--' : `${r.aglM.toFixed(1)} m`, r.aglM ?? undefined);
    o.setValue('el', `${r.elevationM.toFixed(1)} m`, r.elevationM);
    o.setValue('speed', `${r.groundSpeedMps.toFixed(1)} m/s`, r.groundSpeedMps);
    o.setValue('heading', `${String(Math.round(r.headingDeg) % 360).padStart(3, '0')}°`);
    o.setValue('gimbal', `${r.gimbalDeg.toFixed(0)}°`, r.gimbalDeg);
    o.measure();

    // HUD: beside the drone with a leader, else docked in a free corner
    const hostRect = (canvas.parentElement ?? canvas).getBoundingClientRect();
    const { ui: keep, labels: stageLabels } = this.uiKeepOut(hostRect);
    const bounds: Box = { x: 4, y: 4, w: W - 8, h: H - 8 };
    const hw = o.hudW;
    const hh = o.hudH;
    const hits = (list: readonly Box[], b: Box) =>
      list.some((q) => q.x < b.x + b.w && b.x < q.x + q.w && q.y < b.y + b.h && b.y < q.y + q.h);
    /** Inside the stage, off the UI; `strict` also off the callouts and markers. */
    const free = (b: Box, strict: boolean) =>
      b.x >= bounds.x &&
      b.y >= bounds.y &&
      b.x + b.w <= bounds.x + bounds.w &&
      b.y + b.h <= bounds.y + bounds.h &&
      !hits(keep, b) &&
      !(strict && hits(stageLabels, b));
    const ds2 = f.droneEye ? null : this.screen(cam, f.pos, W, H);
    // places beside the drone (with a leader), then docks in the stage corners; the place used
    // last frame first, so the HUD does not hop while the view moves
    const spots: { b: Box; leader: [number, number][] | null }[] = [];
    if (ds2 && ds2.x > 0 && ds2.x < W && ds2.y > 0 && ds2.y < H) {
      for (const gap of [34, 72])
        for (const [sx, sy] of [
          [1, -1],
          [-1, -1],
          [1, 1],
          [-1, 1],
        ] as const) {
          const b: Box = {
            x: sx > 0 ? ds2.x + gap : ds2.x - gap - hw,
            y: sy < 0 ? ds2.y - gap - hh : ds2.y + gap,
            w: hw,
            h: hh,
          };
          const cx = sx > 0 ? b.x : b.x + b.w;
          const cy = sy < 0 ? b.y + b.h : b.y;
          spots.push({
            b,
            leader: [
              [ds2.x + sx * 10, ds2.y + sy * 10],
              [cx - sx * 12, cy],
              [cx, cy],
            ],
          });
        }
    }
    for (const b of [
      { x: 12, y: H - hh - 12, w: hw, h: hh },
      { x: W - hw - 12, y: H - hh - 12, w: hw, h: hh },
      { x: 12, y: 12, w: hw, h: hh },
      { x: W - hw - 12, y: 12, w: hw, h: hh },
    ])
      spots.push({ b, leader: null });
    // below the stage toolbar when the top corners are taken
    for (let y = 60; y < H / 2; y += 24)
      spots.push({ b: { x: 12, y, w: hw, h: hh }, leader: null });
    // beside the drone before any dock; within each, last frame's place first
    const keys = [...spots.keys()];
    const beside = keys.filter((k) => spots[k]?.leader);
    const docks = keys.filter((k) => !spots[k]?.leader);
    const first = (list: number[]) =>
      list.includes(this.hudSpot)
        ? [this.hudSpot, ...list.filter((k) => k !== this.hudSpot)]
        : list;
    const order = [...first(beside), ...first(docks)];
    let pick = -1;
    for (const strict of [true, false]) {
      pick =
        order.find((k) => {
          const sp = spots[k];
          return sp !== undefined && free(sp.b, strict);
        }) ?? -1;
      if (pick >= 0) break;
    }
    if (pick < 0) pick = spots.findIndex((sp) => sp.leader === null);
    this.hudSpot = pick;
    const chosen = spots[pick];
    const hud: Box | null = chosen?.b ?? null;
    const leader = chosen?.leader ?? null;
    if (hud) o.hud.style.transform = `translate(${Math.round(hud.x)}px, ${Math.round(hud.y)}px)`;
    o.hud.dataset.docked = leader ? 'false' : 'true';
    o.setLeader(leader);

    // labels: tick distances and the start tag, clear of the HUD, the UI and each other
    const cands: LabelCandidate[] = [];
    const texts = new Map<string, { text: string; x: number; y: number }>();
    const startPos = pointAtDistance(p, 0).pos;
    const s0 = this.screen(cam, this.v2.set(startPos[0], startPos[1], startPos[2]), W, H);
    if (s0) {
      const w = labelWidth(this.labels.start) + 4;
      cands.push({ id: 'start', x: s0.x - w / 2, y: s0.y - 22, w, h: 15, priority: 1e9 });
      texts.set('start', { text: this.labels.start, x: s0.x - w / 2, y: s0.y - 22 });
    }
    const n = tickPts.length;
    tickPts.forEach((tk, i) => {
      const s = this.screen(cam, tk.pos, W, H);
      if (!s) return;
      const text = formatDistance(tk.d);
      const w = labelWidth(text);
      const id = `t${String(tk.d)}`;
      const major = tk.d % (step * 5) === 0;
      // newest first, round distances before the rest
      cands.push({ id, x: s.x + 8, y: s.y - 15, w, h: 13, priority: (major ? n : 0) + i });
      texts.set(id, { text, x: s.x + 8, y: s.y - 15 });
    });
    const obstacles: Box[] = [...keep, ...stageLabels];
    if (hud) obstacles.push(hud);
    if (ds2) obstacles.push({ x: ds2.x - 18, y: ds2.y - 18, w: 36, h: 36 });
    const placed = placeLabels(cands, obstacles, bounds);
    o.beginLabels();
    let startShown = false;
    for (const id of placed) {
      const tx = texts.get(id);
      if (!tx) continue;
      if (id === 'start') {
        startShown = true;
        o.start.style.transform = `translate(${Math.round(tx.x)}px, ${Math.round(tx.y)}px)`;
      } else o.label(tx.text, tx.x, tx.y);
    }
    o.endLabels();
    o.start.style.display = startShown ? '' : 'none';
    this.lastReadout = { distanceM: flownM, step, ticks: t, labels: placed.size };
  }

  dispose() {
    this.overlay?.dispose();
    this.overlay = null;
    for (const o of [this.ahead, this.flown, this.shadow, this.drops, this.ticks, this.nadir])
      o.geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}
