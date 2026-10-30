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
  SiteMaterial,
  SitePoint,
  SurveyMeasurement,
  SurveySettings,
  SurveyTemplate,
  Vec3,
} from '@aio/schema';
import {
  figureOn,
  findSnap,
  materialColour,
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
import { stageShow, type ColourBy } from '../workspace/StageShow';
import { timeline } from '../workspace/timeline';
import { invalidPicks, primaryText, rowText, templateItems } from './card/cardModel';
import { captureInFocus } from './measureRows';
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
import { fallbackZ, type MapHeights } from './mapHeights';
import { mapPickLayer, type VertexPick } from './measureSource';
import { pileLookOwns, pileLookState } from './pile/pileLookState';
import { materialOf, materialsDraft } from './volumes/materialsDraft';
import { clampLabel, declutter, type LabelBox } from './labelDeclutter';

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
  /** Its line and fill are drawn (a pile's not, with the Show control's Outlines off). */
  outline: boolean;
  label: string | null;
  /** The measurement's name: a pile's whole label on the map. */
  name: string;
  /** A stockpile (`isPile`), not being edited. */
  pile: boolean;
  labelSize: number;
  /** Which label gives way when two collide in 3D: a pile's volume on the date in focus. */
  weight: number;
  tool: SurveyMeasurement['tool'];
}

/** What a view draws the shapes for: the date in focus and the Show control's pile overlays. */
export interface ShapeOptions {
  /** The survey date whose figures the labels read (`captureInFocus`); none: the stored one. */
  capture?: string | null;
  /** The Show control's Outlines and Labels (both on when left out). */
  show?: { outlines: boolean; labels: boolean };
  /** "Colour piles by": a pile's line and fill colour (a plain colour); none: its own. */
  pileColour?: (m: SurveyMeasurement) => string;
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
  opts: ShapeOptions = {},
): Shape[] {
  const templates = knownTemplates(s);
  const capture = opts.capture ?? undefined;
  const outlines = opts.show?.outlines ?? true;
  const labels = opts.show?.labels ?? true;
  return drawn(s, ws).flatMap((m) => {
    const selected = s.selected.includes(m.id);
    const live = s.editing && m.id === s.focus ? s.editing.points : null;
    // the Show control's Outlines and Labels hide the piles' (never the one being edited)
    const pile = live === null && isPile(m);
    const outline = !pile || outlines;
    const labelled = !pile || labels;
    if (!outline && !labelled) return [];
    // drawn points, and the label reads them out: positions are where the person sees them
    const points = live ?? drawnPoints(m, manifest);
    const style = m.style;
    const recolour = pile && opts.pileColour ? opts.pileColour(m) : null;
    const only = style?.labelOnlyWhenSelected === true;
    const label =
      !labelled || (only && !selected)
        ? null
        : labelText({ ...m, points }, s.settings, templates, north, capture);
    return {
      outline,
      id: m.id,
      tool: m.tool,
      points,
      closed: m.tool === 'azimuth' || isClosed(m.family),
      filled: isClosed(m.family),
      color: recolour ?? style?.color ?? DEFAULT_MEASURE_COLOUR,
      fill: recolour ?? style?.fill,
      fillOpacity: style?.fillOpacity,
      borderWidth: style?.borderWidth,
      selected,
      label,
      name: m.label,
      pile,
      labelSize: style?.labelSize ?? 12,
      weight: label && pile ? pileWeight(m, capture) : 0,
    };
  });
}

/** A pile's size for its label's place among close labels: its volume figure, as an amount. */
function pileWeight(m: SurveyMeasurement, capture: string | undefined): number {
  const row = primaryRow(m, capture !== undefined ? { capture } : {});
  return Math.abs(row?.value ?? 0);
}

/** A stockpile as the Show control's Outlines and Labels see it: a volume polygon. */
const isPile = (m: SurveyMeasurement) => m.tool === 'volume' && m.family === 'polygon';

/**
 * The cut and fill colours as plain values for WebGL and the map, when the tokens (`--cut`,
 * `--fill`, dark theme) cannot be read from the page.
 */
export const CHANGE_COLOURS = { cut: '#f9786a', fill: '#5eaceb' } as const;

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A CSS colour (`#rrggbb`, `var(--mat-3)`, a `color-mix`) as `#rrggbb` for WebGL and the map: the
 * page computes it and a one-pixel canvas reads it back. `fallback` when the page cannot (tests,
 * no DOM).
 */
export function cssColourHex(css: string, fallback: string): string {
  if (HEX.test(css)) return css.toLowerCase();
  if (typeof document === 'undefined' || typeof OffscreenCanvas === 'undefined') return fallback;
  try {
    const probe = document.createElement('span');
    probe.style.color = css;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    if (!computed || computed.includes('var(')) return fallback;
    const ctx = new OffscreenCanvas(1, 1).getContext('2d');
    if (!ctx) return fallback;
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return fallback;
  }
}

/** The survey dated just before `capture` in the project; null for the first or an unknown one. */
export function previousCapture(
  capture: string | null,
  captures: readonly { id: string; date: string }[],
): string | null {
  const at = captures.find((c) => c.id === capture);
  if (!at) return null;
  const t = Date.parse(at.date);
  if (!Number.isFinite(t)) return null;
  let best: { id: string; t: number } | null = null;
  for (const c of captures) {
    const ct = Date.parse(c.date);
    if (Number.isFinite(ct) && ct < t && (best === null || ct > best.t)) best = { id: c.id, t: ct };
  }
  return best?.id ?? null;
}

export interface PileColouring {
  /** The site's materials in their list order (their palette colour goes by it). */
  materials: readonly SiteMaterial[];
  /** A pile's material id (with the Materials pane's unsaved assignments). */
  materialOf(m: SurveyMeasurement): string | undefined;
  /** The date in focus and the survey before it: a pile's change between them. */
  capture: string | null;
  previous: string | null;
  /** A CSS colour as a plain one (`cssColourHex`). */
  hex(css: string, fallback: string): string;
}

const countedNet = (f: ReturnType<typeof figureOn>): number | null =>
  f !== null && f.status !== 'stale' && f.status !== 'refused' ? f.netM3 : null;

/**
 * "Colour piles by" (Materials pane): Material, each pile in its material's colour; Change, a pile
 * that grew since the survey before in the fill colour and one that shrank in the cut colour;
 * None, the default measurement colour. A pile without a material or a change takes the default.
 */
export function pileColourer(by: ColourBy, c: PileColouring): (m: SurveyMeasurement) => string {
  if (by === 'material') {
    const colours = new Map<string, string>();
    c.materials.forEach((mat, i) => {
      colours.set(mat.id, c.hex(materialColour(mat, i), DEFAULT_MEASURE_COLOUR));
    });
    return (m) => {
      const id = c.materialOf(m);
      return (id !== undefined ? colours.get(id) : undefined) ?? DEFAULT_MEASURE_COLOUR;
    };
  }
  if (by === 'change') {
    const cut = c.hex('var(--cut)', CHANGE_COLOURS.cut);
    const fill = c.hex('var(--fill)', CHANGE_COLOURS.fill);
    return (m) => {
      if (c.capture === null || c.previous === null) return DEFAULT_MEASURE_COLOUR;
      const now = countedNet(figureOn(m, c.capture));
      const before = countedNet(figureOn(m, c.previous));
      if (now === null || before === null || now === before) return DEFAULT_MEASURE_COLOUR;
      return now > before ? fill : cut;
    };
  }
  return () => DEFAULT_MEASURE_COLOUR;
}

/**
 * The date in focus and the Show control's pile overlays and colouring, as a view draws them now.
 * The overlays and colouring apply only while the control is up (the Volumes tab), the colouring
 * only on the Materials pane where it is chosen.
 */
export function viewShapeOptions(): ShapeOptions {
  const manifest = openManifest();
  const capture = captureInFocus(timeline.getState().focus, manifest);
  const show = stageShow.getState();
  if (!show.active) return { capture };
  const opts: ShapeOptions = { capture, show: { outlines: show.outlines, labels: show.labels } };
  if (show.pane !== 'materials') return opts;
  const draft = materialsDraft.getState();
  const cache = new Map<string, string>();
  opts.pileColour = pileColourer(show.colourBy, {
    materials: draft.materials(),
    materialOf: (m) => materialOf(m, draft.assignments),
    capture,
    previous: previousCapture(capture, manifest?.captures ?? []),
    hex: (css, fallback) => {
      let v = cache.get(css);
      if (v === undefined) {
        v = cssColourHex(css, fallback);
        cache.set(css, v);
      }
      return v;
    },
  });
  return opts;
}

/**
 * Redraw when the date in focus, the Show control (up or not, its overlays, the pane and the
 * colouring) or, while piles are coloured by material, the Materials pane's edits change.
 */
function onShowChange(redraw: () => void): () => void {
  const offTimeline = timeline.subscribe((s, p) => {
    if (s.focus !== p.focus) redraw();
  });
  const offShow = stageShow.subscribe((s, p) => {
    if (
      s.active !== p.active ||
      s.outlines !== p.outlines ||
      s.labels !== p.labels ||
      s.pane !== p.pane ||
      s.colourBy !== p.colourBy
    )
      redraw();
  });
  const offDraft = materialsDraft.subscribe((s, p) => {
    const show = stageShow.getState();
    if (!show.active || show.pane !== 'materials' || show.colourBy !== 'material') return;
    if (s.draft !== p.draft || s.assignments !== p.assignments) redraw();
  });
  return () => {
    offTimeline();
    offShow();
    offDraft();
  };
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
  capture?: string,
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
  // a volume reads its figure on the date in focus (volumetrics redesign C3), as the tree does
  const row =
    m.style?.showPropertyName === true
      ? primaryRow(m, capture !== undefined ? { capture } : {}, templateItems(m, templates))
      : null;
  const named = row
    ? `${row.label}: ${rowText(row, m, settings)}`
    : primaryText(m, { settings, templates, capture });
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
  const chips = labelChips(host);
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
      viewShapeOptions(),
    );
    for (const sh of shapes) {
      // named after the measurement: which view draws which is read from the scene (tests)
      const name = `measure:${sh.id}`;
      if (!sh.outline) continue;
      // the opened pile is drawn as its lifted box (`pileLookScene`) in the main view
      if (!display && pileLookOwns(sh.id)) continue;
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
  // the pointer over the view, in the labels' coordinates: a hidden label shows under it
  let pointer: { x: number; y: number } | null = null;
  const placeLabels = () => {
    const r = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    chips.place(
      shapes.flatMap((sh) => {
        if (!sh.label) return [];
        const anchor = anchorOf(sh.points, sh.closed);
        const p = anchor ? toScreen(anchor) : null;
        const inView = p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
        return [
          {
            id: sh.id,
            text: sh.label,
            size: sh.labelSize,
            selected: sh.selected,
            weight: sh.weight,
            pile: sh.pile,
            at: inView ? { x: Math.round(p.x - hr.left), y: Math.round(p.y - hr.top) } : null,
          },
        ];
      }),
      { x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height },
      pointer,
    );
  };
  const onHover = (e: PointerEvent) => {
    const hr = host.getBoundingClientRect();
    // the label's CSS margin puts it 24 px above and 6 px right of its anchor
    pointer = { x: e.clientX - hr.left - 6, y: e.clientY - hr.top + 24 };
  };
  const onLeave = () => {
    pointer = null;
  };
  canvas.addEventListener('pointermove', onHover, { passive: true });
  canvas.addEventListener('pointerleave', onLeave);
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
  const offShow = onShowChange(rebuild);
  const offLook = display
    ? null
    : pileLookState.subscribe((s, p) => {
        if (s.shown !== p.shown) rebuild();
      });
  rebuild();

  return () => {
    offStore();
    offDates();
    offShow();
    offLook?.();
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
    canvas.removeEventListener('pointermove', onHover);
    canvas.removeEventListener('pointerleave', onLeave);
    chips.remove();
    stage.requestRender();
  };
}

/** A label to place over a view: its anchor in the host's pixels, null when out of view. */
interface LabelItem {
  id: string;
  text: string;
  size: number;
  selected: boolean;
  weight: number;
  /** A stockpile's label: the only kind `declutter` may hide. */
  pile: boolean;
  at: { x: number; y: number } | null;
}

/** A label chip's margins in measure.css (`.sv-label`): above and right of its anchor. */
const LABEL_TOP = -24;
const LABEL_LEFT = 6;
/** A view narrower than this has no room for a label at all. */
const MIN_VIEW_W = 24;

/** The view's box in the labels' layer: the 3D canvas or the map, a pane of its own in Split. */
interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The measurement labels over a view (`.sv-label` chips in an `.sv-labels` layer of `host`), the
 * same in the 3D view and on the map: close ones kept apart (`declutter`), a hidden one shown while
 * the pointer rests on its place, and each kept inside `view` (`clampLabel`), so the right panel
 * or the next pane never cuts one. A label is measured again only when its text, font size or the
 * view's size changes.
 */
function labelChips(host: HTMLElement): {
  place(items: readonly LabelItem[], view: ViewBox, pointer: { x: number; y: number } | null): void;
  remove(): void;
} {
  const layer = document.createElement('div');
  layer.className = 'sv-labels';
  layer.setAttribute('aria-hidden', 'true');
  host.appendChild(layer);
  const sizes = new WeakMap<HTMLElement, { key: string; w: number; h: number }>();
  return {
    place(items, view, pointer) {
      while (layer.children.length > items.length) layer.lastChild?.remove();
      while (layer.children.length < items.length) {
        const el = document.createElement('span');
        el.className = 'sv-label';
        layer.appendChild(el);
      }
      const boxes: (LabelBox & { el: HTMLElement })[] = [];
      items.forEach((it, i) => {
        const el = layer.children[i] as HTMLElement;
        if (el.textContent !== it.text) el.textContent = it.text;
        el.dataset.id = it.id;
        el.style.fontSize = `${String(it.size)}px`;
        el.classList.toggle('sel', it.selected);
        // a pane closing in Split (too narrow for any name) shows no empty pills
        if (!it.at || view.w < MIN_VIEW_W) {
          el.style.display = 'none';
          return;
        }
        el.style.display = '';
        // a pane narrower than the label (Split at 1100 px): the label ends in an ellipsis
        // rather than run past the pane
        const maxW = `${String(Math.max(0, Math.floor(view.w)))}px`;
        if (el.style.maxWidth !== maxW) {
          el.style.maxWidth = maxW;
          el.style.boxSizing = 'border-box';
          el.style.overflow = 'hidden';
          el.style.textOverflow = 'ellipsis';
        }
        const key = `${String(view.w)}x${String(view.h)}|${String(it.size)}|${it.text}`;
        let size = sizes.get(el);
        if (size?.key !== key) {
          const b = el.getBoundingClientRect();
          size = { key, w: b.width, h: b.height };
          sizes.set(el, size);
        }
        boxes.push({
          el,
          id: it.id,
          ...it.at,
          w: size.w,
          h: size.h,
          selected: it.selected,
          weight: it.weight,
          pile: it.pile,
        });
      });
      // close labels: the picked ones and those that are not piles first, never hidden; then the
      // larger pile keeps its place, the next moves up, the rest wait for hover
      const placed = declutter(boxes, pointer);
      for (const b of boxes) {
        const at = placed.get(b.id);
        b.el.style.visibility = at?.hidden === true ? 'hidden' : '';
        // the transform stays the anchor; a nudge, or the view's edge, moves the chip by its margins
        b.el.style.transform = `translate(${String(b.x)}px, ${String(b.y)}px)`;
        const want = { x: b.x + LABEL_LEFT, y: b.y + LABEL_TOP + (at?.dy ?? 0) };
        const fit = clampLabel(view, want, b);
        const top = fit.at.y - b.y;
        const left = fit.at.x - b.x;
        b.el.style.marginTop = top !== LABEL_TOP ? `${String(top)}px` : '';
        b.el.style.marginLeft = left !== LABEL_LEFT ? `${String(left)}px` : '';
      }
    },
    remove() {
      layer.remove();
    },
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
const LAYERS = ['aio-survey-fill', 'aio-survey-line', 'aio-survey-pt'] as const;

/**
 * Draw the measurements on the map and drive the active tool there. Returns the detach. With
 * `opts.display` the map draws only (see `MeasureViewOptions`).
 */
export function attachMap(
  ctl: MapController,
  frame: Frame,
  clampZ: (e: number, n: number) => number | null,
  opts: MeasureViewOptions & {
    /** The date in view's surface heights, read where the stage has nothing under a pick. */
    heights?: MapHeights;
  } = {},
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
  // the stage first, then the date in view's prepared surface (cached tiles only)
  const heights = opts.heights;
  const surfaceZ = (e: number, n: number): number | null =>
    clampZ(e, n) ?? heights?.at(e, n) ?? null;
  const env = (): DrawEnv => {
    const s = measureStore.getState();
    return {
      view: 'map',
      snap: (screen) => findSnap(screen, snapProviders(s, dates.getState()), toScreen, s.snap),
      clampZ: surfaceZ,
      distanceUnit: effectiveUnits(s.settings.units).distance,
    };
  };
  // never 0: with no surface under it a point takes the previous vertex's height, then the origin's
  const site = (lng: number, lat: number): SitePoint => {
    const [e, n] = fromWgs84([lng, lat, 0], epsg);
    const prev = measureStore.getState().draw?.points.at(-1) ?? null;
    return [e, n, fallbackZ(surfaceZ(e, n), prev, openManifest()?.origin[2] ?? 0)];
  };

  // the labels are the 3D view's chips over the map: a symbol layer needs glyph files (not in
  // every build) and drops the labels that collide
  const chips = labelChips(map.getContainer());
  let labelled: { sh: Shape; text: string; at: [number, number] }[] = [];
  let pointer: { x: number; y: number } | null = null;
  const placeLabels = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    chips.place(
      labelled.map(({ sh, text, at }) => {
        const p = map.project(at);
        const inView = p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
        return {
          id: sh.id,
          text,
          size: sh.labelSize,
          selected: sh.selected,
          weight: sh.weight,
          pile: sh.pile,
          at: inView ? { x: Math.round(p.x), y: Math.round(p.y) } : null,
        };
      }),
      { x: 0, y: 0, w, h },
      pointer,
    );
  };
  const onHover = (e: PointerEvent) => {
    const r = map.getContainer().getBoundingClientRect();
    // the label's CSS margin puts it 24 px above and 6 px right of its anchor
    pointer = { x: e.clientX - r.left - 6, y: e.clientY - r.top + 24 };
    placeLabels();
  };
  const onLeave = () => {
    pointer = null;
    placeLabels();
  };
  const data = () => {
    const s = measureStore.getState();
    const features: unknown[] = [];
    labelled = [];
    for (const sh of shapesOf(
      s,
      dates.getState(),
      openManifest(),
      frame.epsg === null ? 'project north' : 'grid north',
      viewShapeOptions(),
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
      // on the map a pile is named only: its figures are on its card and in the Volumes tab
      const text = sh.pile && sh.name ? sh.name : sh.label;
      if (anchor && text) {
        const at = toLngLat(anchor);
        features.push({
          type: 'Feature',
          properties: { kind: 'label', id: sh.id, label: text, size: sh.labelSize },
          geometry: { type: 'Point', coordinates: at },
        });
        labelled.push({ sh, text, at });
      }
      if (!sh.outline) continue;
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
      placeLabels();
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
  map.on('move', placeLabels);
  map.on('resize', placeLabels);
  canvas.addEventListener('pointermove', onHover, { passive: true });
  canvas.addEventListener('pointerleave', onLeave);
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
  const offShow = onShowChange(draw);
  draw();
  return () => {
    offStore();
    offDates();
    offShow();
    if (!display) {
      map.off('mousemove', onMove as never);
      map.off('click', onClick as never);
      map.off('dblclick', onDbl as never);
      canvas.style.cursor = '';
    }
    map.off('styledata', onStyle);
    map.off('idle', whenIdle);
    map.off('move', placeLabels);
    map.off('resize', placeLabels);
    canvas.removeEventListener('pointermove', onHover);
    canvas.removeEventListener('pointerleave', onLeave);
    chips.remove();
    try {
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {
      // the map is going away
    }
  };
}
