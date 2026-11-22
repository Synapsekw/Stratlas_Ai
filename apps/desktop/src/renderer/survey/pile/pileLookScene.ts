/**
 * The opened pile in the main 3D view (founder, 26 Oct 2026, "look A"): `pileLook`'s glass box
 * drawn with three.js. The pile's surface is sampled on the date in focus (its prepared surface,
 * else the stage's own terrain), the base is the pile's own (`buildBase`, the boundary's heights
 * when it cannot be built), and the box replaces the pile's outline and fill (`pileLookState`).
 * The top is solid red or coloured by height above the base (`pileView.surface`, with a legend in
 * the view); while Show, Cut & fill is on it takes the site's cut and fill colours. Only the
 * opened pile, and never while its boundary is being edited: then the outline and its handles show.
 *
 * The volumetric report pins a pile to a survey date instead (`pileLookState.pinned`): that pile's
 * box is drawn on that date whatever is focused or on screen, always Solid and with no legend.
 * Which pile, date, outline and mode is `lookTarget`'s rule; the base is `pileBase`'s.
 *
 * It also answers `askPileFly`: the camera frames the box from an oblique view, after a click in
 * 3D only when the pile is not already mostly in view.
 */
import type { EngineStage } from '@aio/engine';
import { formatNumber, fromSI, localeOf, unitLabel } from '@aio/geo';
import type { SitePoint, SurveyMeasurement } from '@aio/schema';
import { effectiveUnits, heatRamp } from '@aio/survey';
import { t } from '@aio/ui';
import { changeColour, volumetric } from '@aio/volumetric';
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
import { stageClamp, type Frame } from '../measureScene';
import { measureStore } from '../measureStore';
import { baseSpecOf, buildPileBase, heightExtent } from './pileBase';
import { flyStep, pileFly, sampleGate, type PileFlyAsk } from './pileFly';
import {
  buildPrism,
  gridColours,
  gridPoints,
  HEIGHT_RAMP,
  legendStops,
  loopSegments,
  mostlyInView,
  pileChangeGrid,
  pileFlyView,
  pileGrid,
  pileLift,
  prismHitShapes,
  ringBase,
  type ChangeCells,
  type PileGrid,
  type Prism,
  type RGB,
} from './pileLook';
import { pileLookState } from './pileLookState';
import { lookTarget, outlineOn, type LookTarget } from './pileLookTarget';
import { pileView } from './pileView';
import './pile.css';

/** The blue of the base (sRGB). */
const BASE_BLUE = 0x3373ff;
/** How long a fly waits for the box before it frames an estimate (ms). */
const FLY_WAIT_MS = 4000;

const manifestNow = () => workspace.getState().project?.manifest ?? null;

/** The pile the box is for now: the pinned one, else the opened one (`lookTarget`). */
function targetNow(): LookTarget | null {
  return lookTarget(
    measureStore.getState(),
    primaryScene.getState(),
    timeline.getState().focus,
    manifestNow(),
    pileLookState.getState().pinned,
    pileView.getState().surface,
  );
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

/** Sample the pile's surface and its base on the grid, on the date `capture`. */
async function sample(
  m: SurveyMeasurement,
  ring: SitePoint[],
  capture: string | null,
  clamp: (e: number, n: number) => number | null,
): Promise<Omit<Sampled, 'key' | 'id'>> {
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
  const built = await buildPileBase({
    spec: baseSpecOf(m),
    ring,
    step: grid.step,
    at: (xs, ys) => at(xs, ys),
    interior: () => heightExtent(zs),
  });
  // no base to be built (no survey under the edge yet): the boundary's own heights stand in
  const base = built ? built(es, ns) : new Float64Array(es.length).fill(Number.NaN);
  return { ring, grid, zs, base };
}

/**
 * The cut and fill colours under (e, n) while Show, Cut & fill draws them, with the grid they are
 * read from; else null. A survey project reads the site's heat map with the heat map's own
 * colours; an older kit project the kit's own grid, coloured as the kit drapes it on its terrain
 * (grey inside its deadband), so the box top matches the ground around it.
 */
function changeColours(): { at: (e: number, n: number) => RGB | null; grid: ChangeCells } | null {
  const c = compareStore.getState();
  const kit = volumetric.getState();
  const src = pileChangeGrid({
    show: stageShow.getState(),
    heat3d: c.heat.show3d,
    siteHeat: c.siteHeat,
    kit,
  });
  if (!src) return null;
  if (src.kind === 'kit') {
    const deadband = kit.file?.deadbandM ?? 0.1;
    return {
      grid: src.grid,
      at: gridColours(src.grid, (dz) => {
        const [r, g, b] = changeColour(dz, deadband);
        return [r / 255, g / 255, b / 255];
      }),
    };
  }
  const ramp = heatRamp(measureStore.getState().settings.heatmap, 255);
  return {
    grid: src.grid,
    at: gridColours(src.grid, (dz) => {
      const c4 = ramp.colorOf(dz);
      return c4 ? [c4[0] / 255, c4[1] / 255, c4[2] / 255] : null;
    }),
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
  const gate = sampleGate();
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
    // what the view shows, for tests and tools: the box's pile and how its top is coloured
    delete host.dataset.pileLook;
    delete host.dataset.pileSurface;
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
  const publish = (id: string | null, p: Prism | null, capture: string | null = null) => {
    if (id !== null && p !== null)
      pileLookState.setState({ shown: id, shownOn: capture, hits: prismHitShapes(id, p) });
    else if (pileLookState.getState().shown !== null)
      pileLookState.setState({ shown: null, shownOn: null, hits: [] });
  };

  const draw = () => {
    const target = targetNow();
    if (!target) {
      if (drawnKey !== '') {
        clear();
        drawnKey = '';
        prism = null;
        publish(null, null);
        stage.requestRender();
      }
      return;
    }
    const { m, ring, capture, mode } = target;
    if (ring.length < 3) return;
    // a surface prepared since: sampled again
    const key = JSON.stringify([m.id, capture, ring, baseSpecOf(m), surfacesSeq]);
    if (sampled?.key !== key) {
      if (gate.start(key)) {
        // the previous pile's box goes while this one's heights come
        if (sampled && sampled.id !== m.id) {
          clear();
          drawnKey = '';
          prism = null;
          publish(null, null);
        }
        void sample(m, ring, capture, clamp)
          .then((r) => {
            // a result for a pile or date left again meanwhile is not drawn
            if (!gate.settle(key)) return;
            sampled = { key, id: m.id, ...r };
            draw();
          })
          .catch(() => {
            gate.fail(key);
          });
      }
      return;
    }
    // back on the sampled pile: a sample still in flight for another is no longer wanted
    gate.reuse();
    // a pinned box is the report's: never the site's cut and fill colours
    const colours = target.pinned ? null : changeColours();
    const change = colours?.at ?? null;
    const heat = colours?.grid ?? null;
    const dkey = JSON.stringify([key, mode, measureStore.getState().settings, target.pinned]);
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
    const p = buildPrism({
      ring: s.ring,
      grid: s.grid,
      zs: s.zs,
      base,
      mode,
      change,
      // the report's picture: a flat pile gets a low box
      look: target.pinned ? 'picture' : 'opened',
    });
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
    publish(m.id, p, capture);
    host.dataset.pileLook = m.id;
    host.dataset.pileSurface = change ? 'change' : mode;
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
    const view = pileFlyView(p, {
      vfovDeg: stage.camera.fov,
      aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
    });
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
    const ring = outlineOn(m, timeline.getState().focus, manifestNow());
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

  const cancelFly = () => {
    flyAsk = null;
    if (flyTimer !== null) window.clearTimeout(flyTimer);
    flyTimer = null;
  };

  /** Act on an ask now (`deferred` false) or when the wait for its box ends. */
  const step = (ask: PileFlyAsk, deferred: boolean) => {
    const boxShown = prism !== null && pileLookState.getState().shown === ask.id;
    const editing = measureStore.getState().editing !== null;
    const next = flyStep({ boxShown, editing, deferred });
    if (next === 'box' && prism) fly(ask, prism);
    else if (next === 'estimate') {
      const e = estimate(ask.id);
      if (e) fly(ask, e);
      else cancelFly();
    } else if (next === 'drop') cancelFly();
    else {
      flyAsk = ask;
      if (flyTimer !== null) window.clearTimeout(flyTimer);
      flyTimer = window.setTimeout(() => {
        flyTimer = null;
        if (flyAsk?.seq === ask.seq) step(ask, true);
      }, FLY_WAIT_MS);
    }
  };

  const onFly = (ask: PileFlyAsk | null) => {
    if (ask) step(ask, false);
  };

  const offStore = measureStore.subscribe((s, p) => {
    // an edit begun: a fly still waiting for the box never moves the camera under it
    if (s.editing && !p.editing && flyAsk) cancelFly();
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
  // a layer switch or the view's date puts the pile on or off screen
  const offDates = primaryScene.subscribe((ws, prev) => {
    if (ws.hidden !== prev.hidden || ws.dates !== prev.dates) draw();
  });
  // the report pins a pile to a date, or lets it go (only `pinned`: the scene writes the rest)
  const offPinned = pileLookState.subscribe((s, p) => {
    if (s.pinned !== p.pinned) draw();
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
  // an older kit project keeps its own Cut & fill: its surface and the grid it drapes
  const offKit = volumetric.subscribe((s, p) => {
    if (
      s.status !== p.status ||
      s.surface !== p.surface ||
      s.change !== p.change ||
      s.changeGrid !== p.changeGrid
    )
      draw();
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
    offPinned();
    offView();
    offShow();
    offCompare();
    offKit();
    offFly();
    offFrame();
    if (flyTimer !== null) window.clearTimeout(flyTimer);
    clear();
    publish(null, null);
    stage.scene.remove(group);
    stage.requestRender();
  };
}
