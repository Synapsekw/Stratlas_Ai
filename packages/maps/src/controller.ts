// Browser-only: the imperative map behind MapView. Owns one MapLibre map, mirrors @aio/workspace
// (project, issues, clock, active clip, selection, visibility) into overlay sources and writes
// clicks back as selections.
import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import type { Issue, Layer, PoseSample, Vec3 } from '@aio/schema';
import { assetUrl, type createWorkspace, type Workspace } from '@aio/workspace';
import type { Feature, FeatureCollection } from 'geojson';
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  type AddLayerObject,
  type GeoJSONSource,
  type CircleLayerSpecification,
  type ExpressionSpecification,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { Vector3 } from 'three';
import { drawPreview, isRepeatClick, type MapDrawSeam } from './draw';
import { frameProjection, type FrameProjection } from './geo';
import { footprint, issueAnchor, poseAt, rasterQuad, type LonLat } from './overlays';
import { bboxOf, orderPacks, type MapPack } from './packs';
import { pyramidView, type PyramidIndex } from './pyramid';
import { issueFeatures, issueShapeBounds, styleLayers, type MapOverlay } from './vector';
import { installBasemap } from './runtime';
import { buildStyle } from './style';

type VideoLayer = Extract<Layer, { kind: 'video' }>;
type RasterLayer = Extract<Layer, { kind: 'raster' }>;
type VectorLayer = Extract<Layer, { kind: 'vector' }>;

/** How issues are coloured on the map: by their severity model or by their class. */
export type IssueColorBy = 'severity' | 'class';
type Collection = FeatureCollection;

const EMPTY: Collection = { type: 'FeatureCollection', features: [] };

/** Issue shapes (map polygons) draw from this zoom; below it they are points. */
const SHAPE_ZOOM = 17;
const ISSUE_LAYERS = [
  'aio-issue-shape-fill',
  'aio-issue-shape-line',
  'aio-issues-circle',
  'aio-issues-circle-far',
];
/** The lowest issue layer: overlays go under it. */
const OVERLAY_BEFORE = 'aio-issue-shape-fill';

// Mission tokens as hex (see style.ts).
const INK = {
  acc: '#60d3b2',
  accStrong: '#73ebc8',
  fg0: '#eaedf1',
  fg2: '#878d93',
  bg0: '#080a0d',
  sev: { 1: '#95a0ab', 2: '#78b3d6', 3: '#ebc751', 4: '#f48d3c', 5: '#f05653' },
};

const SRC = {
  flights: 'aio-flights',
  drone: 'aio-drone',
  issues: 'aio-issues',
  shapes: 'aio-issue-shapes',
  view: 'aio-view3d',
  draw: 'aio-draw',
};

export interface MapControllerOptions {
  packs: readonly MapPack[];
  store: ReturnType<typeof createWorkspace>;
  showFlights: boolean;
  /** Pack base URL override (dev harness); the app uses aio://packs/. */
  packBase?: string;
  /** The current drawing seam (map sightings), read on every click. */
  draw?: () => MapDrawSeam | null;
}

export interface MapController {
  /** The underlying MapLibre map (exports, tests, dev harness). */
  readonly map: MapLibreMap;
  resize(): void;
  /** Redraw the drawing preview and switch the cursor and double-click for drawing. */
  updateDraw(): void;
  /** GeoJSON overlays (road centreline, PCI units, density) drawn under the issues. */
  setOverlays(overlays: readonly MapOverlay[]): void;
  /** Show only these issues (null: all). */
  setIssueFilter(only: ReadonlySet<string> | null): void;
  setIssueColor(by: IssueColorBy): void;
  /** Show the 3D camera's view wedge (default on). */
  setCameraWedge(on: boolean): void;
  dispose(): void;
}

/** Metres per screen pixel at a latitude and MapLibre zoom (512 px tiles). */
export function metresPerPx(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

function fc(features: Feature[]): Collection {
  return { type: 'FeatureCollection', features };
}

function parsePoses(json: unknown): PoseSample[] {
  const samples = (json as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(samples)) return [];
  return samples.filter(
    (s): s is PoseSample =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as PoseSample).t === 'number' &&
      Array.isArray((s as PoseSample).pos) &&
      Array.isArray((s as PoseSample).q),
  );
}

export function createMapController(
  el: HTMLElement,
  { packs, store, showFlights, packBase, draw }: MapControllerOptions,
): MapController {
  installBasemap(packs, packBase ? { packBase } : {});
  const ordered = orderPacks(packs);
  const lang = document.documentElement.lang.startsWith('ar') ? 'ar' : 'en';
  const maxZoom = Math.max(6, ...packs.map((p) => p.maxZoom));
  const home = ordered.find((p) => p.maxZoom > 6) ?? ordered[0];
  const homeBox = home?.bbox ?? [-180, -85, 180, 85];

  const map = new MapLibreMap({
    container: el,
    style: buildStyle({ lang, maxZoom }),
    bounds: [
      [homeBox[0], homeBox[1]],
      [homeBox[2], homeBox[3]],
    ],
    maxZoom: 22,
    renderWorldCopies: false,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
  // Test hook: end-to-end tests query rendered features through the container.
  Object.assign(el, { __aioMap: map });
  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

  let disposed = false;
  let proj: FrameProjection | null = null;
  let projectId: string | null = null;
  let rasterIds: string[] = [];
  const flights = new Map<string, { layer: VideoLayer; samples: PoseSample[] }>();
  const cleanups: (() => void)[] = [];

  const setData = (id: string, data: Collection) => {
    void map.getSource<GeoJSONSource>(id)?.setData(data);
  };

  function addOverlayLayers(): void {
    for (const id of Object.values(SRC)) map.addSource(id, { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'aio-view3d-fill',
      type: 'fill',
      source: SRC.view,
      paint: { 'fill-color': INK.fg0, 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: 'aio-view3d-line',
      type: 'line',
      source: SRC.view,
      paint: { 'line-color': INK.fg0, 'line-opacity': 0.5, 'line-width': 1 },
    });
    map.addLayer({
      id: 'aio-flights-line',
      type: 'line',
      source: SRC.flights,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        visibility: showFlights ? 'visible' : 'none',
      },
      paint: {
        'line-color': ['case', ['get', 'active'], INK.acc, INK.fg2],
        'line-width': ['case', ['get', 'selected'], 4, ['get', 'active'], 3, 2],
        'line-opacity': ['case', ['get', 'active'], 1, 0.7],
      },
    });
    map.addLayer({
      id: 'aio-drone-footprint',
      type: 'fill',
      source: SRC.drone,
      filter: ['==', ['geometry-type'], 'Polygon'],
      layout: { visibility: showFlights ? 'visible' : 'none' },
      paint: { 'fill-color': INK.acc, 'fill-opacity': 0.18, 'fill-outline-color': INK.acc },
    });
    map.addLayer({
      id: 'aio-drone-point',
      type: 'circle',
      source: SRC.drone,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: { visibility: showFlights ? 'visible' : 'none' },
      paint: {
        'circle-radius': 6,
        'circle-color': INK.accStrong,
        'circle-stroke-color': INK.bg0,
        'circle-stroke-width': 2,
      },
    });
    const color: ExpressionSpecification = ['get', 'sevColor'];
    map.addLayer({
      id: 'aio-issue-shape-fill',
      type: 'fill',
      source: SRC.shapes,
      minzoom: SHAPE_ZOOM,
      paint: { 'fill-color': color, 'fill-opacity': 0.16 },
    });
    map.addLayer({
      id: 'aio-issue-shape-halo',
      type: 'line',
      source: SRC.shapes,
      minzoom: SHAPE_ZOOM - 1,
      filter: ['==', ['get', 'selected'], true],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': INK.fg0, 'line-width': 6, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'aio-issue-shape-line',
      type: 'line',
      source: SRC.shapes,
      minzoom: SHAPE_ZOOM,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': ['case', ['get', 'selected'], 2.5, 1.8],
        'line-opacity': 0.95,
      },
    });
    const circlePaint: CircleLayerSpecification['paint'] = {
      'circle-radius': [
        'case',
        ['get', 'selected'],
        9,
        ['+', 3, ['*', 0.9, ['to-number', ['get', 'severity'], 1]]],
      ],
      'circle-color': color,
      'circle-stroke-color': ['case', ['get', 'selected'], INK.fg0, INK.bg0],
      'circle-stroke-width': ['case', ['get', 'selected'], 3, 1],
    };
    // issues without a shape are always points; shaped issues are points until their shape shows
    map.addLayer({
      id: 'aio-issues-circle',
      type: 'circle',
      source: SRC.issues,
      filter: ['!', ['get', 'hasShape']],
      paint: circlePaint,
    });
    map.addLayer({
      id: 'aio-issues-circle-far',
      type: 'circle',
      source: SRC.issues,
      maxzoom: SHAPE_ZOOM,
      filter: ['get', 'hasShape'],
      paint: circlePaint,
    });
    map.addLayer({
      id: 'aio-issues-label',
      type: 'symbol',
      source: SRC.issues,
      minzoom: 17,
      layout: {
        'text-field': ['get', 'code'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
      },
      paint: { 'text-color': INK.fg0, 'text-halo-color': INK.bg0, 'text-halo-width': 1.5 },
    });
    map.addLayer({
      id: 'aio-draw-line',
      type: 'line',
      source: SRC.draw,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': INK.accStrong, 'line-width': 2, 'line-dasharray': [2, 1.5] },
    });
    map.addLayer({
      id: 'aio-draw-point',
      type: 'circle',
      source: SRC.draw,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 4,
        'circle-color': INK.accStrong,
        'circle-stroke-color': INK.bg0,
        'circle-stroke-width': 1.5,
      },
    });
  }

  // ----- drawing (map sightings) -----
  let lastClick: { x: number; y: number; t: number } | null = null;
  let ready = false;
  function updateDraw(): void {
    const d = draw?.() ?? null;
    const on = d?.mode != null;
    if (map.getSource(SRC.draw)) setData(SRC.draw, drawPreview(d?.mode ?? null, d?.vertices ?? []));
    map.getCanvas().style.cursor = on ? 'crosshair' : '';
    if (on) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }

  // ----- project rasters -----
  async function rasterImages(layer: RasterLayer, p: FrameProjection, id: string) {
    const out: { url: string; quad: [LonLat, LonLat, LonLat, LonLat] }[] = [];
    if (layer.format === 'image' && layer.corners) {
      out.push({ url: assetUrl(id, layer.src), quad: rasterQuad(layer.corners, p) });
    } else if (layer.format === 'kit-pyramid') {
      // One coarse level stays as a backdrop (at most 16 tiles); finer tiles follow the view.
      const res = await fetch(assetUrl(id, layer.src));
      const tiles = (await res.json()) as {
        levels?: { z: number; tileSize: number; cols: number; rows: number; pattern: string }[];
        corners?: { tl: Vec3; tr: Vec3; bl: Vec3 };
      };
      const corners = tiles.corners ?? layer.corners;
      if (corners && tiles.levels?.length)
        pyramids.push({ layer, index: { levels: tiles.levels, corners } });
      const levels = [...(tiles.levels ?? [])].sort((a, b) => b.cols * b.rows - a.cols * a.rows);
      const level = levels.find((l) => l.cols * l.rows <= 16) ?? levels[levels.length - 1];
      if (!corners || !level) return out;
      const { tl, tr, bl } = corners;
      const at = (u: number, v: number): Vec3 => [
        tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v,
        tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v,
        tl[2] + (tr[2] - tl[2]) * u + (bl[2] - tl[2]) * v,
      ];
      for (let y = 0; y < level.rows; y++) {
        for (let x = 0; x < level.cols; x++) {
          const path = level.pattern
            .replace('{z}', String(level.z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
          const u0 = x / level.cols;
          const u1 = (x + 1) / level.cols;
          const v0 = y / level.rows;
          const v1 = (y + 1) / level.rows;
          out.push({
            url: assetUrl(id, { path }),
            quad: rasterQuad({ tl: at(u0, v0), tr: at(u1, v0), bl: at(u0, v1) }, p),
          });
        }
      }
    }
    return out;
  }

  async function loadRasters(layers: readonly RasterLayer[], p: FrameProjection, id: string) {
    const all: LonLat[] = [];
    for (const layer of layers) {
      let images: Awaited<ReturnType<typeof rasterImages>> = [];
      try {
        images = await rasterImages(layer, p, id);
      } catch (e) {
        console.warn(`Map: raster ${layer.id} not shown`, e);
      }
      if (disposed || projectId !== id) return all;
      images.forEach((img, i) => {
        const sid = `aio-raster-${layer.id}-${i}`;
        map.addSource(sid, { type: 'image', url: img.url, coordinates: img.quad });
        map.addLayer(
          {
            id: sid,
            type: 'raster',
            source: sid,
            metadata: { layerId: layer.id },
            paint: {
              'raster-opacity': layer.role === 'plan' ? 0.75 : 0.95,
              'raster-fade-duration': 0,
            },
          },
          'aio-view3d-fill',
        );
        rasterIds.push(sid);
        all.push(...img.quad);
      });
    }
    return all;
  }

  // ----- kit pyramids at full detail: the tiles of the level that matches the view -----
  const pyramids: { layer: RasterLayer; index: PyramidIndex }[] = [];
  const pyrTiles = new Map<string, { sid: string; layerId: string; z: number }>();
  const missing = new Set<string>();
  let pyrTimer: ReturnType<typeof setTimeout> | null = null;

  function dropTile(key: string): void {
    const t = pyrTiles.get(key);
    if (!t) return;
    if (map.getLayer(t.sid)) map.removeLayer(t.sid);
    if (map.getSource(t.sid)) map.removeSource(t.sid);
    pyrTiles.delete(key);
  }

  function updatePyramids(): void {
    if (!proj || !pyramids.length || !ready) return;
    const p = proj;
    const b = map.getBounds();
    const corners = [
      p.toLocal(b.getWest(), b.getNorth()),
      p.toLocal(b.getEast(), b.getNorth()),
      p.toLocal(b.getEast(), b.getSouth()),
      p.toLocal(b.getWest(), b.getSouth()),
    ];
    const view = {
      minX: Math.min(...corners.map((c) => c[0])),
      maxX: Math.max(...corners.map((c) => c[0])),
      minZ: Math.min(...corners.map((c) => c[2])),
      maxZ: Math.max(...corners.map((c) => c[2])),
    };
    const mpp = metresPerPx(map.getCenter().lat, map.getZoom());
    const keep = new Set<string>();
    const stale: string[] = [];
    for (const { layer, index } of pyramids) {
      const coarse = Math.max(...index.levels.filter((l) => l.cols * l.rows <= 16).map((l) => l.z));
      const v = pyramidView(index, view, mpp);
      const hidden = store.getState().hidden[layer.id] === true;
      for (const t of v && v.z > coarse && !hidden ? v.tiles : []) {
        const key = `${layer.id}/${t.key}`;
        keep.add(key);
        if (pyrTiles.has(key) || missing.has(key)) continue;
        const sid = `aio-pyr-${layer.id}-${t.z}-${t.x}-${t.y}`;
        map.addSource(sid, {
          type: 'image',
          url: assetUrl(projectId ?? '', { path: t.path }),
          coordinates: rasterQuad(t.corners, p),
        });
        map.addLayer(
          {
            id: sid,
            type: 'raster',
            source: sid,
            metadata: { layerId: layer.id },
            paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
          },
          'aio-view3d-fill',
        );
        pyrTiles.set(key, { sid, layerId: layer.id, z: t.z });
      }
      if (v) for (const [key, t] of pyrTiles) if (!keep.has(key) && t.z !== v.z) stale.push(key);
      for (const [key, t] of pyrTiles) if (!keep.has(key) && t.z === v?.z) dropTile(key);
      if (!v) for (const key of [...pyrTiles.keys()]) if (!keep.has(key)) dropTile(key);
    }
    // Tiles of the previous level stay a moment, under the new ones, while those load.
    if (pyrTimer) clearTimeout(pyrTimer);
    pyrTimer = setTimeout(() => {
      pyrTimer = null;
      for (const key of stale) if (!keep.has(key)) dropTile(key);
    }, 900);
  }

  function clearProject(): void {
    for (const key of [...pyrTiles.keys()]) dropTile(key);
    pyramids.length = 0;
    missing.clear();
    for (const sid of rasterIds) {
      if (map.getLayer(sid)) map.removeLayer(sid);
      if (map.getSource(sid)) map.removeSource(sid);
    }
    rasterIds = [];
    flights.clear();
    for (const id of Object.values(SRC)) setData(id, EMPTY);
  }

  // ----- flights -----
  async function loadFlights(layers: readonly VideoLayer[], p: FrameProjection, id: string) {
    const all: LonLat[] = [];
    await Promise.all(
      layers.map(async (layer) => {
        try {
          const res = await fetch(assetUrl(id, layer.flight.src));
          const samples = parsePoses(await res.json());
          if (disposed || projectId !== id) return;
          flights.set(layer.id, { layer, samples });
          for (const s of samples) all.push(p.toLonLat(s.pos));
        } catch (e) {
          console.warn(`Map: flight path for ${layer.id} not shown`, e);
        }
      }),
    );
    return all;
  }

  function renderFlights(s: Workspace): void {
    if (!proj) return;
    const features: Feature[] = [];
    for (const [id, { samples }] of flights) {
      if (s.hidden[id] || samples.length < 2) continue;
      const p = proj;
      features.push({
        type: 'Feature',
        id,
        properties: {
          layerId: id,
          active: s.activeClip === id,
          selected: s.selection?.kind === 'clip' && s.selection.id === id,
        },
        geometry: { type: 'LineString', coordinates: samples.map((x) => p.toLonLat(x.pos)) },
      });
    }
    setData(SRC.flights, fc(features));
  }

  function renderDrone(s: Workspace): void {
    const f = s.activeClip ? flights.get(s.activeClip) : undefined;
    if (!proj || !f || s.hidden[f.layer.id]) {
      setData(SRC.drone, EMPTY);
      return;
    }
    const pose = poseAt(f.samples, s.nowMs - f.layer.flight.startUtcMs);
    if (!pose) {
      setData(SRC.drone, EMPTY);
      return;
    }
    const height = Math.max(1, pose.pos[1]);
    const ring = footprint(pose, f.layer.lens, { maxRange: Math.min(3000, height * 8) }).map((v) =>
      proj ? proj.toLonLat(v) : [0, 0],
    );
    const first = ring[0];
    setData(
      SRC.drone,
      fc([
        ...(first
          ? [
              {
                type: 'Feature' as const,
                properties: {},
                geometry: { type: 'Polygon' as const, coordinates: [[...ring, first]] },
              },
            ]
          : []),
        {
          type: 'Feature',
          properties: { layerId: f.layer.id },
          geometry: { type: 'Point', coordinates: proj.toLonLat(pose.pos) },
        },
      ]),
    );
  }

  // ----- issues -----
  let wedge = true;
  function applyWedge(): void {
    for (const id of ['aio-view3d-fill', 'aio-view3d-line'])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', wedge ? 'visible' : 'none');
  }
  let issueFilter: ReadonlySet<string> | null = null;
  let issueColor: IssueColorBy = 'severity';
  function renderIssues(s: Workspace): void {
    const manifest = s.project?.manifest;
    const { points, shapes } = issueFeatures(s.issues, {
      models: manifest?.severityModels ?? [],
      catalogues: manifest?.classCatalogues ?? [],
      selectedId: s.selection?.kind === 'issue' ? s.selection.id : null,
      proj,
      only: issueFilter,
    });
    setData(SRC.issues, points);
    setData(SRC.shapes, shapes);
  }
  function applyIssueColor(): void {
    const prop = issueColor === 'class' ? 'classColor' : 'sevColor';
    if (!map.getLayer('aio-issues-circle')) return;
    map.setPaintProperty('aio-issue-shape-fill', 'fill-color', ['get', prop]);
    map.setPaintProperty('aio-issue-shape-line', 'line-color', ['get', prop]);
    map.setPaintProperty('aio-issues-circle', 'circle-color', ['get', prop]);
    map.setPaintProperty('aio-issues-circle-far', 'circle-color', ['get', prop]);
  }

  // ----- GeoJSON overlays (props and manifest vector layers) -----
  interface Mounted {
    overlay: MapOverlay;
    layerIds: string[];
  }
  const mounted = new Map<string, Mounted>();
  let propOverlays: readonly MapOverlay[] = [];
  let vectorOverlays: MapOverlay[] = [];

  function unmount(id: string): void {
    const m = mounted.get(id);
    if (!m) return;
    for (const l of m.layerIds) if (map.getLayer(l)) map.removeLayer(l);
    if (map.getSource(`aio-ov-${id}`)) map.removeSource(`aio-ov-${id}`);
    mounted.delete(id);
  }

  function mountLayers(o: MapOverlay): string[] {
    const ids: string[] = [];
    for (const l of o.layers) {
      const lid = `aio-ov-${o.id}-${l.id}`;
      map.addLayer(
        {
          id: lid,
          type: l.type,
          source: `aio-ov-${o.id}`,
          ...(l.paint ? { paint: l.paint } : {}),
          layout: { ...(l.layout ?? {}), visibility: o.visible === false ? 'none' : 'visible' },
          ...(l.filter ? { filter: l.filter } : {}),
          ...(l.minzoom !== undefined ? { minzoom: l.minzoom } : {}),
          ...(l.maxzoom !== undefined ? { maxzoom: l.maxzoom } : {}),
        } as AddLayerObject,
        l.above ? 'aio-draw-line' : OVERLAY_BEFORE,
      );
      ids.push(lid);
    }
    return ids;
  }

  function syncOverlays(): void {
    if (!ready) return;
    const wanted = [...vectorOverlays, ...propOverlays];
    const ids = new Set(wanted.map((o) => o.id));
    for (const id of [...mounted.keys()]) if (!ids.has(id)) unmount(id);
    for (const o of wanted) {
      const m = mounted.get(o.id);
      const sid = `aio-ov-${o.id}`;
      if (!m) {
        map.addSource(sid, { type: 'geojson', data: o.data });
        mounted.set(o.id, { overlay: o, layerIds: mountLayers(o) });
        continue;
      }
      if (m.overlay.data !== o.data) void map.getSource<GeoJSONSource>(sid)?.setData(o.data);
      if (m.overlay.layers !== o.layers) {
        for (const l of m.layerIds) if (map.getLayer(l)) map.removeLayer(l);
        m.layerIds = mountLayers(o);
      } else if ((m.overlay.visible !== false) !== (o.visible !== false)) {
        for (const l of m.layerIds)
          map.setLayoutProperty(l, 'visibility', o.visible === false ? 'none' : 'visible');
      }
      m.overlay = o;
    }
  }

  function overlayAt(
    e: MapLayerMouseEvent,
  ): { o: MapOverlay; props: Record<string, unknown> } | null {
    const layers = [...mounted.values()]
      .filter((m) => m.overlay.visible !== false && (m.overlay.onClick ?? m.overlay.tooltip))
      .flatMap((m) => m.layerIds)
      .filter((l) => map.getLayer(l));
    if (!layers.length) return null;
    const hit = map.queryRenderedFeatures(e.point, { layers })[0];
    if (!hit) return null;
    const id = hit.layer.id;
    const m = [...mounted.values()].find((x) => x.layerIds.includes(id));
    return m ? { o: m.overlay, props: hit.properties } : null;
  }

  function vectorOverlaysFor(layers: readonly Layer[], id: string, s: Workspace): MapOverlay[] {
    return layers
      .filter((l): l is VectorLayer => l.kind === 'vector')
      .map((l) => ({
        id: `layer-${l.id}`,
        data: assetUrl(id, l.src),
        layers: styleLayers(l.style),
        visible: !s.hidden[l.id],
      }));
  }

  // ----- hover tooltip over issues and overlays -----
  const tip = new Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'aio-map-tip',
    offset: 12,
    maxWidth: '320px',
  });
  function onHover(e: MapLayerMouseEvent): void {
    if (draw?.()?.mode) {
      tip.remove();
      return;
    }
    const issueLayers = ISSUE_LAYERS.filter((l) => map.getLayer(l));
    const hit = issueLayers.length
      ? map.queryRenderedFeatures(e.point, { layers: issueLayers })[0]
      : undefined;
    let text: string | null;
    if (hit) {
      const p = hit.properties as { code?: string; title?: string; severityLabel?: string };
      text = `${p.code ?? ''} · ${p.title ?? ''}${p.severityLabel ? `\n${p.severityLabel}` : ''}`;
    } else {
      const ov = overlayAt(e);
      text = ov?.o.tooltip?.(ov.props) ?? null;
    }
    map.getCanvas().style.cursor = hit || text ? 'pointer' : '';
    if (!text) {
      tip.remove();
      return;
    }
    const el = document.createElement('div');
    el.textContent = text;
    el.style.whiteSpace = 'pre-line';
    tip.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
  }

  function applyVisibility(s: Workspace): void {
    for (const sid of rasterIds) {
      const layerId = (map.getLayer(sid)?.metadata as { layerId?: string } | undefined)?.layerId;
      if (layerId) map.setLayoutProperty(sid, 'visibility', s.hidden[layerId] ? 'none' : 'visible');
    }
    updatePyramids();
    const project = s.project;
    if (project) {
      vectorOverlays = vectorOverlaysFor(project.manifest.layers, project.id, s);
      syncOverlays();
    }
  }

  // ----- 3D camera view wedge -----
  function renderView(scene: SceneHandle | null): void {
    if (!proj || !scene) {
      setData(SRC.view, EMPTY);
      return;
    }
    const cam = scene.camera;
    const pos = cam.position;
    const dir = cam.getWorldDirection(new Vector3());
    const heading = Math.atan2(dir.x, -dir.z);
    const len = Math.min(2000, Math.max(60, pos.y * 2));
    const half = (((cam.fov * cam.aspect) / 2) * Math.PI) / 180;
    const pt = (a: number): Vec3 => [pos.x + Math.sin(a) * len, 0, pos.z - Math.cos(a) * len];
    const p = proj;
    const ring = [
      [pos.x, 0, pos.z] as Vec3,
      pt(heading - Math.min(half, 1.3)),
      pt(heading + Math.min(half, 1.3)),
    ].map((v) => p.toLonLat(v));
    const first = ring[0];
    if (!first) return;
    setData(
      SRC.view,
      fc([
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [[...ring, first]] },
        },
      ]),
    );
  }

  // ----- project lifecycle -----
  async function openProject(s: Workspace): Promise<void> {
    clearProject();
    const project = s.project;
    projectId = project?.id ?? null;
    proj = project ? frameProjection(project.manifest.crs, project.manifest.origin) : null;
    if (!project || !proj) return;
    const id = project.id;
    const layers = project.manifest.layers;
    const rasters = layers.filter((l): l is RasterLayer => l.kind === 'raster');
    const videos = layers.filter((l): l is VideoLayer => l.kind === 'video');
    const [rasterPts, flightPts] = await Promise.all([
      loadRasters(rasters, proj, id),
      loadFlights(videos, proj, id),
    ]);
    if (disposed || projectId !== id) return;
    const now = store.getState();
    renderFlights(now);
    renderDrone(now);
    renderIssues(now);
    applyVisibility(now);
    const issuePts = now.issues.map((i) => issueAnchor(i, proj)).filter((x): x is LonLat => !!x);
    const box = bboxOf([...rasterPts, ...flightPts, ...issuePts]);
    if (box) {
      map.fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        { padding: 40, maxZoom: 17, duration: 0 },
      );
    } else {
      map.jumpTo({ center: proj.toLonLat([0, 0, 0]), zoom: 15 });
    }
  }

  /** A camera request (fly to a point or an issue) moves the map too; the 3D view consumes it. */
  function followCamera(s: Workspace): void {
    const req = s.lastCamera;
    if (!req || !proj) return;
    const t = req.target;
    if (t.kind === 'point') {
      const at = proj.toLonLat(t.p);
      const d = t.distance;
      let zoom = map.getZoom();
      if (d !== undefined) {
        const wantMpp = (d * 1.5) / Math.max(200, map.getCanvas().clientWidth);
        zoom = Math.log2((40_075_016.686 * Math.cos((at[1] * Math.PI) / 180)) / (512 * wantMpp));
      }
      map.easeTo({ center: at, zoom: Math.min(22, Math.max(3, zoom)), duration: 500 });
    } else if (t.kind === 'selection' && t.selection.kind === 'issue') {
      const id = t.selection.id;
      const issue = s.issues.find((i) => i.id === id);
      if (issue) focusIssueOnMap(issue);
    }
  }

  function focusIssueOnMap(issue: Issue): void {
    const b = issueShapeBounds(issue);
    if (b) {
      // Small defects get context around them; large ones fill the view.
      const padM = 4;
      const dLat = padM / 111_000;
      const dLon = padM / (111_000 * Math.cos((b[1] * Math.PI) / 180));
      map.fitBounds(
        [
          [b[0] - dLon, b[1] - dLat],
          [b[2] + dLon, b[3] + dLat],
        ],
        { padding: 60, maxZoom: 22, duration: 600 },
      );
      return;
    }
    const at = issueAnchor(issue, proj);
    if (at) map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 18), duration: 500 });
  }

  function focusSelection(s: Workspace): void {
    if (s.selection?.kind !== 'issue') return;
    const id = s.selection.id;
    const issue = s.issues.find((i) => i.id === id);
    const at = issue ? issueAnchor(issue, proj) : null;
    if (at && !map.getBounds().contains(at)) map.easeTo({ center: at, duration: 300 });
  }

  // ----- clicks -----
  function onClick(e: MapLayerMouseEvent): void {
    const d = draw?.() ?? null;
    if (d?.mode) {
      const at = { x: e.point.x, y: e.point.y, t: performance.now() };
      const repeat = isRepeatClick(lastClick, at);
      lastClick = at;
      if (!repeat)
        d.onClick([e.lngLat.lng, e.lngLat.lat], {
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
        });
      return;
    }
    const hit = map.queryRenderedFeatures(e.point, {
      layers: [...ISSUE_LAYERS, 'aio-drone-point', 'aio-flights-line'].filter((l) =>
        map.getLayer(l),
      ),
    })[0];
    const props = hit?.properties as { issueId?: string; layerId?: string } | undefined;
    const st = store.getState();
    const ov = props ? null : overlayAt(e);
    if (props?.issueId) {
      st.select({ kind: 'issue', id: props.issueId });
    } else if (props?.layerId) {
      st.setActiveClip(props.layerId);
      st.select({ kind: 'clip', id: props.layerId });
    } else if (ov?.o.onClick) {
      ov.o.onClick(ov.props, [e.lngLat.lng, e.lngLat.lat]);
    } else if (e.originalEvent.altKey && proj) {
      // Alt+click: move the 3D camera to this ground point.
      st.flyTo({ kind: 'point', p: proj.toLocal(e.lngLat.lng, e.lngLat.lat) });
    }
  }

  map.on('load', () => {
    if (disposed) return;
    addOverlayLayers();
    ready = true;
    map.on('click', onClick);
    map.on('dblclick', (e) => {
      const d = draw?.() ?? null;
      if (!d?.mode) return;
      e.preventDefault();
      d.onFinish();
    });
    const drawing = () => draw?.()?.mode != null;
    for (const id of ['aio-flights-line', 'aio-drone-point']) {
      map.on('mouseenter', id, () => {
        if (!drawing()) map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', id, () => {
        if (!drawing()) map.getCanvas().style.cursor = '';
      });
    }
    let hoverRaf = 0;
    map.on('mousemove', (e) => {
      if (drawing()) return;
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        onHover(e);
      });
    });
    map.on('mouseout', () => tip.remove());
    // A tile of a pyramid that is not in the package (outside the survey) is not asked for again.
    map.on('error', (e: { sourceId?: string; error?: unknown }) => {
      const sid = e.sourceId;
      if (sid?.startsWith('aio-pyr-')) {
        for (const [key, t] of pyrTiles)
          if (t.sid === sid) {
            missing.add(key);
            dropTile(key);
          }
        return;
      }
      console.error('Map error', e.error ?? e);
    });
    map.on('moveend', () => {
      updatePyramids();
    });
    applyIssueColor();
    applyWedge();
    syncOverlays();
    updateDraw();

    let prev = store.getState();
    void openProject(prev);
    let frame = 0;
    cleanups.push(
      store.subscribe((s) => {
        const last = prev;
        prev = s;
        if (s.project !== last.project) {
          void openProject(s);
          return;
        }
        if (s.issues !== last.issues || s.selection !== last.selection) renderIssues(s);
        if (
          s.activeClip !== last.activeClip ||
          s.selection !== last.selection ||
          s.hidden !== last.hidden
        )
          renderFlights(s);
        if (s.hidden !== last.hidden) applyVisibility(s);
        if (s.selection !== last.selection) focusSelection(s);
        if (s.lastCamera !== last.lastCamera) followCamera(s);
        if (
          s.nowMs !== last.nowMs ||
          s.activeClip !== last.activeClip ||
          s.hidden !== last.hidden
        ) {
          if (!frame)
            frame = requestAnimationFrame(() => {
              frame = 0;
              renderDrone(store.getState());
            });
        }
      }),
    );

    // Mirror the 3D camera as a view wedge, at most 10 times a second.
    let unFrame: (() => void) | null = null;
    const attach = (scene: SceneHandle | null) => {
      unFrame?.();
      unFrame = null;
      renderView(scene);
      if (!scene) return;
      let last = 0;
      unFrame = scene.onFrame(() => {
        const t = performance.now();
        if (t - last < 100) return;
        last = t;
        renderView(scene);
      });
    };
    const offScene = onActiveScene(attach);
    attach(getActiveScene());
    cleanups.push(
      offScene,
      () => unFrame?.(),
      () => {
        if (frame) cancelAnimationFrame(frame);
      },
    );
  });

  return {
    map,
    resize: () => {
      map.resize();
    },
    updateDraw: () => {
      if (ready) updateDraw();
    },
    setOverlays: (overlays) => {
      propOverlays = overlays;
      syncOverlays();
    },
    setIssueFilter: (only) => {
      issueFilter = only;
      if (ready) renderIssues(store.getState());
    },
    setIssueColor: (by) => {
      issueColor = by;
      applyIssueColor();
    },
    setCameraWedge: (on) => {
      wedge = on;
      applyWedge();
    },
    dispose: () => {
      disposed = true;
      if (pyrTimer) clearTimeout(pyrTimer);
      tip.remove();
      for (const c of cleanups) c();
      map.remove();
    },
  };
}
