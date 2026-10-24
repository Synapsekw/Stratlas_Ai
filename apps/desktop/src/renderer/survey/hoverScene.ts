/**
 * The linked hover in the 3D view and on the map (spec section 4, boards 8 to 11). The point a
 * profile chart hovers or pins (`linkedHover`) shows on its line: one dot per shown survey on that
 * survey's surface (the newest filled, earlier ones as rings), a dashed gap between them, a soft
 * ring on the ground, the stretch from A to the point in the accent colour and a tag
 * "42.3 m · −1.63". The other way, a pointer within 12 px of a registered line snaps to it and
 * drives the chart; a click pins, a double-click flies there. Everything is drawn on top of the
 * scene (no depth test, like the measurement lines) and never takes a raycast.
 */
import { getActiveStage, type EngineStage } from '@aio/engine';
import { formatNumber, localeOf, toWgs84, unitFactor, unitLabel } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { SitePoint, Vec3 } from '@aio/schema';
import { effectiveUnits, type ChartSeries } from '@aio/survey';
import { workspace } from '@aio/workspace';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  Points,
  PerspectiveCamera,
  PointsMaterial,
  RingGeometry,
  Vector3,
  type Material,
} from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { linkedHover, type HoverLine, type HoverPoint, type LinkedHoverState } from './linkedHover';
import { markerAt, pointAt, snapScreen, tagText, type TagFormat } from './linkedHoverGeom';
import type { Frame } from './measureScene';
import { measureStore } from './measureStore';
import { pointerBusy } from './pointerBusy';
import { sectionStore } from './sectionStore';

type Pt = readonly [number, number];

/** WebGL and the map need plain colours: the tokens' values in the dark theme. */
export const LINK_COLOURS = {
  accent: '#4fd1b4',
  earlier: '#9aa1a8',
  design: '#e0b54a',
  base: '#c7a27a',
} as const;

/** Two elevations closer than this draw no gap line (spec section 4). */
const GAP_MIN_M = 0.05;
/** How far a click may be from the pin's point on screen and still be on it. */
const ON_PIN_PX = 12;
/** A second click this soon and this close is the second half of a double-click. */
const REPEAT_MS = 450;
const REPEAT_PX = 4;

/** The fly a double-click asks for, metres from the point. */
export const LINK_FLY_DISTANCE_M = 40;

function colourOf(s: ChartSeries | undefined): string {
  switch (s?.kind) {
    case 'design':
      return LINK_COLOURS.design;
    case 'base':
      return LINK_COLOURS.base;
    case 'earlier':
      return LINK_COLOURS.earlier;
    default:
      return LINK_COLOURS.accent;
  }
}

/** The newest dated series of a line, else its last: the surface the filled dot sits on. */
function newestKey(series: readonly ChartSeries[]): string | null {
  let best: ChartSeries | null = null;
  for (const s of series) if (s.date && (!best?.date || s.date >= best.date)) best = s; // later in order wins a tie
  return best?.key ?? series.at(-1)?.key ?? null;
}

/** One dot as the views draw it. */
export interface LinkDot {
  key: string;
  z: number;
  colour: string;
  /** The newest survey's dot is filled, earlier ones are rings. */
  filled: boolean;
}

/** What a view draws for one point on a line: the marker with its dots coloured and the tag. */
export interface LinkView {
  key: string;
  chainageM: number;
  e: number;
  n: number;
  dots: LinkDot[];
  /** The filled dot's height: the ground ring and the trace sit there. Null without dots. */
  groundZ: number | null;
  /** Lowest and highest dot when they differ by more than 0.05 m, else null. */
  gap: [number, number] | null;
  deltaM: number | null;
  tag: string;
  /** From A to the point along the line, at the newest surface where it has a height. */
  trace: [number, number, number | null][];
}

/** The project's distance unit and locale, as the chart readout uses them. */
export function tagFormat(): TagFormat {
  const s = measureStore.getState().settings;
  const unit = effectiveUnits(s.units).distance;
  const factor = unitFactor('distance', unit);
  const locale = s.locale ?? localeOf(unit);
  return {
    chainage: (m) => `${formatNumber(m / factor, 1, locale)} ${unitLabel(unit)}`,
    magnitude: (m) => formatNumber(m / factor, 2, locale),
  };
}

/** A series' samples on the line: chainage and z where it has a surface. */
function samplesOf(s: ChartSeries | undefined): { c: number; z: number }[] {
  if (!s) return [];
  const out: { c: number; z: number }[] = [];
  const n = Math.min(s.chainage.length, s.z.length);
  for (let i = 0; i < n; i++) {
    const c = s.chainage[i];
    const z = s.z[i];
    if (c === undefined || z === null || z === undefined) continue;
    if (Number.isFinite(c) && Number.isFinite(z)) out.push({ c, z });
  }
  return out;
}

/** The point the views show for a hover or pin, or null when its line is not registered. */
export function linkView(line: HoverLine, chainageM: number, fmt: TagFormat): LinkView {
  const m = markerAt(line, chainageM);
  const newest = newestKey(line.series);
  const byKey = new Map(line.series.map((s) => [s.key, s]));
  const filledKey = m.dots.some((d) => d.key === newest) ? newest : (m.dots.at(-1)?.key ?? null);
  const dots: LinkDot[] = m.dots.map((d) => ({
    key: d.key,
    z: d.z,
    colour: colourOf(byKey.get(d.key)),
    filled: d.key === filledKey,
  }));
  const groundZ = dots.find((d) => d.filled)?.z ?? null;
  const zs = dots.map((d) => d.z);
  const lo = Math.min(...zs);
  const hi = Math.max(...zs);
  const gap: [number, number] | null = dots.length > 1 && hi - lo > GAP_MIN_M ? [lo, hi] : null;
  const c = Number.isFinite(chainageM) ? Math.max(0, chainageM) : 0;
  const samples = samplesOf(byKey.get(filledKey ?? '')).filter((s) => s.c < c);
  const trace: LinkView['trace'] = [];
  if (samples.length > 0) {
    for (const s of samples) {
      const [e, n] = pointAt(line.polyline, s.c);
      trace.push([e, n, s.z]);
    }
  } else {
    // no surface along it: the line's own vertices up to the point
    let base = 0;
    const poly = line.polyline;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const prev = poly[i - 1];
      if (!p) continue;
      if (prev) base += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      if (base >= c) break;
      trace.push([p[0], p[1], null]);
    }
  }
  trace.push([m.e, m.n, groundZ]);
  return {
    key: line.key,
    chainageM: c,
    e: m.e,
    n: m.n,
    dots,
    groundZ,
    gap,
    deltaM: m.deltaM,
    tag: tagText(c, m.deltaM, fmt),
    trace,
  };
}

type Project = (e: number, n: number, z: number | null) => Pt | null;
interface ScreenLine {
  screen: Pt[];
  cumul: number[];
}

/**
 * A line on screen for snapping: its samples at the newest surface (else its vertices at
 * `fallbackZ`), projected, with each sample's chainage. Points off screen are left out.
 */
export function screenLine(line: HoverLine, project: Project): ScreenLine {
  const newest = line.series.find((s) => s.key === newestKey(line.series));
  const samples = samplesOf(newest);
  if (samples.length <= 1) return vertexLine(line, project);
  const screen: Pt[] = [];
  const cumul: number[] = [];
  for (const s of samples) {
    const [e, n] = pointAt(line.polyline, s.c);
    const p = project(e, n, s.z);
    if (!p) continue;
    screen.push(p);
    cumul.push(s.c);
  }
  return { screen, cumul };
}

/**
 * A line's vertices on screen with their chainage: what a flat view (the map) snaps on, where
 * the heights do not move the line and a straight stretch stays straight.
 */
export function vertexLine(line: HoverLine, project: Project): ScreenLine {
  const screen: Pt[] = [];
  const cumul: number[] = [];
  let base = 0;
  line.polyline.forEach((p, i) => {
    const prev = line.polyline[i - 1];
    if (prev) base += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const at = project(p[0], p[1], null);
    if (!at) return;
    screen.push(at);
    cumul.push(base);
  });
  return { screen, cumul };
}

/** The registered line a screen point snaps to: the one hovered now first, then in order. */
function snapAt(
  s: LinkedHoverState,
  screenOf: (line: HoverLine) => ScreenLine,
  x: number,
  y: number,
): { key: string; chainageM: number } | null {
  const lines = [...s.lines.values()];
  const first = s.hover?.key ?? s.pin?.key;
  lines.sort((a, b) => Number(b.key === first) - Number(a.key === first));
  for (const line of lines) {
    const { screen, cumul } = screenOf(line);
    const c = snapScreen(screen, cumul, x, y);
    if (c !== null) return { key: line.key, chainageM: c };
  }
  return null;
}

/** The point a view shows: the hover, else the pin. */
function shown(s: LinkedHoverState): HoverPoint | null {
  const p = s.hover ?? s.pin;
  return p && s.lines.has(p.key) ? p : null;
}

/** The highest dot of a point: where the tag and the pin badge stand. */
const topOf = (zs: readonly number[]): number | null => (zs.length > 0 ? Math.max(...zs) : null);
const topZ = (v: LinkView): number | null => topOf(v.dots.map((d) => d.z));

/** What a view gives the shared input: its projection now and when the pointer is not its. */
interface InputView {
  /**
   * The projection for this frame (the view's box read once) and a key of the view: the lines
   * on screen are kept while the key holds.
   */
  frame(): { project: Project; key: string };
  /** How a line is put on screen for snapping. */
  screen(line: HoverLine, project: Project): ScreenLine;
  /** Another tool owns the pointer now. */
  busy(): boolean;
}

/**
 * The input both views share: snap on move (once a frame), pin on click, fly on double-click.
 * The lines on screen are kept per view key and registered set, so a pointer move only projects
 * again after the camera or the map moved.
 */
function pointerInput(source: '3d' | 'map', view: InputView) {
  let mine: HoverPoint | null = null;
  let lastClick: { x: number; y: number; t: number } | null = null;
  let pending: { x: number; y: number } | null = null;
  let raf = 0;
  let kept: {
    key: string;
    lines: LinkedHoverState['lines'];
    screens: Map<string, ScreenLine>;
  } | null = null;
  const clearMine = () => {
    if (mine && linkedHover.getState().hover === mine) linkedHover.getState().setHover(null);
    mine = null;
  };
  const onScreen = () => {
    const f = view.frame();
    const lines = linkedHover.getState().lines;
    if (kept?.key !== f.key || kept.lines !== lines)
      kept = { key: f.key, lines, screens: new Map() };
    const screens = kept.screens;
    const screenOf = (line: HoverLine): ScreenLine => {
      let sl = screens.get(line.key);
      if (!sl) {
        sl = view.screen(line, f.project);
        screens.set(line.key, sl);
      }
      return sl;
    };
    return { project: f.project, screenOf };
  };
  const snap = (x: number, y: number) => {
    if (view.busy()) return null;
    const s = linkedHover.getState();
    if (s.lines.size === 0) return null;
    const { screenOf } = onScreen();
    return snapAt(s, screenOf, x, y);
  };
  const moveNow = (x: number, y: number) => {
    const hit = snap(x, y);
    if (!hit) {
      clearMine();
      return;
    }
    const now = linkedHover.getState().hover;
    // the same point again: nothing to tell the chart
    if (mine && now === mine && mine.key === hit.key && mine.chainageM === hit.chainageM) return;
    mine = { key: hit.key, chainageM: hit.chainageM, source };
    linkedHover.getState().setHover(mine);
  };
  const cancel = () => {
    pending = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  return {
    /** A pointer move: handled on the next frame, the last move of the frame wins. */
    move(x: number, y: number) {
      pending = { x, y };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const p = pending;
        pending = null;
        if (p) moveNow(p.x, p.y);
      });
    },
    leave() {
      cancel();
      clearMine();
    },
    /** True when the click was on a line and is taken. */
    click(x: number, y: number): boolean {
      const hit = snap(x, y);
      if (!hit) return false;
      const t = performance.now();
      const repeat =
        lastClick !== null &&
        Math.hypot(x - lastClick.x, y - lastClick.y) <= REPEAT_PX &&
        t - lastClick.t <= REPEAT_MS;
      lastClick = { x, y, t };
      // the second click of a double-click keeps the pin the first one set
      if (repeat) return true;
      const s = linkedHover.getState();
      const pin = s.pin;
      const pinLine = pin ? s.lines.get(pin.key) : undefined;
      if (pin && pinLine && pin.key === hit.key) {
        // on the badge: it stands at the point's top dot (`topZ`), as the views draw it
        const m = markerAt(pinLine, pin.chainageM);
        const at = onScreen().project(m.e, m.n, topOf(m.dots.map((d) => d.z)));
        if (at && Math.hypot(at[0] - x, at[1] - y) <= ON_PIN_PX) {
          s.setPin(null);
          return true;
        }
      }
      s.setPin({ key: hit.key, chainageM: hit.chainageM, source });
      return true;
    },
    /** True when the double-click was on a line and asked for the fly. */
    dbl(x: number, y: number): boolean {
      const hit = snap(x, y);
      if (!hit) return false;
      linkedHover.getState().flyTo(hit.key, hit.chainageM);
      return true;
    },
    detach() {
      cancel();
      clearMine();
    },
  };
}

/**
 * An element's box, read at most once a frame: the snap, the tag and the badge of one frame
 * share it.
 */
function frameRect(el: HTMLElement): () => DOMRect {
  let rect: DOMRect | null = null;
  return () => {
    if (!rect) {
      rect = el.getBoundingClientRect();
      requestAnimationFrame(() => {
        rect = null;
      });
    }
    return rect;
  };
}

/** The tag and pin badge elements, kept in one overlay of a view. */
function overlay(host: HTMLElement, className: string) {
  const root = document.createElement('div');
  root.className = className;
  root.dataset.surface = 'dark';
  root.setAttribute('aria-hidden', 'true');
  const tag = document.createElement('span');
  tag.className = 'link-tag';
  tag.setAttribute('data-testid', 'link-tag');
  tag.hidden = true;
  const pin = document.createElement('span');
  pin.className = 'link-pin';
  pin.setAttribute('data-testid', 'link-pin');
  pin.hidden = true;
  pin.innerHTML =
    '<svg viewBox="0 0 12 16" width="12" height="16"><path d="M6 0a5 5 0 0 1 5 5c0 3.5-5 11-5 11S1 8.5 1 5a5 5 0 0 1 5-5z"/><circle cx="6" cy="5" r="2"/></svg>';
  root.append(tag, pin);
  host.appendChild(root);
  return {
    root,
    show(view: LinkView | null, at: Pt | null, pinned: boolean, pinAt: Pt | null) {
      if (!view || !at) tag.hidden = true;
      else {
        tag.hidden = false;
        if (tag.textContent !== view.tag) tag.textContent = view.tag;
        tag.dataset.key = view.key;
        tag.dataset.chainage = view.chainageM.toFixed(2);
        tag.classList.toggle('cut', view.deltaM !== null && view.deltaM < 0);
        tag.classList.toggle('fill', view.deltaM !== null && view.deltaM > 0);
        tag.classList.toggle('pinned', pinned);
        tag.style.transform = `translate(${String(Math.round(at[0]))}px, ${String(Math.round(at[1]))}px)`;
      }
      if (!pinAt) pin.hidden = true;
      else {
        pin.hidden = false;
        pin.style.transform = `translate(${String(Math.round(pinAt[0]))}px, ${String(Math.round(pinAt[1]))}px)`;
      }
    },
  };
}

/** The view of the shown point and of the pin, or null where their line is gone. */
function views(s: LinkedHoverState, fmt: TagFormat) {
  const p = shown(s);
  const line = p ? s.lines.get(p.key) : undefined;
  const view = p && line ? linkView(line, p.chainageM, fmt) : null;
  const pinLine = s.pin ? s.lines.get(s.pin.key) : undefined;
  const pinView = s.pin && pinLine ? linkView(pinLine, s.pin.chainageM, fmt) : null;
  return { view, pinView, pinned: p !== null && p === s.pin };
}

// ---------------------------------------------------------------- 3D

/** A dot's two layers: a ring is a dot with a dark middle, a filled dot has a white edge. */
interface DotPair {
  outer: Points<BufferGeometry, PointsMaterial>;
  core: Points<BufferGeometry, PointsMaterial>;
}

/** Draw the linked hover in a 3D view and let its line drive the chart. Returns the detach. */
export function attachHover3d(stage: EngineStage, frame: Frame): () => void {
  const group = new Group();
  group.name = 'aio-link';
  group.renderOrder = 50;
  group.raycast = () => undefined;
  stage.scene.add(group);
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const tags = overlay(host, 'sv-labels link-labels');
  const tmp = new Vector3();
  const canvasRect = frameRect(canvas);
  const hostRect = frameRect(host);
  const clamp = (e: number, n: number): number => {
    const top = stage.camera.position.y + 10_000;
    const l = frame.toLocal([e, n, 0]);
    const hit = stage.raycastRay(new Vector3(l[0], top, l[2]), new Vector3(0, -1, 0));
    return hit ? frame.toSite([hit.point.x, hit.point.y, hit.point.z])[2] : 0;
  };
  /** Site point to client pixels in the box `r`, null behind the camera. */
  const projectIn =
    (r: DOMRect): Project =>
    (e, n, z) => {
      const l = frame.toLocal([e, n, z ?? clamp(e, n)]);
      tmp.set(l[0], l[1], l[2]).project(stage.camera);
      if (tmp.z > 1) return null;
      return [r.left + ((tmp.x + 1) / 2) * r.width, r.top + ((1 - tmp.y) / 2) * r.height];
    };
  const toHost = (p: Pt | null): Pt | null => {
    if (!p) return null;
    const hr = hostRect();
    return [p[0] - hr.left, p[1] - hr.top];
  };

  // the drawn objects are made once and updated: a hover move changes positions and colours,
  // never programs
  const onTop = <T extends Line | Line2 | Points | Mesh>(o: T, name: string): T => {
    o.name = name;
    o.renderOrder = 50;
    o.frustumCulled = false;
    o.raycast = () => undefined;
    return o;
  };
  const shownIn = (o: Line | Line2 | Points | Mesh, on: boolean) => {
    if (on && o.parent !== group) group.add(o);
    else if (!on && o.parent === group) group.remove(o);
  };
  const trace = onTop(
    new Line2(
      new LineGeometry(),
      new LineMaterial({
        color: LINK_COLOURS.accent,
        linewidth: 3,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      }),
    ),
    'link-trace',
  );
  const gapGeometry = new BufferGeometry();
  gapGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
  const gap = onTop(
    new Line(
      gapGeometry,
      new LineDashedMaterial({
        color: '#ffffff',
        dashSize: 0.25,
        gapSize: 0.15,
        depthTest: false,
        transparent: true,
      }),
    ),
    'link-gap',
  );
  const ringGeometry = new RingGeometry(0.6, 1, 40);
  ringGeometry.rotateX(-Math.PI / 2);
  const ring = onTop(
    new Mesh(
      ringGeometry,
      new MeshBasicMaterial({
        color: LINK_COLOURS.accent,
        transparent: true,
        opacity: 0.35,
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    ),
    'link-ground',
  );
  const dotPool: DotPair[] = [];
  const point = (name: string) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(3), 3));
    const mat = new PointsMaterial({
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    return onTop(new Points(g, mat), name);
  };
  const dotPair = (i: number): DotPair => {
    let pair = dotPool[i];
    if (!pair) {
      pair = { outer: point('link-dot'), core: point('link-dot-core') };
      dotPool.push(pair);
    }
    return pair;
  };
  const setPoint = (
    p: Points<BufferGeometry, PointsMaterial>,
    at: readonly number[],
    size: number,
    colour: string,
  ) => {
    const pos = p.geometry.getAttribute('position') as Float32BufferAttribute;
    pos.setXYZ(0, at[0] ?? 0, at[1] ?? 0, at[2] ?? 0);
    pos.needsUpdate = true;
    p.material.size = size;
    p.material.color.set(colour);
  };
  const all = () => [trace, gap, ring, ...dotPool.flatMap((d) => [d.outer, d.core])];

  const local = (e: number, n: number, z: number) => frame.toLocal([e, n, z] as SitePoint);
  const ringScale = () => {
    if (ring.parent !== group) return;
    const r = Math.max(0.3, stage.camera.position.distanceTo(ring.position) * 0.015);
    ring.scale.set(r, r, r);
  };
  const sizeTrace = () => {
    trace.material.resolution.set(canvas.clientWidth, canvas.clientHeight);
  };

  let current: ReturnType<typeof views> = { view: null, pinView: null, pinned: false };
  const rebuild = () => {
    current = views(linkedHover.getState(), tagFormat());
    const v = current.view;
    // the trace
    const pts = v ? v.trace.map(([e, n, z]) => local(e, n, z ?? v.groundZ ?? clamp(e, n))) : [];
    if (pts.length > 1) {
      const g = new LineGeometry();
      g.setPositions(pts.flat());
      trace.geometry.dispose();
      trace.geometry = g;
    }
    shownIn(trace, pts.length > 1);
    // the gap between the surveys' dots
    if (v?.gap) {
      const pos = gap.geometry.getAttribute('position') as Float32BufferAttribute;
      const lo = local(v.e, v.n, v.gap[0]);
      const hi = local(v.e, v.n, v.gap[1]);
      pos.setXYZ(0, lo[0], lo[1], lo[2]);
      pos.setXYZ(1, hi[0], hi[1], hi[2]);
      pos.needsUpdate = true;
      gap.geometry.computeBoundingSphere();
      gap.computeLineDistances();
    }
    shownIn(gap, Boolean(v?.gap));
    // the soft ring on the ground
    if (v && v.groundZ !== null) {
      const [x, y, z] = local(v.e, v.n, v.groundZ);
      ring.position.set(x, y, z);
    }
    shownIn(ring, v !== null && v.groundZ !== null);
    // one dot per survey
    const dots = v?.dots ?? [];
    dots.forEach((d, i) => {
      const pair = dotPair(i);
      const at = local(v?.e ?? 0, v?.n ?? 0, d.z);
      setPoint(pair.outer, at, d.filled ? 13 : 12, d.filled ? '#ffffff' : d.colour);
      setPoint(pair.core, at, d.filled ? 10 : 7, d.filled ? d.colour : '#1b1f24');
      pair.outer.userData = { key: d.key, filled: d.filled };
      pair.core.userData = { key: d.key, filled: d.filled };
      shownIn(pair.outer, true);
      shownIn(pair.core, true);
    });
    for (let i = dots.length; i < dotPool.length; i++) {
      const pair = dotPool[i];
      if (!pair) continue;
      shownIn(pair.outer, false);
      shownIn(pair.core, false);
    }
    sizeTrace();
    ringScale();
    place();
    stage.requestRender();
  };
  const place = () => {
    const project = projectIn(canvasRect());
    const v = current.view;
    const at = v ? toHost(project(v.e, v.n, topZ(v))) : null;
    const pv = current.pinView;
    const pinAt = pv ? toHost(project(pv.e, pv.n, topZ(pv))) : null;
    tags.show(v, at, current.pinned, pinAt);
  };
  const offFrame = stage.onFrame(() => {
    sizeTrace();
    ringScale();
    place();
  });
  const offStore = linkedHover.subscribe((s, prev) => {
    if (s.hover !== prev.hover || s.pin !== prev.pin || s.lines !== prev.lines) rebuild();
  });

  const input = pointerInput('3d', {
    frame: () => {
      const r = canvasRect();
      const cam = stage.camera;
      const key = `${String(r.left)},${String(r.top)},${String(r.width)},${String(r.height)} ${cam.matrixWorld.elements.join(',')} ${cam.projectionMatrix.elements.join(',')}`;
      return { project: projectIn(r), key };
    },
    screen: screenLine,
    busy: () => pointerBusy(canvas, stage),
  });
  const onMove = (e: PointerEvent) => {
    // an orbit drag is not a hover
    if (e.buttons !== 0) return;
    input.move(e.clientX, e.clientY);
  };
  const onLeave = () => {
    input.leave();
  };
  const onDbl = (e: MouseEvent) => {
    if (input.dbl(e.clientX, e.clientY)) e.preventDefault();
  };
  const offClaim = stage.claimClicks((e) => input.click(e.clientX, e.clientY));
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDbl);
  rebuild();

  return () => {
    offStore();
    offFrame();
    offClaim();
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('dblclick', onDbl);
    input.detach();
    for (const o of all()) {
      group.remove(o);
      o.geometry.dispose();
      (o.material as Material).dispose();
    }
    stage.scene.remove(group);
    tags.root.remove();
    stage.requestRender();
  };
}

// ---------------------------------------------------------------- map

const SRC = 'aio-link';
/** The trace, the soft ring under the point (the 3D gap seen from above) and the dots. */
export const LINK_LAYERS = ['aio-link-trace', 'aio-link-gap', 'aio-link-dot'] as const;

/** Draw the linked hover on a map and let its line drive the chart. Returns the detach. */
export function attachHoverMap(ctl: MapController, frame: Frame): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const canvas = map.getCanvas();
  const container = map.getContainer();
  const tags = overlay(container, 'link-labels link-labels-map');
  const canvasRect = frameRect(canvas);
  const containerRect = frameRect(container);
  const lngLat = (e: number, n: number): [number, number] => {
    const ll = toWgs84([e, n, 0], epsg);
    return [ll[0], ll[1]];
  };
  /** Site point to client pixels in the canvas box `r`. */
  const projectIn =
    (r: DOMRect): Project =>
    (e, n) => {
      const px = map.project(lngLat(e, n));
      return [r.left + px.x, r.top + px.y];
    };
  const toHost = (p: Pt | null): Pt | null => {
    if (!p) return null;
    const hr = containerRect();
    return [p[0] - hr.left, p[1] - hr.top];
  };
  /** Bumped as the map moves or resizes: the lines on screen are projected again. */
  let viewSeq = 0;

  let current: ReturnType<typeof views> = { view: null, pinView: null, pinned: false };
  const data = () => {
    const v = current.view;
    const features: unknown[] = [];
    if (v) {
      if (v.trace.length > 1)
        features.push({
          type: 'Feature',
          properties: { kind: 'trace' },
          geometry: { type: 'LineString', coordinates: v.trace.map(([e, n]) => lngLat(e, n)) },
        });
      features.push({
        type: 'Feature',
        properties: { kind: 'gap' },
        geometry: { type: 'Point', coordinates: lngLat(v.e, v.n) },
      });
      // the rings first, so the filled dot sits on top
      for (const d of [...v.dots].sort((a, b) => Number(a.filled) - Number(b.filled)))
        features.push({
          type: 'Feature',
          properties: {
            kind: 'dot',
            key: d.key,
            colour: d.colour,
            filled: d.filled,
            radius: d.filled ? 5 : 8,
            fillOpacity: d.filled ? 1 : 0,
            stroke: d.filled ? '#ffffff' : d.colour,
          },
          geometry: { type: 'Point', coordinates: lngLat(v.e, v.n) },
        });
    }
    return { type: 'FeatureCollection', features };
  };
  let waiting = false;
  const whenIdle = () => {
    waiting = false;
    draw();
  };
  const draw = () => {
    try {
      if (!map.isStyleLoaded()) {
        if (!waiting) {
          waiting = true;
          map.once('idle', whenIdle);
        }
        return;
      }
      const src = map.getSource(SRC) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(data());
      else map.addSource(SRC, { type: 'geojson', data: data() as never });
      if (!map.getLayer(LINK_LAYERS[0]))
        map.addLayer({
          id: LINK_LAYERS[0],
          type: 'line',
          source: SRC,
          filter: ['==', ['get', 'kind'], 'trace'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': LINK_COLOURS.accent, 'line-width': 4 },
        });
      if (!map.getLayer(LINK_LAYERS[1]))
        map.addLayer({
          id: LINK_LAYERS[1],
          type: 'circle',
          source: SRC,
          filter: ['==', ['get', 'kind'], 'gap'],
          paint: {
            'circle-radius': 14,
            'circle-color': LINK_COLOURS.accent,
            'circle-opacity': 0.25,
            'circle-blur': 0.4,
          },
        });
      if (!map.getLayer(LINK_LAYERS[2]))
        map.addLayer({
          id: LINK_LAYERS[2],
          type: 'circle',
          source: SRC,
          filter: ['==', ['get', 'kind'], 'dot'],
          paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'colour'],
            'circle-opacity': ['get', 'fillOpacity'],
            'circle-stroke-color': ['get', 'stroke'],
            'circle-stroke-width': 2,
          },
        });
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  };
  const place = () => {
    const project = projectIn(canvasRect());
    const v = current.view;
    const pv = current.pinView;
    tags.show(
      v,
      v ? toHost(project(v.e, v.n, null)) : null,
      current.pinned,
      pv ? toHost(project(pv.e, pv.n, null)) : null,
    );
  };
  const rebuild = () => {
    current = views(linkedHover.getState(), tagFormat());
    draw();
    place();
  };
  const offStore = linkedHover.subscribe((s, prev) => {
    if (s.hover !== prev.hover || s.pin !== prev.pin || s.lines !== prev.lines) rebuild();
  });

  const input = pointerInput('map', {
    frame: () => {
      const r = canvasRect();
      const key = `${String(viewSeq)} ${String(r.left)},${String(r.top)},${String(r.width)},${String(r.height)}`;
      return { project: projectIn(r), key };
    },
    // on a flat map the heights do not move the line: its vertices are enough
    screen: vertexLine,
    busy: () => pointerBusy(canvas),
  });
  // only the map's own surface: controls, DOM markers and the pile line's handles over it keep
  // their pointer
  const onMap = (e: Event) => e.target === canvas;
  const onMove = (e: PointerEvent) => {
    if (e.buttons !== 0) return;
    if (!onMap(e)) {
      input.leave();
      return;
    }
    input.move(e.clientX, e.clientY);
  };
  const onLeave = () => {
    input.leave();
  };
  // capture on the container: a click or double-click on the line is the hover's, not the
  // map's pick or zoom underneath it
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || !onMap(e)) return;
    if (input.click(e.clientX, e.clientY)) e.stopPropagation();
  };
  const onDbl = (e: MouseEvent) => {
    if (!onMap(e) || !input.dbl(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onRender = () => {
    viewSeq++;
    place();
  };
  const onResize = () => {
    viewSeq++;
  };
  const onStyle = () => {
    draw();
  };
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerleave', onLeave);
  container.addEventListener('click', onClick, { capture: true });
  container.addEventListener('dblclick', onDbl, { capture: true });
  map.on('move', onRender);
  map.on('resize', onResize);
  map.on('styledata', onStyle);
  rebuild();

  return () => {
    offStore();
    container.removeEventListener('pointermove', onMove);
    container.removeEventListener('pointerleave', onLeave);
    container.removeEventListener('click', onClick, { capture: true });
    container.removeEventListener('dblclick', onDbl, { capture: true });
    map.off('move', onRender);
    map.off('resize', onResize);
    map.off('styledata', onStyle);
    map.off('idle', whenIdle);
    input.detach();
    tags.root.remove();
    try {
      for (const id of [...LINK_LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {
      // the map is going away
    }
  };
}

// ---------------------------------------------------------------- fly

/** Where the point lands while the section window covers the stage's lower part: from the top. */
export const LINK_FLY_UNDER_WINDOW = 0.25;

/**
 * The point fly that lands `p` at `fromTop` (a fraction of the view's height) instead of the
 * centre, keeping the camera's direction: the target moves down the screen from `p` by the
 * matching part of the view's half-height at `distance`, and the camera keeps looking along its
 * own direction.
 */
export function flyLandingHigh(
  p: readonly [number, number, number],
  distance: number,
  camera: PerspectiveCamera,
  fromTop: number,
): { kind: 'point'; p: Vec3; distance: number; dir: Vec3 } {
  camera.updateMatrixWorld();
  const forward = camera.getWorldDirection(new Vector3());
  // the camera's screen-up in the world, square to its direction
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  up.addScaledVector(forward, -up.dot(forward)).normalize();
  const half = distance * Math.tan(((camera.fov / 2) * Math.PI) / 180);
  const shift = (1 - 2 * fromTop) * half;
  const target = new Vector3(...p).addScaledVector(up, -shift);
  const back = forward.clone().negate();
  return {
    kind: 'point',
    p: [target.x, target.y, target.z],
    distance,
    dir: [back.x, back.y, back.z],
  };
}

/**
 * Carry out the flies the chart or a line asks for (`linkedHover.flyTo`): the camera in 3D and the
 * map in Map view both follow the workspace's point fly. Attach once, not per view. While the
 * section window is open (it covers the lower part of the stage) the 3D fly lands the point in the
 * upper quarter of the view (`camera`: the active 3D stage's).
 */
export function attachHoverFly(
  frame: Frame,
  fallbackZ: () => number = () => 0,
  camera: () => PerspectiveCamera | null = () => {
    const c = getActiveStage()?.camera;
    return c instanceof PerspectiveCamera ? c : null;
  },
): () => void {
  return linkedHover.subscribe((s, prev) => {
    const fly = s.fly;
    if (!fly || fly === prev.fly) return;
    const line = s.lines.get(fly.key);
    if (!line) return;
    const m = markerAt(line, fly.chainageM);
    const z = m.dots.at(-1)?.z ?? fallbackZ();
    const p = frame.toLocal([m.e, m.n, z]);
    const cam = sectionStore.getState().window ? camera() : null;
    workspace
      .getState()
      .flyTo(
        cam
          ? flyLandingHigh(p, LINK_FLY_DISTANCE_M, cam, LINK_FLY_UNDER_WINDOW)
          : { kind: 'point', p, distance: LINK_FLY_DISTANCE_M },
      );
  });
}
