/**
 * The open pile's profile line in the 3D view and on the map (spec section 3, board 2): a dashed
 * line from A to B along the pile's long axis (or the line kept for it in `pileView`), an A and a B
 * handle at its ends and a ↻ handle at its centre. Dragging A or B moves that end; dragging ↻ turns
 * the line about the pile's centre. Every drag writes `pileView.setAxis`, so the Profile chart and
 * its linked hover follow at once.
 *
 * The line shows while a pile is open in the Volumes tab on its Profile (`stagePile`). The handles
 * are elements over the view, so a drag on one never reaches the orbit or the map's pan.
 */
import type { EngineStage } from '@aio/engine';
import { fromWgs84, toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { SitePoint, SurveyMeasurement } from '@aio/schema';
import { moveAxisEnd, pileAxis, rotateAxis, type PileAxis } from '@aio/survey';
import { workspace } from '@aio/workspace';
import { Group, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { workbench } from '../../workspace/workbench/workbenchStore';
import { drawnPoints } from '../measureDates';
import type { Frame } from '../measureScene';
import { measureStore } from '../measureStore';
import { isPile } from './openPile';
import { pileView } from './pileView';
import './pile.css';

type EN = readonly [number, number];
export type AxisHandle = 'a' | 'b' | 'turn';

const DEG = Math.PI / 180;
/** The line's colour in WebGL and on the map (a plain colour: the views take no tokens). */
const LINE_COLOUR = '#ffffff';
/** Draped samples along the line in 3D. */
const SAMPLES = 24;

/** The pile open on the stage: its measurement, outline, current line and whether it shows. */
export interface StagePile {
  m: SurveyMeasurement;
  ring: SitePoint[];
  axis: PileAxis;
  /** The Profile tab is open: the line and its handles show in the views. */
  profile: boolean;
}

/** The focused pile while the Volumes tab is in front, else null. */
export function stagePile(): StagePile | null {
  const s = measureStore.getState();
  if (s.focus === null || workbench.getState().front !== 'volumes') return null;
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!m || !isPile(m)) return null;
  const ring = drawnPoints(m, workspace.getState().project?.manifest ?? null);
  if (ring.length < 3) return null;
  const v = pileView.getState();
  return { m, ring, axis: v.axis.get(m.id) ?? pileAxis(ring), profile: v.tab === 'profile' };
}

/** Degrees clockwise from east of `p` about `c`. */
const bearingCw = (c: EN, p: EN): number => -Math.atan2(p[1] - c[1], p[0] - c[0]) / DEG;

/**
 * One drag of a handle: `move` gives the line with the handle at the pointer. An end follows the
 * pointer, the other end stays. ↻ turns the line by the angle the pointer has swept about the
 * centre since it first stood `minR` metres or more from it (it is grabbed at the centre, where
 * no angle is defined), the ends refitted to the outline.
 */
export function axisDrag(
  start: PileAxis,
  ring: readonly SitePoint[],
  handle: AxisHandle,
  minR = 0,
): { move(to: EN): PileAxis } {
  let ref: number | null = null;
  return {
    move(to) {
      if (handle !== 'turn') return moveAxisEnd(start, handle, to);
      if (Math.hypot(to[0] - start.centre[0], to[1] - start.centre[1]) < Math.max(minR, 1e-9))
        return start;
      const now = bearingCw(start.centre, to);
      if (ref === null) {
        ref = now;
        return start;
      }
      return rotateAxis(start, ring, now - ref);
    },
  };
}

/** The A, B and ↻ handles over a view, each a grab target; positions are set per frame. */
function handles(host: HTMLElement, onDown: (h: AxisHandle, e: PointerEvent) => void) {
  const root = document.createElement('div');
  root.className = 'pa-handles';
  root.dataset.surface = 'dark';
  root.setAttribute('aria-hidden', 'true');
  const make = (h: AxisHandle, text: string) => {
    const el = document.createElement('span');
    el.className = 'pa-handle';
    el.dataset.handle = h;
    el.setAttribute('data-testid', `pile-axis-${h}`);
    el.textContent = text;
    el.hidden = true;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onDown(h, e);
    });
    root.append(el);
    return el;
  };
  const els: Record<AxisHandle, HTMLSpanElement> = {
    a: make('a', 'A'),
    b: make('b', 'B'),
    turn: make('turn', '↻'),
  };
  host.appendChild(root);
  return {
    root,
    place(at: Record<AxisHandle, readonly [number, number] | null> | null) {
      for (const h of ['a', 'b', 'turn'] as const) {
        const el = els[h];
        const p = at?.[h] ?? null;
        el.hidden = p === null;
        if (p)
          el.style.transform = `translate(${String(Math.round(p[0]))}px, ${String(Math.round(p[1]))}px)`;
      }
    },
  };
}

/**
 * The drag both views share: a handle pressed starts it, the window's pointer moves carry it (a
 * screen point turned into site E, N by the view), the release ends it.
 */
function dragInput(toSite: (x: number, y: number, h: AxisHandle) => EN | null) {
  let off: (() => void) | null = null;
  const end = () => {
    off?.();
    off = null;
  };
  const down = (h: AxisHandle, e: PointerEvent) => {
    end();
    const open = stagePile();
    if (!open?.profile) return;
    const id = open.m.id;
    const drag = axisDrag(open.axis, open.ring, h, open.axis.lengthM * 0.05);
    const at = toSite(e.clientX, e.clientY, h);
    if (at) drag.move(at);
    const move = (ev: PointerEvent) => {
      const p = toSite(ev.clientX, ev.clientY, h);
      if (p) pileView.getState().setAxis(id, drag.move(p));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    off = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  };
  return { down, end };
}

/** Run `fn` when the open pile or its line may have changed. */
function onPileChange(fn: () => void): () => void {
  const offs = [
    measureStore.subscribe((s, p) => {
      if (s.focus !== p.focus || s.file !== p.file) fn();
    }),
    pileView.subscribe((s, p) => {
      if (s.axis !== p.axis || s.tab !== p.tab) fn();
    }),
    workbench.subscribe((s, p) => {
      if (s.front !== p.front) fn();
    }),
    workspace.subscribe((s, p) => {
      if (s.project !== p.project) fn();
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

// ---------------------------------------------------------------- 3D

/** Draw the open pile's profile line in a 3D view with its handles. Returns the detach. */
export function attachPileAxis3d(stage: EngineStage, frame: Frame): () => void {
  const group = new Group();
  group.name = 'aio-pile-axis';
  group.renderOrder = 49;
  group.raycast = () => undefined;
  stage.scene.add(group);
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const tmp = new Vector3();
  const ray = new Raycaster();

  /** The ground under a point, else the outline's mean height. */
  const groundZ = (e: number, n: number, fallback: number): number => {
    const l = frame.toLocal([e, n, 0]);
    const top = stage.camera.position.y + 10_000;
    const hit = stage.raycastRay(new Vector3(l[0], top, l[2]), new Vector3(0, -1, 0));
    return hit ? frame.toSite([hit.point.x, hit.point.y, hit.point.z])[2] : fallback;
  };
  const toHost = (e: number, n: number, z: number): [number, number] | null => {
    const l = frame.toLocal([e, n, z]);
    tmp.set(l[0], l[1], l[2]).project(stage.camera);
    if (tmp.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    return [
      r.left - hr.left + ((tmp.x + 1) / 2) * r.width,
      r.top - hr.top + ((1 - tmp.y) / 2) * r.height,
    ];
  };

  /** The heights the handles stand at, kept so a drag works on the plane it started on. */
  let levels: Record<AxisHandle, number> = { a: 0, b: 0, turn: 0 };
  let shown: PileAxis | null = null;

  const clear = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const o = c as Line2;
      o.geometry.dispose();
      o.material.dispose();
    }
  };
  const sizeLine = () => {
    const line = group.getObjectByName('pile-axis-line') as Line2 | undefined;
    line?.material.resolution.set(canvas.clientWidth, canvas.clientHeight);
  };
  const place = () => {
    const a = shown;
    pads.place(
      a
        ? {
            a: toHost(a.a[0], a.a[1], levels.a),
            b: toHost(a.b[0], a.b[1], levels.b),
            turn: toHost(a.centre[0], a.centre[1], levels.turn),
          }
        : null,
    );
  };
  const rebuild = () => {
    clear();
    const open = stagePile();
    shown = open?.profile ? open.axis : null;
    if (open && shown) {
      const zs = open.ring.map((p) => p[2]).filter((z) => Number.isFinite(z));
      const mean = zs.length > 0 ? zs.reduce((s, z) => s + z, 0) / zs.length : 0;
      const ax = shown;
      const pts: number[] = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const f = i / SAMPLES;
        const e = ax.a[0] + (ax.b[0] - ax.a[0]) * f;
        const n = ax.a[1] + (ax.b[1] - ax.a[1]) * f;
        pts.push(...frame.toLocal([e, n, groundZ(e, n, mean)]));
      }
      levels = {
        a: groundZ(ax.a[0], ax.a[1], mean),
        b: groundZ(ax.b[0], ax.b[1], mean),
        turn: groundZ(ax.centre[0], ax.centre[1], mean),
      };
      const g = new LineGeometry();
      g.setPositions(pts);
      const dash = Math.max(0.2, ax.lengthM / 60);
      const mat = new LineMaterial({
        color: LINE_COLOUR,
        linewidth: 2,
        dashed: true,
        dashSize: dash,
        gapSize: dash * 0.7,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      const line = new Line2(g, mat);
      line.computeLineDistances();
      line.name = 'pile-axis-line';
      line.renderOrder = 49;
      line.frustumCulled = false;
      line.raycast = () => undefined;
      group.add(line);
    }
    sizeLine();
    place();
    stage.requestRender();
  };

  /** Client pixels to site E, N on the level the handle stands at. */
  const toSite = (x: number, y: number, h: AxisHandle): EN | null => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const ndc = new Vector2(((x - r.left) / r.width) * 2 - 1, -(((y - r.top) / r.height) * 2 - 1));
    ray.setFromCamera(ndc, stage.camera);
    const level = frame.toLocal([0, 0, levels[h]])[1];
    const hit = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -level), new Vector3());
    if (!hit) return null;
    const s = frame.toSite([hit.x, hit.y, hit.z]);
    return [s[0], s[1]];
  };
  const input = dragInput(toSite);
  const pads = handles(host, input.down);

  const offFrame = stage.onFrame(() => {
    sizeLine();
    place();
  });
  const offStores = onPileChange(rebuild);
  rebuild();

  return () => {
    offStores();
    offFrame();
    input.end();
    clear();
    stage.scene.remove(group);
    pads.root.remove();
    stage.requestRender();
  };
}

// ---------------------------------------------------------------- map

const SRC = 'aio-pile-axis';
export const PILE_AXIS_LAYER = 'aio-pile-axis-line';

/** Draw the open pile's profile line on a map with its handles. Returns the detach. */
export function attachPileAxisMap(ctl: MapController, frame: Frame): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const canvas = map.getCanvas();
  const container = map.getContainer();
  const lngLat = (e: number, n: number): [number, number] => {
    const ll = toWgs84([e, n, 0], epsg);
    return [ll[0], ll[1]];
  };
  const toHost = (e: number, n: number): [number, number] => {
    const px = map.project(lngLat(e, n));
    const r = canvas.getBoundingClientRect();
    const hr = container.getBoundingClientRect();
    return [r.left - hr.left + px.x, r.top - hr.top + px.y];
  };
  const toSite = (x: number, y: number): EN | null => {
    const r = canvas.getBoundingClientRect();
    const ll = map.unproject([x - r.left, y - r.top]);
    const p = fromWgs84([ll.lng, ll.lat, 0], epsg);
    return [p[0], p[1]];
  };

  let shown: PileAxis | null = null;
  const data = () => ({
    type: 'FeatureCollection',
    features: shown
      ? [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [lngLat(shown.a[0], shown.a[1]), lngLat(shown.b[0], shown.b[1])],
            },
          },
        ]
      : [],
  });
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
      if (!map.getLayer(PILE_AXIS_LAYER))
        map.addLayer({
          id: PILE_AXIS_LAYER,
          type: 'line',
          source: SRC,
          layout: { 'line-cap': 'butt' },
          paint: { 'line-color': LINE_COLOUR, 'line-width': 2, 'line-dasharray': [3, 2] },
        });
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  };
  const place = () => {
    const a = shown;
    pads.place(
      a
        ? {
            a: toHost(a.a[0], a.a[1]),
            b: toHost(a.b[0], a.b[1]),
            turn: toHost(a.centre[0], a.centre[1]),
          }
        : null,
    );
  };
  const rebuild = () => {
    const open = stagePile();
    shown = open?.profile ? open.axis : null;
    draw();
    place();
  };
  const input = dragInput((x, y) => toSite(x, y));
  const pads = handles(container, input.down);
  const onRender = () => {
    place();
  };
  const onStyle = () => {
    draw();
  };
  map.on('move', onRender);
  map.on('styledata', onStyle);
  const offStores = onPileChange(rebuild);
  rebuild();

  return () => {
    offStores();
    input.end();
    map.off('move', onRender);
    map.off('styledata', onStyle);
    map.off('idle', whenIdle);
    pads.root.remove();
    try {
      if (map.getLayer(PILE_AXIS_LAYER)) map.removeLayer(PILE_AXIS_LAYER);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {
      // the map is going away
    }
  };
}
