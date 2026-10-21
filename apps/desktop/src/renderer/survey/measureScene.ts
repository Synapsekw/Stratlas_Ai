/**
 * Survey measurements in the views (M11 G3): the 3D site view (three.js lines and HTML labels;
 * picking through the stage's raycast, terrain clamping with a vertical ray) and the 2D map (a
 * GeoJSON source on the map on screen). Both convert one geometry model, site points (E, N, Z)
 * in the project CRS, with the manifest origin (`@aio/geo`, local frame x east, y up, z south).
 */
import type { EngineStage } from '@aio/engine';
import { fromWgs84, localToProject, projectToLocal, toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type {
  ProjectManifest,
  SitePoint,
  SurveyMeasurement,
  SurveySettings,
  SurveyTemplate,
  Vec3,
} from '@aio/schema';
import {
  findSnap,
  hitMidpoint,
  hitVertex,
  isClosed,
  measurementSnaps,
  primaryRow,
  effectiveUnits,
  antennaAzimuth,
  isTelecomTool,
  type DrawEnv,
  type ScreenPt,
  type SnapProvider,
  type ToScreen,
} from '@aio/survey';
import { t } from '@aio/ui';
import { workspace, type Workspace } from '@aio/workspace';
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  DoubleSide,
  Points,
  PointsMaterial,
  ShapeUtils,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { StoreApi } from 'zustand/vanilla';
import { invalidPicks, primaryText, rowText, templateItems } from './card/cardModel';
import {
  DEFAULT_BORDER_WIDTH,
  DEFAULT_FILL_OPACITY,
  DEFAULT_MEASURE_COLOUR,
} from './measureColours';
import { drawnPoints, measurementsOn as drawn, type DatesOnScreen } from './measureDates';
import {
  drawEvent,
  editEvent,
  knownTemplates,
  measureStore,
  type MeasureState,
} from './measureStore';
import { mapPickLayer, type VertexPick } from './measureSource';

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
  /** A polygon: drawn with a translucent fill (an azimuth face is closed but not filled). */
  filled: boolean;
  color: string;
  /** The stored style as saved; each view puts in its own default (`measureColours`). */
  fill: string | undefined;
  fillOpacity: number | undefined;
  borderWidth: number | undefined;
  selected: boolean;
  label: string | null;
  labelSize: number;
  tool: SurveyMeasurement['tool'];
}

/** How one view draws the measurements when it is not the only view (a split). */
export interface MeasureViewOptions {
  /**
   * Draw only: the saved measurements, their labels and a drawing in progress, with no pointer or
   * keyboard input and no vertex handles (the second 3D view or map of a split).
   */
  display?: boolean;
  /**
   * The workspace as this view sees it (a pane that shows one survey date): its survey dates
   * decide which measurements it draws. Defaults to the workspace itself.
   */
  dates?: StoreApi<Workspace>;
}

/** Changes when a layer switch puts a survey's measurements on or off screen. */
const drawnKey = (s: MeasureState, ws: DatesOnScreen): string =>
  drawn(s, ws)
    .map((m) => m.id)
    .join(' ');

/** Redraw when the layer switches (or the view's date) put measurements on or off screen. */
function onDatesChange(dates: StoreApi<Workspace>, redraw: () => void): () => void {
  return dates.subscribe((ws, prev) => {
    if (ws.hidden === prev.hidden && ws.dates === prev.dates) return;
    const s = measureStore.getState();
    if (drawnKey(s, ws) !== drawnKey(s, prev)) redraw();
  });
}

/**
 * The shapes a view draws. A survey-scoped measurement is drawn through its date's shift; the
 * one being edited already holds drawn points (`startEditing`).
 */
export function shapesOf(
  s: MeasureState,
  ws: DatesOnScreen,
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'> | null,
  north: 'project north' | 'grid north',
): Shape[] {
  const templates = knownTemplates(s);
  return drawn(s, ws).map((m) => {
    const selected = s.selected.includes(m.id);
    const live = s.editing && m.id === s.focus ? s.editing.points : null;
    // drawn points, and the label reads them out: positions are where the person sees them
    const points = live ?? drawnPoints(m, manifest);
    const style = m.style;
    const only = style?.labelOnlyWhenSelected === true;
    return {
      id: m.id,
      tool: m.tool,
      points,
      closed: m.tool === 'azimuth' || isClosed(m.family),
      filled: isClosed(m.family),
      color: style?.color ?? DEFAULT_MEASURE_COLOUR,
      fill: style?.fill,
      fillOpacity: style?.fillOpacity,
      borderWidth: style?.borderWidth,
      selected,
      label: only && !selected ? null : labelText({ ...m, points }, s.settings, templates, north),
      labelSize: style?.labelSize ?? 12,
    };
  });
}

/**
 * The label of a measurement in the 3D view and on the map: its name and its primary value, the
 * one the tree and the card show (`primaryText`). With "show property name" the value is named.
 */
export function labelText(
  m: SurveyMeasurement,
  settings: SurveySettings,
  templates: readonly SurveyTemplate[],
  north: 'project north' | 'grid north' = 'project north',
): string {
  if (isTelecomTool(m.tool)) {
    if (invalidPicks(m))
      return [m.label, t('mcard.label.adjust', { state: t('tree.measure.invalid') })].join(' · ');
    const value = primaryText(m, { settings, templates });
    const said = !value
      ? ''
      : m.tool === 'azimuth'
        ? t(north === 'grid north' ? 'mcard.label.gridNorth' : 'mcard.label.projectNorth', {
            value,
          })
        : m.tool === 'antenna-tilt'
          ? t('mcard.label.fromVertical', { value })
          : value;
    return [m.label, said].filter(Boolean).join(' · ');
  }
  const row =
    m.style?.showPropertyName === true ? primaryRow(m, {}, templateItems(m, templates)) : null;
  const named = row
    ? `${row.label}: ${rowText(row, m, settings)}`
    : primaryText(m, { settings, templates });
  return [m.label, named].filter(Boolean).join(' · ');
}

/** The open project's dates and layers, which decide how far a date's measurements are shifted. */
const openManifest = () => workspace.getState().project?.manifest ?? null;

/** Snap targets: saved measurements (G6 adds designs, alignments and guides as providers). */
export function snapProviders(
  s: MeasureState,
  ws: DatesOnScreen = workspace.getState(),
): SnapProvider[] {
  const manifest = openManifest();
  return [
    measurementSnaps(
      drawn(s, ws)
        .filter((m) => !(s.editing && m.id === s.focus))
        .map((m) => ({ points: drawnPoints(m, manifest), closed: isClosed(m.family) })),
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

/** Flat reference images and navigation planes carry no measured surface height. */
function isReferenceSurface(object: Object3D): boolean {
  let node: Object3D | null = object;
  while (node) {
    if (
      node.name === 'env:ground' ||
      node.userData.aioGround === true ||
      node.userData.aioRaster === true
    )
      return true;
    node = node.parent;
  }
  return false;
}

/**
 * What a 3D hit sits on: the layer of the nearest ancestor that names one (`aioLayer`, else the
 * mesh and cloud adapters' `layerId`), and `ground` for a flat reference surface (a raster plate
 * or the ground plane), `model` for measured geometry.
 */
export function hitPick(object: Object3D | null): VertexPick {
  if (!object) return { layer: null, on: 'ground' };
  let layer: string | null = null;
  for (let node: Object3D | null = object; node && layer === null; node = node.parent) {
    const id: unknown = node.userData.aioLayer ?? node.userData.layerId;
    if (typeof id === 'string') layer = id;
  }
  return { layer, on: isReferenceSurface(object) ? 'ground' : 'model' };
}

/**
 * Draw the measurements in the 3D stage and drive the active tool and vertex editing there.
 * Returns the detach. With `opts.display` the view draws only (see `MeasureViewOptions`).
 */
export function attach3d(
  stage: EngineStage,
  frame: Frame,
  opts: MeasureViewOptions = {},
): () => void {
  const dates = opts.dates ?? workspace;
  const display = opts.display === true;
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
  const endInput = () => {
    // Clear all input together so the store subscriber cannot reselect a tool while editing.
    measureStore.setState({ tool: null, draw: null, editing: null });
  };

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
      view: '3d',
      snap: (screen) => findSnap(screen, snapProviders(s, dates.getState()), toScreen, s.snap),
      clampZ,
      distanceUnit: effectiveUnits(s.settings.units).distance,
    };
  };
  const pick = (e: {
    clientX: number;
    clientY: number;
  }): { p: SitePoint; at: VertexPick } | null => {
    const r = canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    const hit = stage.raycast(ndc.x, ndc.y);
    const s = measureStore.getState();
    const tool = s.tool?.tool ?? s.file.measurements.find((m) => m.id === s.focus)?.tool;
    if (tool && isTelecomTool(tool) && (!hit || isReferenceSurface(hit.object))) return null;
    return hit
      ? { p: frame.toSite([hit.point.x, hit.point.y, hit.point.z]), at: hitPick(hit.object) }
      : null;
  };

  // -------------------------------------------------- drawing objects
  const disposeGroup = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const o = c as Line | Points | Mesh;
      o.geometry.dispose();
      (o.material as Material).dispose();
    }
  };
  /**
   * Fat lines take their width in CSS pixels: they need the canvas size they are drawn at. Set
   * after each rebuild (new materials) and otherwise only when the canvas size changes.
   */
  let sized = '';
  const sizeFatLines = (force = false) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const key = `${String(w)}x${String(h)}`;
    if (!force && key === sized) return;
    sized = key;
    for (const c of group.children) {
      const mat = (c as Partial<Mesh>).material;
      if (mat instanceof LineMaterial) mat.resolution.set(w, h);
    }
  };
  const addLine = (
    pts: readonly SitePoint[],
    closed: boolean,
    color: string,
    name = '',
    width = 1,
  ) => {
    if (pts.length < 2) return;
    if (width > 1) {
      // a border wider than one pixel: WebGL draws basic lines one pixel wide whatever is asked
      const first = pts[0];
      const ring = closed && pts.length > 2 && first ? [...pts, first] : pts;
      const g = new LineGeometry();
      g.setPositions(ring.flatMap((p) => frame.toLocal(p)));
      const mat = new LineMaterial({
        color,
        linewidth: width,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      const fat = new Line2(g, mat);
      fat.name = name;
      fat.renderOrder = 40;
      fat.frustumCulled = false;
      fat.raycast = () => undefined;
      group.add(fat);
      return;
    }
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
      linewidth: 1,
    });
    const line = closed && pts.length > 2 ? new LineLoop(g, mat) : new Line(g, mat);
    line.name = name;
    line.renderOrder = 40;
    line.frustumCulled = false;
    line.raycast = () => undefined;
    group.add(line);
  };
  /** A polygon's translucent fill, triangulated in plan and kept at its vertices' heights. */
  const addFill = (pts: readonly SitePoint[], color: string, opacity: number, name: string) => {
    if (pts.length < 3 || opacity <= 0) return;
    const local = pts.map((p) => frame.toLocal(p));
    const tris = ShapeUtils.triangulateShape(
      local.map((l) => new Vector2(l[0], l[2])),
      [],
    );
    if (tris.length === 0) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(local.flat(), 3));
    g.setIndex(tris.flat());
    const mat = new MeshBasicMaterial({
      color,
      opacity,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const mesh = new Mesh(g, mat);
    mesh.name = name;
    mesh.renderOrder = 39;
    mesh.frustumCulled = false;
    mesh.raycast = () => undefined;
    group.add(mesh);
  };
  const addPoints = (pts: readonly SitePoint[], color: string, size = 7, name = '') => {
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
    p.name = name;
    p.renderOrder = 41;
    p.frustumCulled = false;
    p.raycast = () => undefined;
    group.add(p);
  };

  let shapes: Shape[] = [];
  const addFacing = (pts: readonly SitePoint[], color: string, name: string) => {
    const face = antennaAzimuth(pts);
    if (!face.ok) return;
    const span = Math.max(
      ...pts.map((p) =>
        Math.hypot(p[0] - face.center[0], p[1] - face.center[1], p[2] - face.center[2]),
      ),
    );
    const length = Math.max(0.5, Math.min(span, 5));
    const [e, n, z] = face.center;
    const [de, dn] = face.direction;
    const tip: SitePoint = [e + de * length, n + dn * length, z];
    addLine([face.center, tip], false, color, name);
    addLine(
      [
        [
          tip[0] - de * length * 0.25 + dn * length * 0.15,
          tip[1] - dn * length * 0.25 - de * length * 0.15,
          z,
        ],
        tip,
        [
          tip[0] - de * length * 0.25 - dn * length * 0.15,
          tip[1] - dn * length * 0.25 + de * length * 0.15,
          z,
        ],
      ],
      false,
      color,
    );
  };
  const rebuild = () => {
    const s = measureStore.getState();
    disposeGroup();
    shapes = shapesOf(
      s,
      dates.getState(),
      openManifest(),
      frame.epsg === null ? 'project north' : 'grid north',
    );
    for (const sh of shapes) {
      // named after the measurement: which view draws which is read from the scene (tests)
      const name = `measure:${sh.id}`;
      if (sh.filled)
        addFill(
          sh.points,
          sh.fill ?? sh.color,
          sh.fillOpacity ?? DEFAULT_FILL_OPACITY,
          `measure-fill:${sh.id}`,
        );
      // the stored border width, else the map's and the panel's default
      addLine(
        sh.points,
        sh.closed,
        sh.selected ? '#ffffff' : sh.color,
        name,
        sh.borderWidth ?? DEFAULT_BORDER_WIDTH,
      );
      addPoints(sh.points, sh.color, sh.selected ? 8 : 5, name);
      if (sh.tool === 'azimuth') addFacing(sh.points, sh.color, `measure-facing:${sh.id}`);
    }
    if (s.editing && !display) {
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
        if (a && b && m && !isTelecomTool(m.tool))
          mids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
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
      if (s.tool?.tool === 'azimuth') addFacing(pts, DRAFT_COLOR, 'measure-facing:draft');
    }
    sizeFatLines(true);
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
  const offFrame = stage.onFrame(() => {
    const s = measureStore.getState();
    if (!display && stage.tool !== 'select' && (s.draw || s.editing)) {
      endInput();
    }
    sizeFatLines();
    placeLabels();
  });

  // -------------------------------------------------- input
  let last: { raw: SitePoint; screen: ScreenPt; shift: boolean } | null = null;
  let lastClick: { x: number; y: number; t: number } | null = null;
  let dragging = false;

  const onMove = (e: PointerEvent) => {
    const s = measureStore.getState();
    if (s.editing && dragging) {
      const hit = pick(e);
      if (hit) editEvent({ type: 'drag', p: hit.p });
      return;
    }
    if (!s.draw) return;
    const hit = pick(e);
    const raw = hit?.p;
    if (!hit || !raw) {
      last = null;
      if (s.tool && isTelecomTool(s.tool.tool) && s.draw.cursor)
        measureStore.setState({ draw: { ...s.draw, cursor: null } });
      return;
    }
    last = { raw, screen: { x: e.clientX, y: e.clientY }, shift: e.shiftKey };
    drawEvent({ type: 'move', ...last }, env(), hit.at);
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
    const seg = isTelecomTool(m.tool)
      ? null
      : hitMidpoint(s.editing.points, isClosed(m.family), at, toScreen, 9);
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
  const claim = (e: PointerEvent) => {
    const s = measureStore.getState();
    if (stage.tool !== 'select' && (s.draw || s.editing)) {
      endInput();
      return false;
    }
    if (s.editing) return true;
    if (!s.draw) return false;
    const t = performance.now();
    const repeat =
      lastClick !== null &&
      Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) <= 4 &&
      t - lastClick.t <= 450;
    lastClick = { x: e.clientX, y: e.clientY, t };
    if (repeat) return true;
    const hit = pick(e);
    if (hit)
      drawEvent(
        { type: 'click', raw: hit.p, screen: { x: e.clientX, y: e.clientY }, shift: e.shiftKey },
        env(),
        hit.at,
      );
    else if (s.tool && isTelecomTool(s.tool.tool))
      measureStore.setState({
        message:
          'Pick a visible point cloud or mesh surface. Empty space and the ground plane cannot be measured.',
      });
    return true;
  };
  const offClaim = display ? null : stage.claimClicks(claim);
  const onDbl = (e: MouseEvent) => {
    if (!measureStore.getState().draw) return;
    e.preventDefault();
    drawEvent({ type: 'finish' }, env());
  };
  const onKey = (e: KeyboardEvent) => {
    const s = measureStore.getState();
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    // dialogs, popovers and the side panels keep their own keys
    if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"], .sv-side')) return;
    if (s.editing && e.key === 'Escape') {
      editEvent({ type: 'escape' });
      measureStore.setState({ editing: null });
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!s.draw) return;
    // Telecom has no typed drawing aids. Leave navigation and button activation to the browser.
    if (s.tool && isTelecomTool(s.tool.tool) && !['Escape', 'Backspace'].includes(e.key)) return;
    if (e.key === 'Shift' && last) {
      drawEvent({ type: 'move', ...last, shift: true }, env());
      return;
    }
    if (!DRAW_KEYS.test(e.key)) return;
    // Space types into a bearing only ("12 30 00"); otherwise it stays the app's play and pause
    if (e.key === ' ' && !(s.draw.typing.field === 'bearing' && s.draw.points.length > 0)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    drawEvent({ type: 'key', key: e.key }, env());
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Shift' && last && measureStore.getState().draw)
      drawEvent({ type: 'move', ...last, shift: false }, env());
  };

  // a view that only draws takes no input: the tools act in the main view
  if (!display) {
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDbl);
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
  }
  const offStore = measureStore.subscribe((s, prev) => {
    if (!display && dragging && !s.editing) {
      dragging = false;
      stage.controls.enabled = true;
    }
    if (
      s.file !== prev.file ||
      s.measurementsVisible !== prev.measurementsVisible ||
      s.hiddenMeasurements !== prev.hiddenMeasurements ||
      s.draw !== prev.draw ||
      s.selected !== prev.selected ||
      s.editing !== prev.editing ||
      s.settings !== prev.settings ||
      s.templates !== prev.templates
    )
      rebuild();
    if (display) return;
    const drawing = s.draw !== null || s.editing !== null;
    canvas.style.cursor = s.draw ? 'crosshair' : '';
    if (drawing && stage.tool !== 'select') stage.setTool('select');
  });
  const offDates = onDatesChange(dates, rebuild);
  rebuild();

  return () => {
    offStore();
    offDates();
    offFrame();
    offClaim?.();
    if (!display) {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      canvas.style.cursor = '';
    }
    if (dragging) stage.controls.enabled = true;
    disposeGroup();
    stage.scene.remove(group);
    labels.remove();
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
export function focusPoint(
  m: SurveyMeasurement,
  frame: Frame,
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'> | null = openManifest(),
): { p: Vec3; distance: number } {
  const points = drawnPoints(m, manifest);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 5);
  const c = anchorOf(points, true) ?? points[0] ?? [0, 0, 0];
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
const LAYERS = ['aio-survey-fill', 'aio-survey-line', 'aio-survey-pt', 'aio-survey-label'] as const;

/**
 * Draw the measurements on the map and drive the active tool there. Returns the detach. With
 * `opts.display` the map draws only (see `MeasureViewOptions`).
 */
export function attachMap(
  ctl: MapController,
  frame: Frame,
  clampZ: (e: number, n: number) => number | null,
  opts: MeasureViewOptions = {},
): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const dates = opts.dates ?? workspace;
  const display = opts.display === true;
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
      view: 'map',
      snap: (screen) => findSnap(screen, snapProviders(s, dates.getState()), toScreen, s.snap),
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
    for (const sh of shapesOf(
      s,
      dates.getState(),
      openManifest(),
      frame.epsg === null ? 'project north' : 'grid north',
    )) {
      const coords = sh.points.map(toLngLat);
      const props = {
        color: sh.selected ? '#ffffff' : sh.color,
        fill: sh.fill ?? sh.color,
        fillOpacity: sh.fillOpacity ?? DEFAULT_FILL_OPACITY,
        width: sh.borderWidth ?? DEFAULT_BORDER_WIDTH,
        id: sh.id,
      };
      const anchor = sh.label ? anchorOf(sh.points, sh.closed) : null;
      if (anchor && sh.label)
        features.push({
          type: 'Feature',
          properties: { kind: 'label', id: sh.id, label: sh.label, size: sh.labelSize },
          geometry: { type: 'Point', coordinates: toLngLat(anchor) },
        });
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
      const props = {
        color: DRAFT_COLOR,
        fill: DRAFT_COLOR,
        fillOpacity: DEFAULT_FILL_OPACITY,
        width: DEFAULT_BORDER_WIDTH,
        id: 'draft',
      };
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
  // A style still loading cannot take the source. The map says `styledata` before its style
  // counts as loaded, and a map that only draws gets no later event of its own: wait until it
  // has settled once.
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
      if (!map.getLayer(LAYERS[0]))
        map.addLayer({
          id: LAYERS[0],
          type: 'fill',
          source: SRC,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fillOpacity'] },
        });
      if (!map.getLayer(LAYERS[1]))
        map.addLayer({
          id: LAYERS[1],
          type: 'line',
          source: SRC,
          filter: ['!=', ['geometry-type'], 'Point'],
          paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
        });
      if (!map.getLayer(LAYERS[2]))
        map.addLayer({
          id: LAYERS[2],
          type: 'circle',
          source: SRC,
          filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'kind'], 'label']],
          paint: {
            'circle-radius': 4,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#000000',
            'circle-stroke-width': 1,
          },
        });
      if (!map.getLayer(LAYERS[3]))
        map.addLayer({
          id: LAYERS[3],
          type: 'symbol',
          source: SRC,
          filter: ['==', ['get', 'kind'], 'label'],
          // the 3D view's label: the name and the primary value, at the label size saved
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Medium'],
            'text-size': ['get', 'size'],
            'text-anchor': 'left',
            'text-offset': [0.6, 0],
            'text-padding': 4,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 1.5,
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
    const raw = site(e.lngLat.lng, e.lngLat.lat);
    // a map click is a ground pick on the topmost shown raster under it
    const ws = dates.getState();
    const manifest = openManifest();
    const layer =
      manifest && ws.dates ? mapPickLayer(manifest, ws.dates, ws.hidden, frame.toLocal(raw)) : null;
    drawEvent({ type: 'click', raw, screen: sc, shift: e.originalEvent.shiftKey }, env(), {
      layer,
      on: 'ground',
    });
  };
  const onDbl = (e: MapMouse) => {
    if (!measureStore.getState().draw) return;
    e.preventDefault();
    drawEvent({ type: 'finish' }, env());
  };
  const onStyle = () => {
    draw();
  };
  if (!display) {
    map.on('mousemove', onMove as never);
    map.on('click', onClick as never);
    map.on('dblclick', onDbl as never);
  }
  map.on('styledata', onStyle);
  const offStore = measureStore.subscribe((s, prev) => {
    if (
      s.file !== prev.file ||
      s.measurementsVisible !== prev.measurementsVisible ||
      s.hiddenMeasurements !== prev.hiddenMeasurements ||
      s.draw !== prev.draw ||
      s.selected !== prev.selected ||
      s.editing !== prev.editing ||
      s.settings !== prev.settings ||
      s.templates !== prev.templates
    )
      draw();
    if (!display) canvas.style.cursor = s.draw ? 'crosshair' : '';
  });
  const offDates = onDatesChange(dates, draw);
  draw();
  return () => {
    offStore();
    offDates();
    if (!display) {
      map.off('mousemove', onMove as never);
      map.off('click', onClick as never);
      map.off('dblclick', onDbl as never);
      canvas.style.cursor = '';
    }
    map.off('styledata', onStyle);
    map.off('idle', whenIdle);
    try {
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {
      // the map is going away
    }
  };
}
