/**
 * The open pile's profile line in the 3D view and on the map (spec section 3, board 2): a dashed
 * line from A to B along the pile's long axis (or the line kept for it in `pileView`), an A and a B
 * handle at its ends and a ↻ handle at its centre. Dragging A or B moves that end; dragging ↻ turns
 * the line about the pile's centre. Every drag writes `pileView.setAxis`, so the Profile chart and
 * its linked hover follow at once.
 *
 * The line shows while a pile is open in the Volumes tab on its Profile (`stagePile`). The handles
 * are buttons over the view, so a drag on one never reaches the orbit or the map's pan; focused,
 * the arrow keys move an end 0.5 m or turn the line 5° (Shift: ten times that).
 *
 * A drag moves the line once a frame. While it lasts the 3D line drapes on a few points; on the
 * release it drapes in full again.
 */
import type { EngineStage } from '@aio/engine';
import { fromWgs84, toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { SitePoint, SurveyMeasurement } from '@aio/schema';
import { moveAxisEnd, pileAxis, rotateAxis, type PileAxis } from '@aio/survey';
import { t, type MessageKey } from '@aio/ui';
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
/** Draped samples along the line in 3D; fewer while a drag moves it. */
const SAMPLES = 24;
const DRAG_SAMPLES = 2;
/** What an arrow key moves an end by, and turns the line by (Shift: ten times). */
const NUDGE_M = 0.5;
const NUDGE_DEG = 5;

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

/**
 * The line after an arrow key on a handle: an end moves 0.5 m along east (left, right) or north
 * (up, down), ↻ turns 5° clockwise (right, down) or back (left, up); Shift does ten times that.
 * Null for any other key.
 */
export function axisNudge(
  axis: PileAxis,
  ring: readonly SitePoint[],
  handle: AxisHandle,
  key: string,
  shift: boolean,
): PileAxis | null {
  const k = shift ? 10 : 1;
  if (handle === 'turn') {
    const turn = TURN_KEYS[key];
    return turn === undefined ? null : rotateAxis(axis, ring, turn * NUDGE_DEG * k);
  }
  const step = MOVE_KEYS[key];
  if (!step) return null;
  const end = handle === 'a' ? axis.a : axis.b;
  const d = NUDGE_M * k;
  return moveAxisEnd(axis, handle, [end[0] + step[0] * d, end[1] + step[1] * d]);
}
const TURN_KEYS: Partial<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};
const MOVE_KEYS: Partial<Record<string, EN>> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

/** Move or turn the open pile's line from the keyboard; true when the key was taken. */
function nudgeOpen(handle: AxisHandle, e: KeyboardEvent): boolean {
  const open = stagePile();
  if (!open?.profile) return false;
  const next = axisNudge(open.axis, open.ring, handle, e.key, e.shiftKey);
  if (!next) return false;
  pileView.getState().setAxis(open.m.id, next);
  return true;
}

const HANDLE_LABEL: Record<AxisHandle, MessageKey> = {
  a: 'pile.axis.a',
  b: 'pile.axis.b',
  turn: 'pile.axis.turn',
};

/**
 * The A, B and ↻ handles over a view: buttons a pointer grabs and the keyboard moves (the arrow
 * keys, `axisNudge`); positions are set per frame.
 */
function handles(host: HTMLElement, onDown: (h: AxisHandle, e: PointerEvent) => void) {
  const root = document.createElement('div');
  root.className = 'pa-handles';
  root.dataset.surface = 'dark';
  const make = (h: AxisHandle, text: string) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pa-handle';
    el.dataset.handle = h;
    el.setAttribute('data-testid', `pile-axis-${h}`);
    el.setAttribute('aria-label', t(HANDLE_LABEL[h]));
    el.textContent = text;
    el.hidden = true;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onDown(h, e);
    });
    el.addEventListener('keydown', (e) => {
      // the arrows are the handle's, not the orbit's or the map's pan
      if (!nudgeOpen(h, e)) return;
      e.preventDefault();
      e.stopPropagation();
    });
    root.append(el);
    return el;
  };
  const els: Record<AxisHandle, HTMLButtonElement> = {
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
 * screen point turned into site E, N by the view) once a frame, the last move of the frame
 * winning; the release applies the move still waiting, ends it and tells `onEnd`.
 */
function dragInput(
  toSite: (x: number, y: number, h: AxisHandle) => EN | null,
  onEnd: () => void = () => undefined,
) {
  let off: (() => void) | null = null;
  const end = () => {
    if (!off) return;
    off();
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
    let pending: { x: number; y: number } | null = null;
    let raf = 0;
    /** The waiting move onto the line; false when nothing changed. */
    const apply = (): boolean => {
      const q = pending;
      pending = null;
      const p = q ? toSite(q.x, q.y, h) : null;
      if (!p) return false;
      const before = pileView.getState().axis;
      pileView.getState().setAxis(id, drag.move(p));
      return pileView.getState().axis !== before;
    };
    const move = (ev: PointerEvent) => {
      pending = { x: ev.clientX, y: ev.clientY };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply();
      });
    };
    const release = (ev: PointerEvent) => {
      const last = { x: ev.clientX, y: ev.clientY };
      end();
      // the last move lands (drawn as the ended drag's full line), else the line is drawn again
      pending = last;
      if (!apply()) onEnd();
    };
    const cancel = () => {
      end();
      onEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    off = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
    };
  };
  return { down, end, active: () => off !== null };
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

  // one line and one material, the geometry replaced as the line moves: a drag never builds a
  // new program
  const line = new Line2(
    new LineGeometry(),
    new LineMaterial({
      color: LINE_COLOUR,
      linewidth: 2,
      dashed: true,
      dashSize: 1,
      gapSize: 0.7,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  line.name = 'pile-axis-line';
  line.renderOrder = 49;
  line.frustumCulled = false;
  line.raycast = () => undefined;
  const sizeLine = () => {
    line.material.resolution.set(canvas.clientWidth, canvas.clientHeight);
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
    const open = stagePile();
    shown = open?.profile ? open.axis : null;
    if (open && shown) {
      const zs = open.ring.map((p) => p[2]).filter((z) => Number.isFinite(z));
      const mean = zs.length > 0 ? zs.reduce((s, z) => s + z, 0) / zs.length : 0;
      const ax = shown;
      // while a drag moves it (once a frame) the line drapes on a few points and the handles
      // keep the levels the drag started on; the release drapes it in full
      const dragging = input.active();
      const samples = dragging ? DRAG_SAMPLES : SAMPLES;
      const pts: number[] = [];
      const heights: number[] = [];
      for (let i = 0; i <= samples; i++) {
        const f = i / samples;
        const e = ax.a[0] + (ax.b[0] - ax.a[0]) * f;
        const n = ax.a[1] + (ax.b[1] - ax.a[1]) * f;
        const z = groundZ(e, n, mean);
        heights.push(z);
        pts.push(...frame.toLocal([e, n, z]));
      }
      if (!dragging)
        levels = {
          a: heights[0] ?? mean,
          b: heights.at(-1) ?? mean,
          turn: groundZ(ax.centre[0], ax.centre[1], mean),
        };
      const g = new LineGeometry();
      g.setPositions(pts);
      line.geometry.dispose();
      line.geometry = g;
      const dash = Math.max(0.2, ax.lengthM / 60);
      line.material.dashSize = dash;
      line.material.gapSize = dash * 0.7;
      line.computeLineDistances();
      if (line.parent !== group) group.add(line);
    } else if (line.parent === group) group.remove(line);
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
  const input = dragInput(toSite, rebuild);
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
    group.remove(line);
    line.geometry.dispose();
    line.material.dispose();
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
