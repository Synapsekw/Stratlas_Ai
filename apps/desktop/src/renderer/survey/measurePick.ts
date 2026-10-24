/**
 * Picking measurements in the main 3D view and on the main map: a right-click on a drawn
 * measurement opens its menu (`MeasureMenu`), a left click selects it and shows its row in the
 * Datasets tree. Pins, photos, 360s and the drone keep their clicks; the measurements take theirs
 * before layer and ground picking. Nothing here while a measure tool draws or a measurement's
 * vertices are being edited: those clicks belong to the tool.
 */
import { markersHit, type EngineStage } from '@aio/engine';
import { toWgs84 } from '@aio/geo';
import { frameProjection, ISSUE_LAYERS, PHOTO_PIN_LAYERS, type MapController } from '@aio/maps';
import type { Vec3 } from '@aio/schema';
import type { ToScreen } from '@aio/survey';
import { workspace } from '@aio/workspace';
import { Vector3 } from 'three';
import { issueAt } from '@aio/annotate';
import { claimEvent, isClaimed, rigHit } from '../builder/droneHits';
import { MAP_DRONE } from '../builder/DroneMenu';
import { CLICK_PX, photosAt3d } from '../builder/PhotoMenu';
import { placedPanos } from '../pins/PinMenu';
import { drawnPins, pinsAt, type MediaKey } from '../pins/pinModel';
import { primaryMap, primaryScene } from '../workspace/compare';
import type { DatesOnScreen } from './measureDates';
import { measureAt, type HitShape } from './measureHits';
import { shapesOf, type Frame } from './measureScene';
import { measureStore, revealMeasurement, select, type MeasureState } from './measureStore';
import { isPile, openPile } from './pile/openPile';

/** A measure tool is drawing or a measurement's vertices are being edited: no pick, no menu. */
export function pickBlocked(s: Pick<MeasureState, 'tool' | 'draw' | 'editing'>): boolean {
  return s.tool !== null || s.draw !== null || s.editing !== null;
}

/** Where a measurement's menu opens, and for which project (a menu belongs to its project). */
export interface MeasureMenuAt {
  x: number;
  y: number;
  id: string;
  projectId: string;
}

/**
 * Map layers whose features keep a click (issues, the drone and its flights, photo pins): the
 * map controller and the photo and drone menus act on them.
 */
const MAP_POINT_LAYERS: readonly string[] = [
  ...ISSUE_LAYERS,
  ...MAP_DRONE,
  'aio-flights-line',
  ...PHOTO_PIN_LAYERS,
];
/** How near a map feature the cursor is on it (as the photo and drone menus ask). */
const MAP_FEATURE_PX = 5;

/** The shapes this view draws, as the hit test reads them (positions through their date shift). */
function hitShapes(dates: DatesOnScreen, frame: Frame): HitShape[] {
  const manifest = workspace.getState().project?.manifest ?? null;
  return shapesOf(
    measureStore.getState(),
    dates,
    manifest,
    frame.epsg === null ? 'project north' : 'grid north',
  ).map((sh) => ({ id: sh.id, points: sh.points, closed: sh.closed }));
}

const hiddenLayers = (): ReadonlySet<string> => new Set(Object.keys(workspace.getState().hidden));

/**
 * The right-click of one view's canvas: a press and release that barely moved, not taken by a
 * pin, photo or drone menu (they listen on the pane, before the window does), not on another
 * point target, over a drawn measurement.
 */
function attachRightClick(
  canvas: HTMLElement,
  pointTarget: (x: number, y: number) => boolean,
  hit: (x: number, y: number) => string | null,
  onMenu: (m: MeasureMenuAt) => void,
): () => void {
  let down: { x: number; y: number } | null = null;
  const pd = (e: PointerEvent) => {
    if (e.button === 2) down = e.target === canvas ? { x: e.clientX, y: e.clientY } : null;
  };
  const ctx = (e: MouseEvent) => {
    const d = down;
    down = null;
    if (e.target !== canvas || isClaimed(e)) return;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
    if (pickBlocked(measureStore.getState())) return;
    const projectId = workspace.getState().project?.id;
    if (!projectId || pointTarget(e.clientX, e.clientY)) return;
    const id = hit(e.clientX, e.clientY);
    if (!id) return;
    e.preventDefault();
    claimEvent(e);
    onMenu({ x: e.clientX, y: e.clientY, id, projectId });
  };
  window.addEventListener('pointerdown', pd, true);
  window.addEventListener('contextmenu', ctx);
  return () => {
    window.removeEventListener('pointerdown', pd, true);
    window.removeEventListener('contextmenu', ctx);
  };
}

/**
 * A left click's pick: a measurement under the cursor is selected and its row shown (the
 * sidebar stays as it is), a pile opened in the Volumes tab; a click beside every measurement clears the measurement selection
 * and is left to the view. Returns whether the click was taken.
 */
function pickClick(
  x: number,
  y: number,
  pointTarget: (x: number, y: number) => boolean,
  hit: (x: number, y: number) => string | null,
): boolean {
  const s = measureStore.getState();
  if (pickBlocked(s) || pointTarget(x, y)) return false;
  const id = hit(x, y);
  if (id) {
    // a pile opens in the Volumes tab, any other measurement is selected for the Measure tab
    const m = s.file.measurements.find((r) => r.id === id);
    if (m && isPile(m)) openPile(id);
    else select([id], id);
    revealMeasurement(id, { openSidebar: false });
    return true;
  }
  if (s.selected.length > 0 || s.focus !== null) select([], null);
  return false;
}

/**
 * Pick measurements in the main 3D view: the right-click menu and the left click select.
 * Returns the detach.
 */
export function attachMeasurePick3d(
  stage: EngineStage,
  frame: Frame,
  onMenu: (m: MeasureMenuAt) => void,
): () => void {
  const canvas = stage.renderer.domElement;
  const tmp = new Vector3();
  /** A local (drawn frame) point on screen, null behind the camera. */
  const localToScreen = (p: Vec3) => {
    tmp.set(p[0], p[1], p[2]).project(stage.camera);
    if (tmp.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((tmp.x + 1) / 2) * r.width, y: r.top + ((1 - tmp.y) / 2) * r.height };
  };
  const toScreen: ToScreen = (p) => localToScreen(frame.toLocal(p));
  const hit = (x: number, y: number) =>
    measureAt(hitShapes(primaryScene.getState(), frame), toScreen, x, y);
  const pointTarget = (x: number, y: number): boolean => {
    if (markersHit(canvas, x, y)) return true;
    if (issueAt(canvas, x, y) !== null) return true;
    if (photosAt3d(stage, canvas, x, y)) return true;
    if (rigHit(stage, canvas, x, y)) return true;
    const m = workspace.getState().project?.manifest;
    if (!m) return false;
    const hidden = hiddenLayers();
    const points: { key: MediaKey; x: number; y: number }[] = [];
    const add = (key: MediaKey, p: Vec3) => {
      const at = localToScreen(p);
      if (at) points.push({ key, ...at });
    };
    for (const p of drawnPins(m, hidden)) {
      add(p.key, p.eye);
      add(p.key, p.ground);
    }
    for (const p of placedPanos(m, hidden)) add(p.key, p.pos);
    return pinsAt(points, x, y) !== null;
  };
  const offRight = attachRightClick(canvas, pointTarget, hit, onMenu);
  const offClaim = stage.claimClicks((e) => {
    if (stage.tool !== 'select') return false;
    return pickClick(e.clientX, e.clientY, pointTarget, hit);
  });
  return () => {
    offRight();
    offClaim();
  };
}

/**
 * Pick measurements on the main map: the right-click menu and the left click select. A map
 * without a projected CRS draws no measurements and picks none. Returns the detach.
 */
export function attachMeasurePickMap(
  ctl: MapController,
  frame: Frame,
  onMenu: (m: MeasureMenuAt) => void,
): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const canvas = map.getCanvas();
  const container = map.getContainer();
  const toScreen: ToScreen = (p) => {
    const ll = toWgs84([p[0], p[1], p[2]], epsg);
    const px = map.project([ll[0], ll[1]]);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + px.x, y: r.top + px.y };
  };
  const hit = (x: number, y: number) =>
    measureAt(hitShapes(primaryMap.getState(), frame), toScreen, x, y);
  const pointTarget = (x: number, y: number): boolean => {
    // a pick, a pointer session or a drawing of the map's own holds the cursor as a crosshair
    if (canvas.style.cursor === 'crosshair') return true;
    if (markersHit(canvas, x, y)) return true;
    const r = canvas.getBoundingClientRect();
    const px = x - r.left;
    const py = y - r.top;
    const layers = MAP_POINT_LAYERS.filter((l) => map.getLayer(l));
    if (
      layers.length > 0 &&
      map.queryRenderedFeatures(
        [
          [px - MAP_FEATURE_PX, py - MAP_FEATURE_PX],
          [px + MAP_FEATURE_PX, py + MAP_FEATURE_PX],
        ],
        { layers },
      ).length > 0
    )
      return true;
    const m = workspace.getState().project?.manifest;
    const proj = m ? frameProjection(m.crs, m.origin) : null;
    if (!m || !proj) return false;
    const points = placedPanos(m, hiddenLayers()).map((p) => {
      const at = map.project(proj.toLonLat(p.pos));
      return { key: p.key, x: r.left + at.x, y: r.top + at.y };
    });
    return pinsAt(points, x, y) !== null;
  };
  const offRight = attachRightClick(canvas, pointTarget, hit, onMenu);
  let down: { x: number; y: number } | null = null;
  const pd = (e: PointerEvent) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY };
  };
  const click = (e: MouseEvent) => {
    const d = down;
    down = null;
    if (e.target !== canvas || e.button !== 0) return;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
    pickClick(e.clientX, e.clientY, pointTarget, hit);
  };
  container.addEventListener('pointerdown', pd, true);
  container.addEventListener('click', click);
  return () => {
    offRight();
    container.removeEventListener('pointerdown', pd, true);
    container.removeEventListener('click', click);
  };
}
