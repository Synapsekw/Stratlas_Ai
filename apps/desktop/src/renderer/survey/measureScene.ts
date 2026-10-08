/**
 * Survey measurements in the views (M11 G3): the 3D site view (three.js lines and HTML labels;
 * picking through the stage's raycast, terrain clamping with a vertical ray) and the 2D map (a
 * GeoJSON source on the map on screen). Both convert one geometry model, site points (E, N, Z)
 * in the project CRS, with the manifest origin (`@aio/geo`, local frame x east, y up, z south).
 */
import type { EngineStage } from '@aio/engine';
import { fromWgs84, localToProject, projectToLocal, toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { ProjectManifest, SitePoint, SurveyMeasurement, Vec3 } from '@aio/schema';
import {
  findSnap,
  formatRow,
  hitMidpoint,
  hitVertex,
  isClosed,
  measurementReadout,
  measurementSnaps,
  effectiveUnits,
  type DrawEnv,
  type ScreenPt,
  type SnapProvider,
  type ToScreen,
} from '@aio/survey';
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Points,
  PointsMaterial,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { drawEvent, editEvent, measureStore, type MeasureState } from './measureStore';

export const MEASURE_COLOR = '#ffd166';
const DRAFT_COLOR = '#4cc9f0';
const SNAP_COLOR = '#ff5ccd';

/** Site to local and back for one project. */
export interface Frame {
  toLocal(p: SitePoint): Vec3;
  toSite(local: Vec3): SitePoint;
  epsg: number | null;
}

export function frameOf(manifest: Pick<ProjectManifest, 'crs' | 'origin'>): Frame {
  const o = manifest.origin;
  return {
    toLocal: (p) => projectToLocal(p, o),
    toSite: (l) => localToProject(l, o),
    epsg: 'epsg' in manifest.crs ? manifest.crs.epsg : null,
  };
}

/** The shapes a view draws, with the measurements' own colours. */
interface Shape {
  id: string;
  points: readonly SitePoint[];
  closed: boolean;
  color: string;
  selected: boolean;
  label: string | null;
  labelSize: number;
}

function shapesOf(s: MeasureState): Shape[] {
  const units = s.settings.units;
  const precision = s.settings.precision;
  return s.file.measurements.map((m) => {
    const selected = s.selected.includes(m.id);
    const points = s.editing && m.id === s.focus ? s.editing.points : m.points;
    const style = m.style;
    const only = style?.labelOnlyWhenSelected === true;
    return {
      id: m.id,
      points,
      closed: isClosed(m.family),
      color: style?.color ?? MEASURE_COLOR,
      selected,
      label:
        only && !selected
          ? null
          : labelOf({ ...m, points }, units, precision, style?.showPropertyName === true, s),
      labelSize: style?.labelSize ?? 12,
    };
  });
}

/** The label of a measurement: its name and its first readout row. */
function labelOf(
  m: SurveyMeasurement,
  site: MeasureState['settings']['units'],
  precision: MeasureState['settings']['precision'],
  showName: boolean,
  s: MeasureState,
): string {
  const tpl = [...(s.templates.project?.templates ?? []), ...s.templates.user.templates].find(
    (t) => t.id === m.template,
  );
  const row = measurementReadout(m, {}, tpl?.items).find((r) => r.value !== null);
  const value = row ? formatRow(row, effectiveUnits(site, m.units), precision) : '';
  const named = showName && row ? `${row.label}: ${value}` : value;
  return [m.label, named].filter(Boolean).join(' · ');
}

/** Snap targets: saved measurements (G6 adds designs, alignments and guides as providers). */
export function snapProviders(s: MeasureState): SnapProvider[] {
  return [
    measurementSnaps(
      s.file.measurements
        .filter((m) => !(s.editing && m.id === s.focus))
        .map((m) => ({ points: m.points, closed: isClosed(m.family) })),
    ),
  ];
}

// ---------------------------------------------------------------- 3D

/**
 * Terrain under (E, N) from the 3D stage: a vertical ray against the visible meshes, clouds and
 * terrain (the existing picking), then the ground plane.
 */
export function stageClamp(stage: EngineStage, frame: Frame) {
  return (e: number, n: number): number | null => {
    const l = frame.toLocal([e, n, 0]);
    const top = stage.camera.position.y + 10_000;
    const hit = stage.raycastRay(new Vector3(l[0], top, l[2]), new Vector3(0, -1, 0));
    return hit ? frame.toSite([hit.point.x, hit.point.y, hit.point.z])[2] : null;
  };
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/** Keys the drawing takes while a tool is drawing. */
const DRAW_KEYS = /^([0-9.\-'" ]|Backspace|Tab|Enter|Escape)$/;

/**
 * Draw the measurements in the 3D stage and drive the active tool and vertex editing there.
 * Returns the detach.
 */
export function attach3d(stage: EngineStage, frame: Frame): () => void {
  const group = new Group();
  group.name = 'aio-survey-measurements';
  group.renderOrder = 40;
  stage.scene.add(group);
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const labels = document.createElement('div');
  labels.className = 'sv-labels';
  labels.setAttribute('aria-hidden', 'true');
  host.appendChild(labels);
  const tmp = new Vector3();

  const toScreen: ToScreen = (p) => {
    const l = frame.toLocal(p);
    tmp.set(l[0], l[1], l[2]).project(stage.camera);
    if (tmp.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((tmp.x + 1) / 2) * r.width, y: r.top + ((1 - tmp.y) / 2) * r.height };
  };
  const clampZ = stageClamp(stage, frame);
  const env = (): DrawEnv => {
    const s = measureStore.getState();
    return {
      snap: (screen) => findSnap(screen, snapProviders(s), toScreen, s.snap),
      clampZ,
      distanceUnit: effectiveUnits(s.settings.units).distance,
    };
  };
  const pick = (e: { clientX: number; clientY: number }): SitePoint | null => {
    const r = canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    const hit = stage.raycast(ndc.x, ndc.y);
    return hit ? frame.toSite([hit.point.x, hit.point.y, hit.point.z]) : null;
  };

  // -------------------------------------------------- drawing objects
  const disposeGroup = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const o = c as Line | Points;
      o.geometry.dispose();
      (o.material as Material).dispose();
    }
  };
  const addLine = (pts: readonly SitePoint[], closed: boolean, color: string, width = 1) => {
    if (pts.length < 2) return;
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new Float32BufferAttribute(
        pts.flatMap((p) => frame.toLocal(p)),
        3,
      ),
    );
    const mat = new LineBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      linewidth: width,
    });
    const line = closed && pts.length > 2 ? new LineLoop(g, mat) : new Line(g, mat);
    line.renderOrder = 40;
    line.frustumCulled = false;
    line.raycast = () => undefined;
    group.add(line);
  };
  const addPoints = (pts: readonly SitePoint[], color: string, size = 7) => {
    if (pts.length === 0) return;
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new Float32BufferAttribute(
        pts.flatMap((p) => frame.toLocal(p)),
        3,
      ),
    );
    const mat = new PointsMaterial({
      color,
      size,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    const p = new Points(g, mat);
    p.renderOrder = 41;
    p.frustumCulled = false;
    p.raycast = () => undefined;
    group.add(p);
  };

  let shapes: Shape[] = [];
  const rebuild = () => {
    const s = measureStore.getState();
    disposeGroup();
    shapes = shapesOf(s);
    for (const sh of shapes) {
      addLine(sh.points, sh.closed, sh.selected ? '#ffffff' : sh.color);
      addPoints(sh.points, sh.color, sh.selected ? 8 : 5);
    }
    if (s.editing) {
      const m = s.file.measurements.find((x) => x.id === s.focus);
      const closed = m ? isClosed(m.family) : false;
      const mids: SitePoint[] = [];
      const n =
        closed && s.editing.points.length > 2
          ? s.editing.points.length
          : s.editing.points.length - 1;
      for (let i = 0; i < n; i++) {
        const a = s.editing.points[i];
        const b = s.editing.points[(i + 1) % s.editing.points.length];
        if (a && b) mids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      }
      addPoints(s.editing.points, '#ffffff', 10);
      addPoints(mids, DRAFT_COLOR, 6);
    }
    const d = s.draw;
    if (d) {
      const pts = d.cursor && d.points.length > 0 ? [...d.points, d.cursor] : d.points;
      addLine(pts, d.family === 'polygon', DRAFT_COLOR);
      addPoints(d.points, DRAFT_COLOR, 7);
      if (d.cursor) addPoints([d.cursor], d.snap ? SNAP_COLOR : DRAFT_COLOR, d.snap ? 12 : 6);
    }
    placeLabels();
    stage.requestRender();
  };

  // -------------------------------------------------- labels
  const placeLabels = () => {
    const want = shapes.filter((s) => s.label);
    while (labels.children.length > want.length) labels.lastChild?.remove();
    while (labels.children.length < want.length) {
      const el = document.createElement('span');
      el.className = 'sv-label';
      labels.appendChild(el);
    }
    const r = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    want.forEach((sh, i) => {
      const el = labels.children[i] as HTMLElement;
      const anchor = anchorOf(sh.points, sh.closed);
      const p = anchor ? toScreen(anchor) : null;
      if (el.textContent !== sh.label) el.textContent = sh.label;
      el.dataset.id = sh.id;
      el.style.fontSize = `${String(sh.labelSize)}px`;
      el.classList.toggle('sel', sh.selected);
      if (!p || p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.transform = `translate(${String(Math.round(p.x - hr.left))}px, ${String(Math.round(p.y - hr.top))}px)`;
    });
  };
  const offFrame = stage.onFrame(placeLabels);

  // -------------------------------------------------- input
  let last: { raw: SitePoint; screen: ScreenPt; shift: boolean } | null = null;
  let lastClick: { x: number; y: number; t: number } | null = null;
  let dragging = false;

  const onMove = (e: PointerEvent) => {
    const s = measureStore.getState();
    if (s.editing && dragging) {
      const p = pick(e);
      if (p) editEvent({ type: 'drag', p });
      return;
    }
    if (!s.draw) return;
    const raw = pick(e);
    if (!raw) return;
    last = { raw, screen: { x: e.clientX, y: e.clientY }, shift: e.shiftKey };
    drawEvent({ type: 'move', ...last }, env());
  };
  const onDown = (e: PointerEvent) => {
    const s = measureStore.getState();
    if (!s.editing || e.button !== 0) return;
    const m = s.file.measurements.find((x) => x.id === s.focus);
    if (!m) return;
    const at = { x: e.clientX, y: e.clientY };
    const v = hitVertex(s.editing.points, at, toScreen, 9);
    if (v !== null) {
      if (e.altKey) {
        editEvent({ type: 'delete', vertex: v });
      } else {
        editEvent({ type: 'down', vertex: v });
        dragging = true;
        stage.controls.enabled = false;
      }
      e.stopImmediatePropagation();
      return;
    }
    const seg = hitMidpoint(s.editing.points, isClosed(m.family), at, toScreen, 9);
    if (seg !== null) {
      editEvent({ type: 'down-mid', seg });
      dragging = true;
      stage.controls.enabled = false;
      e.stopImmediatePropagation();
    }
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    stage.controls.enabled = true;
    editEvent({ type: 'up' });
  };
  const offClaim = stage.claimClicks((e) => {
    const s = measureStore.getState();
    if (s.editing) return true;
    if (!s.draw) return false;
    const t = performance.now();
    const repeat =
      lastClick !== null &&
      Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) <= 4 &&
      t - lastClick.t <= 450;
    lastClick = { x: e.clientX, y: e.clientY, t };
    if (repeat) return true;
    const raw = pick(e);
    if (raw)
      drawEvent(
        { type: 'click', raw, screen: { x: e.clientX, y: e.clientY }, shift: e.shiftKey },
        env(),
      );
    return true;
  });
  const onDbl = (e: MouseEvent) => {
    if (!measureStore.getState().draw) return;
    e.preventDefault();
    drawEvent({ type: 'finish' }, env());
  };
  const onKey = (e: KeyboardEvent) => {
    const s = measureStore.getState();
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (s.editing && e.key === 'Escape') {
      editEvent({ type: 'escape' });
      measureStore.setState({ editing: null });
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!s.draw) return;
    if (e.key === 'Shift' && last) {
      drawEvent({ type: 'move', ...last, shift: true }, env());
      return;
    }
    if (!DRAW_KEYS.test(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    drawEvent({ type: 'key', key: e.key }, env());
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Shift' && last && measureStore.getState().draw)
      drawEvent({ type: 'move', ...last, shift: false }, env());
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown, { capture: true });
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('dblclick', onDbl);
  window.addEventListener('keydown', onKey, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });
  const offStore = measureStore.subscribe((s, prev) => {
    if (
      s.file !== prev.file ||
      s.draw !== prev.draw ||
      s.selected !== prev.selected ||
      s.editing !== prev.editing ||
      s.settings !== prev.settings ||
      s.templates !== prev.templates
    )
      rebuild();
    const drawing = s.draw !== null || s.editing !== null;
    canvas.style.cursor = s.draw ? 'crosshair' : '';
    if (drawing && stage.tool !== 'select') stage.setTool('select');
  });
  rebuild();

  return () => {
    offStore();
    offFrame();
    offClaim();
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerdown', onDown, { capture: true });
    window.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('dblclick', onDbl);
    window.removeEventListener('keydown', onKey, { capture: true });
    window.removeEventListener('keyup', onKeyUp, { capture: true });
    if (dragging) stage.controls.enabled = true;
    disposeGroup();
    stage.scene.remove(group);
    labels.remove();
    canvas.style.cursor = '';
    stage.requestRender();
  };
}

/** Where a shape's label sits: a line's last vertex, a polygon's centroid, the point. */
function anchorOf(points: readonly SitePoint[], closed: boolean): SitePoint | null {
  if (points.length === 0) return null;
  if (!closed) return points[points.length - 1] ?? null;
  const n = points.length;
  const c = points.reduce<[number, number, number]>(
    (a, p) => [a[0] + p[0] / n, a[1] + p[1] / n, a[2] + p[2] / n],
    [0, 0, 0],
  );
  return c;
}

/** A local-frame point to centre the camera on a measurement. */
export function focusPoint(m: SurveyMeasurement, frame: Frame): { p: Vec3; distance: number } {
  const xs = m.points.map((p) => p[0]);
  const ys = m.points.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 5);
  const c = anchorOf(m.points, true) ?? m.points[0] ?? [0, 0, 0];
  return { p: frame.toLocal(c), distance: span * 2 };
}

// ---------------------------------------------------------------- 2D map

/** The MapLibre mouse event fields the drawing reads. */
interface MapMouse {
  lngLat: { lng: number; lat: number };
  point: { x: number; y: number };
  originalEvent: MouseEvent;
  preventDefault(): void;
}

const SRC = 'aio-survey';
const LAYERS = ['aio-survey-fill', 'aio-survey-line', 'aio-survey-pt'] as const;

/** Draw the measurements on the map and drive the active tool there. Returns the detach. */
export function attachMap(
  ctl: MapController,
  frame: Frame,
  clampZ: (e: number, n: number) => number | null,
): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const toLngLat = (p: SitePoint): [number, number] => {
    const ll = toWgs84([p[0], p[1], p[2]], epsg);
    return [ll[0], ll[1]];
  };
  const canvas = map.getCanvas();
  const toScreen: ToScreen = (p) => {
    const px = map.project(toLngLat(p));
    const r = canvas.getBoundingClientRect();
    return { x: r.left + px.x, y: r.top + px.y };
  };
  const env = (): DrawEnv => {
    const s = measureStore.getState();
    return {
      snap: (screen) => findSnap(screen, snapProviders(s), toScreen, s.snap),
      clampZ,
      distanceUnit: effectiveUnits(s.settings.units).distance,
    };
  };
  const site = (lng: number, lat: number): SitePoint => {
    const [e, n] = fromWgs84([lng, lat, 0], epsg);
    return [e, n, clampZ(e, n) ?? 0];
  };

  const data = () => {
    const s = measureStore.getState();
    const features: unknown[] = [];
    for (const sh of shapesOf(s)) {
      const coords = sh.points.map(toLngLat);
      const props = { color: sh.selected ? '#ffffff' : sh.color, id: sh.id };
      if (coords.length === 1)
        features.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'Point', coordinates: coords[0] },
        });
      else if (sh.closed && coords.length > 2)
        features.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] },
        });
      else
        features.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'LineString', coordinates: coords },
        });
    }
    const d = s.draw;
    if (d) {
      const pts = d.cursor && d.points.length > 0 ? [...d.points, d.cursor] : d.points;
      const coords = pts.map(toLngLat);
      const props = { color: DRAFT_COLOR, id: 'draft' };
      if (coords.length > 1)
        features.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'LineString', coordinates: coords },
        });
      for (const c of coords)
        features.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'Point', coordinates: c },
        });
    }
    return { type: 'FeatureCollection', features };
  };
  const draw = () => {
    try {
      if (!map.isStyleLoaded()) return;
      const src = map.getSource(SRC) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(data());
      else map.addSource(SRC, { type: 'geojson', data: data() as never });
      if (!map.getLayer(LAYERS[0]))
        map.addLayer({
          id: LAYERS[0],
          type: 'fill',
          source: SRC,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 },
        });
      if (!map.getLayer(LAYERS[1]))
        map.addLayer({
          id: LAYERS[1],
          type: 'line',
          source: SRC,
          filter: ['!=', ['geometry-type'], 'Point'],
          paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
        });
      if (!map.getLayer(LAYERS[2]))
        map.addLayer({
          id: LAYERS[2],
          type: 'circle',
          source: SRC,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 4,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#000000',
            'circle-stroke-width': 1,
          },
        });
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  };

  let last: { raw: SitePoint; screen: ScreenPt; shift: boolean } | null = null;
  let lastClick: { x: number; y: number; t: number } | null = null;
  const screenOf = (e: MapMouse): ScreenPt => {
    const r = canvas.getBoundingClientRect();
    return { x: r.left + e.point.x, y: r.top + e.point.y };
  };
  const onMove = (e: MapMouse) => {
    if (!measureStore.getState().draw) return;
    last = {
      raw: site(e.lngLat.lng, e.lngLat.lat),
      screen: screenOf(e),
      shift: e.originalEvent.shiftKey,
    };
    drawEvent({ type: 'move', ...last }, env());
  };
  const onClick = (e: MapMouse) => {
    if (!measureStore.getState().draw) return;
    const t = performance.now();
    const sc = screenOf(e);
    const repeat =
      lastClick !== null &&
      Math.hypot(sc.x - lastClick.x, sc.y - lastClick.y) <= 4 &&
      t - lastClick.t <= 450;
    lastClick = { ...sc, t };
    if (repeat) return;
    drawEvent(
      {
        type: 'click',
        raw: site(e.lngLat.lng, e.lngLat.lat),
        screen: sc,
        shift: e.originalEvent.shiftKey,
      },
      env(),
    );
  };
  const onDbl = (e: MapMouse) => {
    if (!measureStore.getState().draw) return;
    e.preventDefault();
    drawEvent({ type: 'finish' }, env());
  };
  const onStyle = () => {
    draw();
  };
  map.on('mousemove', onMove as never);
  map.on('click', onClick as never);
  map.on('dblclick', onDbl as never);
  map.on('styledata', onStyle);
  const offStore = measureStore.subscribe((s, prev) => {
    if (
      s.file !== prev.file ||
      s.draw !== prev.draw ||
      s.selected !== prev.selected ||
      s.editing !== prev.editing
    )
      draw();
    canvas.style.cursor = s.draw ? 'crosshair' : '';
  });
  draw();
  return () => {
    offStore();
    map.off('mousemove', onMove as never);
    map.off('click', onClick as never);
    map.off('dblclick', onDbl as never);
    map.off('styledata', onStyle);
    canvas.style.cursor = '';
    try {
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {
      // the map is going away
    }
  };
}
