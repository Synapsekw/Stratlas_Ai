/**
 * The opened pile in the main 3D view (founder, 26 Oct 2026, "look A"): `pileLook`'s glass box
 * drawn with three.js. The pile's surface is sampled on the date in focus (its prepared surface,
 * else the stage's own terrain), the base is the pile's own (`buildBase`, the boundary's heights
 * when it cannot be built), and the box replaces the pile's outline and fill (`pileLookState`).
 * The top is solid red or coloured by height above the base (`pileView.surface`, with a legend in
 * the view); while Show, Cut & fill is on it takes the site's cut and fill colours. Only the
 * opened pile, and never while its boundary is being edited: then the outline and its handles show.
 *
 * It also answers `askPileFly`: the camera frames the box from an oblique view, after a click in
 * 3D only when the pile is not already mostly in view.
 */
import type { EngineStage } from '@aio/engine';
import { formatNumber, fromSI, localeOf, unitLabel } from '@aio/geo';
import { isSurfaceSide, type BaseSpec, type SitePoint, type SurveyMeasurement } from '@aio/schema';
import { buildBase, densify, effectiveUnits, heatRamp, samplePoints, Tin } from '@aio/survey';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Material,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { stageShow } from '../../workspace/StageShow';
import { timeline } from '../../workspace/timeline';
import { primaryScene } from '../../workspace/compare';
import { compareStore } from '../compareStore';
import { drawnSampler } from '../dateSurfaces';
import { drawnPoints, measurementsOn } from '../measureDates';
import { editedOutline } from '../measureMove';
import { captureInFocus } from '../measureRows';
import { stageClamp, type Frame } from '../measureScene';
import { measureStore } from '../measureStore';
import { isPile } from './openPile';
import { pileFly, type PileFlyAsk } from './pileFly';
import {
  buildPrism,
  gridPoints,
  HEIGHT_RAMP,
  legendStops,
  loopSegments,
  mostlyInView,
  pileFlyView,
  pileGrid,
  pileLift,
  prismHitShapes,
  ringBase,
  type PileGrid,
  type Prism,
  type RGB,
} from './pileLook';
import { pileLookState } from './pileLookState';
import { pileView } from './pileView';
import './pile.css';

/** The blue of the base (sRGB). */
const BASE_BLUE = 0x3373ff;
/** How long a fly waits for the box before it frames an estimate (ms). */
const FLY_WAIT_MS = 4000;

/** The opened pile the box is for: the focused pile on screen, not being edited or drawn. */
function openedPile(): SurveyMeasurement | null {
  const s = measureStore.getState();
  if (!s.focus || s.editing || s.draw) return null;
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!m || !isPile(m)) return null;
  return measurementsOn(s, primaryScene.getState()).some((x) => x.id === m.id) ? m : null;
}

const manifestNow = () => workspace.getState().project?.manifest ?? null;

/** The pile's boundary as drawn on the date in focus. */
function ringOf(m: SurveyMeasurement): SitePoint[] {
  const stored = editedOutline(m, timeline.getState().focus);
  return drawnPoints({ ...m, points: [...stored] }, manifestNow());
}

/** The date whose surface the pile is sampled on: the one in focus, else the pile's own. */
function captureOf(m: SurveyMeasurement): string | null {
  return (
    captureInFocus(timeline.getState().focus, manifestNow()) ??
    (m.scope.kind === 'survey' ? m.scope.capture : null)
  );
}

/** The pile's base as its first comparison has it (a surface side: the smart base). */
function baseSpecOf(m: SurveyMeasurement): BaseSpec {
  const from = m.items[0]?.from;
  return from && !isSurfaceSide(from) ? (from as BaseSpec) : { kind: 'smart' };
}

/** The terrain and the base sampled for one pile, on one date. */
interface Sampled {
  key: string;
  id: string;
  ring: SitePoint[];
  grid: PileGrid;
  zs: Float64Array;
  /** The base at each grid point, NaN where it has none. */
  base: Float64Array;
}

/** Sample the pile's surface and its base on the grid. */
async function sample(
  m: SurveyMeasurement,
  ring: SitePoint[],
  clamp: (e: number, n: number) => number | null,
): Promise<Omit<Sampled, 'key' | 'id'>> {
  const capture = captureOf(m);
  const sampler = capture ? await drawnSampler(capture, manifestNow()) : null;
  // without a prepared surface the stage's terrain is ray cast: a coarser grid
  const grid = pileGrid(ring, sampler ? undefined : 40);
  const { es, ns } = gridPoints(grid);
  let zs: Float64Array;
  if (sampler) zs = await sampler(es, ns);
  else {
    zs = new Float64Array(es.length);
    for (let k = 0; k < zs.length; k++) zs[k] = clamp(es[k] ?? 0, ns[k] ?? 0) ?? Number.NaN;
  }
  const at =
    sampler ??
    ((xs: Float64Array, ys: Float64Array) => {
      const out = new Float64Array(xs.length);
      for (let k = 0; k < xs.length; k++) out[k] = clamp(xs[k] ?? 0, ys[k] ?? 0) ?? Number.NaN;
      return Promise.resolve(out);
    });
  // the base in metres from the grid's corner (the engine's own local frame)
  const le = grid.minE;
  const ln = grid.minN;
  const lring = ring.map((p): [number, number] => [p[0] - le, p[1] - ln]);
  const base = new Float64Array(es.length).fill(Number.NaN);
  try {
    const [b] = await buildBase(baseSpecOf(m), {
      ring: lring,
      perimeter: async () => {
        const d = densify(lring, grid.step);
        const z = await at(
          d.xs.map((x) => x + le),
          d.ys.map((y) => y + ln),
        );
        const keep: number[] = [];
        z.forEach((v, k) => {
          if (Number.isFinite(v)) keep.push(k);
        });
        return {
          xs: Float64Array.from(keep, (k) => d.xs[k] ?? 0),
          ys: Float64Array.from(keep, (k) => d.ys[k] ?? 0),
          zs: Float64Array.from(keep, (k) => z[k] ?? 0),
        };
      },
      interior: () => {
        let lo = Infinity;
        let hi = -Infinity;
        zs.forEach((v) => {
          if (!Number.isFinite(v)) return;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        });
        return Promise.resolve(lo === Infinity ? null : [lo, hi]);
      },
      atPoints: (xs, ys) =>
        at(
          xs.map((x) => x + le),
          ys.map((y) => y + ln),
        ),
      toLocal: (e, n) => [e - le, n - ln],
    });
    const xs = es.map((e) => e - le);
    const ys = ns.map((n) => n - ln);
    if (b instanceof Tin) base.set(samplePoints(b, xs, ys));
    else for (let k = 0; k < xs.length; k++) base[k] = b.fn(xs[k] ?? 0, ys[k] ?? 0);
  } catch {
    // no base to be built (no survey under the edge yet): the boundary's own heights stand in
  }
  return { ring, grid, zs, base };
}

/** The site's cut and fill colour under (e, n) while Show, Cut & fill draws it; else null. */
function changeColours(): ((e: number, n: number) => RGB | null) | null {
  const show = stageShow.getState();
  const c = compareStore.getState();
  const h = c.siteHeat;
  if (!show.active || show.surface !== 'change' || !c.heat.show3d || !h) return null;
  const ramp = heatRamp(measureStore.getState().settings.heatmap, 255);
  return (e, n) => {
    const i = Math.floor((e - h.x0) / h.cellM);
    const r = Math.floor((n - h.y0) / h.cellM);
    if (i < 0 || r < 0 || i >= h.nx || r >= h.ny) return null;
    const c4 = ramp.colorOf(h.dz[r * h.nx + i] ?? Number.NaN);
    return c4 ? [c4[0] / 255, c4[1] / 255, c4[2] / 255] : null;
  };
}

/** A height in the site's distance unit, one decimal: "3.8 m". */
function heightText(m: number): string {
  const s = measureStore.getState().settings;
  const units = effectiveUnits(s.units);
  const locale = s.locale ?? localeOf(units.distance);
  return `${formatNumber(fromSI(m, 'distance', units.distance), 1, locale)} ${unitLabel(units.distance)}`;
}

/** Attach the opened pile's box to the main 3D view. Returns the detach. */
export function attachPileLook3d(stage: EngineStage, frame: Frame): () => void {
  const group = new Group();
  group.name = 'aio-pile-look';
  stage.scene.add(group);
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const clamp = stageClamp(stage, frame);
  const fatMats: LineMaterial[] = [];
  let legend: HTMLDivElement | null = null;

  let sampled: Sampled | null = null;
  let pending = '';
  let prism: Prism | null = null;
  let drawnKey = '';
  let drawnHeat: unknown = null;
  let surfacesSeq = 0;
  let flyAsk: PileFlyAsk | null = null;
  let flyTimer: number | null = null;

  const clear = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const o = c as Mesh;
      o.geometry.dispose();
      (o.material as Material).dispose();
    }
    fatMats.length = 0;
    legend?.remove();
    legend = null;
  };

  const toLocal = (positions: Float64Array): Float32Array => {
    const out = new Float32Array(positions.length);
    for (let k = 0; k + 2 < positions.length; k += 3) {
      const l = frame.toLocal([positions[k] ?? 0, positions[k + 1] ?? 0, positions[k + 2] ?? 0]);
      out[k] = l[0];
      out[k + 1] = l[1];
      out[k + 2] = l[2];
    }
    return out;
  };

  const lines = (pts: SitePoint[], width: number, depthTest: boolean, name: string) => {
    if (pts.length < 2) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(pts.flatMap((p) => frame.toLocal(p)));
    const mat = new LineMaterial({
      color: 0xffffff,
      linewidth: width,
      transparent: true,
      opacity: 0.95,
      depthTest,
      depthWrite: false,
    });
    mat.resolution.set(canvas.clientWidth, canvas.clientHeight);
    fatMats.push(mat);
    const l = new LineSegments2(g, mat);
    l.name = name;
    l.renderOrder = 44;
    l.frustumCulled = false;
    l.raycast = () => undefined;
    group.add(l);
  };

  const mesh = (
    positions: Float64Array,
    index: Uint32Array,
    mat: MeshBasicMaterial,
    colours: Float32Array | null,
    name: string,
    order: number,
  ) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(toLocal(positions), 3));
    if (colours) g.setAttribute('color', new Float32BufferAttribute(colours, 3));
    g.setIndex(Array.from(index));
    const o = new Mesh(g, mat);
    o.name = name;
    o.renderOrder = order;
    o.frustumCulled = false;
    o.raycast = () => undefined;
    group.add(o);
  };

  const showLegend = (hmax: number) => {
    const [lo, mid, hi] = legendStops(hmax);
    const el = document.createElement('div');
    el.className = 'pl-legend';
    el.dataset.testid = 'pile-height-legend';
    el.setAttribute('role', 'img');
    const title = t('pile.look.legend');
    el.setAttribute('aria-label', `${title}, ${heightText(lo)} to ${heightText(hi)}`);
    const caption = document.createElement('div');
    caption.className = 'pl-legend-title';
    caption.textContent = title;
    const bar = document.createElement('div');
    bar.className = 'pl-legend-bar';
    bar.style.background = `linear-gradient(90deg, ${HEIGHT_RAMP.map(
      (c) => `rgb(${c.map((v) => String(Math.round(v * 255))).join(', ')})`,
    ).join(', ')})`;
    const ticks = document.createElement('div');
    ticks.className = 'pl-legend-ticks';
    for (const v of [lo, mid, hi]) {
      const s = document.createElement('span');
      s.textContent = heightText(v);
      ticks.appendChild(s);
    }
    el.append(caption, bar, ticks);
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(el);
    legend = el;
  };

  /** Publish what is drawn: the measurement layer and the pick read it. */
  const publish = (id: string | null, p: Prism | null) => {
    const shown = id !== null && p !== null ? id : null;
    const was = pileLookState.getState();
    if (was.shown === shown && (shown === null || was.hits.length > 0)) {
      if (shown !== null && p) pileLookState.setState({ hits: prismHitShapes(shown, p) });
      return;
    }
    pileLookState.setState({ shown, hits: shown !== null && p ? prismHitShapes(shown, p) : [] });
  };

  const draw = () => {
    const m = openedPile();
    if (!m) {
      if (drawnKey !== '') {
        clear();
        drawnKey = '';
        prism = null;
        publish(null, null);
        stage.requestRender();
      }
      return;
    }
    const ring = ringOf(m);
    if (ring.length < 3) return;
    // a surface prepared since: sampled again
    const key = JSON.stringify([m.id, captureOf(m), ring, baseSpecOf(m), surfacesSeq]);
    if (sampled?.key !== key) {
      if (pending !== key) {
        pending = key;
        // the previous pile's box goes while this one's heights come
        if (sampled && sampled.id !== m.id) {
          clear();
          drawnKey = '';
          prism = null;
          publish(null, null);
        }
        void sample(m, ring, clamp)
          .then((r) => {
            if (pending !== key) return;
            pending = '';
            sampled = { key, id: m.id, ...r };
            draw();
          })
          .catch(() => {
            if (pending === key) pending = '';
          });
      }
      return;
    }
    const mode = pileView.getState().surface;
    const change = changeColours();
    const heat = change ? compareStore.getState().siteHeat : null;
    const dkey = JSON.stringify([key, mode, measureStore.getState().settings]);
    if (dkey === drawnKey && heat === drawnHeat) return;
    const s = sampled;
    const fallback = ringBase(s.ring);
    const { minE, minN, step, nx } = s.grid;
    const base = (e: number, n: number): number | null => {
      const i = Math.round((e - minE) / step);
      const j = Math.round((n - minN) / step);
      const b = s.base[j * nx + i] ?? Number.NaN;
      return Number.isFinite(b) ? b : fallback(e, n);
    };
    const p = buildPrism({ ring: s.ring, grid: s.grid, zs: s.zs, base, mode, change });
    clear();
    drawnKey = dkey;
    drawnHeat = heat;
    prism = p;
    // the base: translucent blue on the base surface, seen through the ground
    mesh(
      p.base.positions,
      p.base.index,
      new MeshBasicMaterial({
        color: BASE_BLUE,
        transparent: true,
        opacity: 0.42,
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
      null,
      'pile-look-base',
      29,
    );
    // the pile, lifted: solid red (or by height, or cut and fill), its relief shaded in
    mesh(
      p.top.positions,
      p.top.index,
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        side: DoubleSide,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
      p.top.colours,
      'pile-look-top',
      31,
    );
    // the glass box: the boundary at the top and at the ground, a post at each vertex
    lines(loopSegments(p.topLoop), 1.8, true, 'pile-look-frame-top');
    lines(loopSegments(p.bottomLoop), 2.2, false, 'pile-look-frame-base');
    lines(
      p.posts.flatMap(([a, b]) => [a, b]),
      1.4,
      true,
      'pile-look-posts',
    );
    if (mode === 'height' && !change) showLegend(p.hmax);
    publish(m.id, p);
    stage.requestRender();
    if (flyAsk?.id === m.id) fly(flyAsk, p);
  };

  /** Frame the box (or an estimate of it while it is not built yet). */
  const fly = (ask: PileFlyAsk, p: Pick<Prism, 'centre' | 'lift' | 'span' | 'groundRing'>) => {
    flyAsk = null;
    if (flyTimer !== null) window.clearTimeout(flyTimer);
    flyTimer = null;
    if (ask.onlyIfOutOfView) {
      const v = new Vector3();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const pts = p.groundRing.flatMap((q) => [q, [q[0], q[1], q[2] + p.lift] as SitePoint]);
      const screen = pts.map((q) => {
        const l = frame.toLocal(q);
        v.set(l[0], l[1], l[2]).project(stage.camera);
        return v.z > 1 ? null : { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
      });
      if (mostlyInView(screen, w, h)) return;
    }
    const view = pileFlyView(p);
    const c = frame.toLocal(view.at);
    const d = frame.toLocal([
      view.at[0] + view.dir[0],
      view.at[1] + view.dir[1],
      view.at[2] + view.dir[2],
    ]);
    workspace.getState().flyTo({
      kind: 'point',
      p: c,
      distance: view.distance,
      dir: [d[0] - c[0], d[1] - c[1], d[2] - c[2]],
    });
    stage.requestRender();
  };

  /** Frame a pile whose box is not built: its boundary, lifted as far as its size alone says. */
  const estimate = (id: string) => {
    const m = measureStore.getState().file.measurements.find((x) => x.id === id);
    if (!m) return null;
    const ring = ringOf(m);
    if (ring.length < 3) return null;
    const g = pileGrid(ring);
    const editing = measureStore.getState().editing !== null;
    const z = ring.reduce((a, q) => a + q[2], 0) / ring.length;
    return {
      centre: [(g.minE + g.maxE) / 2, (g.minN + g.maxN) / 2, z] as SitePoint,
      // an outline being edited lies on the ground
      lift: editing ? 0 : pileLift(0, g.span),
      span: g.span,
      groundRing: ring,
    };
  };

  const onFly = (ask: PileFlyAsk | null) => {
    if (!ask) return;
    if (prism && pileLookState.getState().shown === ask.id) {
      fly(ask, prism);
      return;
    }
    flyAsk = ask;
    if (flyTimer !== null) window.clearTimeout(flyTimer);
    const run = () => {
      flyTimer = null;
      if (flyAsk?.seq !== ask.seq) return;
      const e = estimate(ask.id);
      if (e) fly(ask, e);
      else flyAsk = null;
    };
    // an outline being edited has no box to wait for
    if (measureStore.getState().editing) run();
    else flyTimer = window.setTimeout(run, FLY_WAIT_MS);
  };

  const offStore = measureStore.subscribe((s, p) => {
    if (
      s.focus !== p.focus ||
      s.editing !== p.editing ||
      s.draw !== p.draw ||
      s.file !== p.file ||
      s.hiddenMeasurements !== p.hiddenMeasurements ||
      s.measurementsVisible !== p.measurementsVisible ||
      s.settings !== p.settings
    )
      draw();
  });
  const offTimeline = timeline.subscribe((s, p) => {
    if (s.focus !== p.focus) draw();
  });
  const offDates = primaryScene.subscribe(() => {
    draw();
  });
  const offView = pileView.subscribe((s, p) => {
    if (s.surface !== p.surface) draw();
  });
  const offShow = stageShow.subscribe((s, p) => {
    if (s.active !== p.active || s.surface !== p.surface) draw();
  });
  const offCompare = compareStore.subscribe((s, p) => {
    if (s.surfaces !== p.surfaces) surfacesSeq += 1;
    if (s.siteHeat !== p.siteHeat || s.heat !== p.heat || s.surfaces !== p.surfaces) draw();
  });
  const offFly = pileFly.subscribe((s, p) => {
    if (s.ask !== p.ask) onFly(s.ask);
  });
  const offFrame = stage.onFrame(() => {
    for (const mat of fatMats) mat.resolution.set(canvas.clientWidth, canvas.clientHeight);
  });
  draw();

  return () => {
    offStore();
    offTimeline();
    offDates();
    offView();
    offShow();
    offCompare();
    offFly();
    offFrame();
    if (flyTimer !== null) window.clearTimeout(flyTimer);
    clear();
    publish(null, null);
    stage.scene.remove(group);
    stage.requestRender();
  };
}
