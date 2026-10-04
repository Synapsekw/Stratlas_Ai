// Browser-only: the imperative map behind MapView. Owns one MapLibre map, mirrors @aio/workspace
// (project, issues, clock, active clip, selection, visibility) into overlay sources and writes
// clicks back as selections.
import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import type { Layer, PoseSample, Vec3 } from '@aio/schema';
import { assetUrl, type createWorkspace, type Workspace } from '@aio/workspace';
import type { Feature, FeatureCollection } from 'geojson';
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { Vector3 } from 'three';
import { drawPreview, isRepeatClick, type MapDrawSeam } from './draw';
import { frameProjection, type FrameProjection } from './geo';
import {
  ALL_ISSUES,
  footprint,
  issueAnchor,
  issueFeatures,
  poseAt,
  rasterQuad,
  severityRankColors,
  type LonLat,
  type MapIssueDisplay,
} from './overlays';
import { bboxOf, orderPacks, type MapPack } from './packs';
import { installBasemap } from './runtime';
import { buildStyle } from './style';

type VideoLayer = Extract<Layer, { kind: 'video' }>;
type RasterLayer = Extract<Layer, { kind: 'raster' }>;
type Collection = FeatureCollection;

const EMPTY: Collection = { type: 'FeatureCollection', features: [] };

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
  issuesFocus: 'aio-issues-focus',
  issuesHeat: 'aio-issues-heat',
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
  /** How issues are drawn (pins filter, heat map), read on every issue redraw. */
  issues?: () => MapIssueDisplay;
}

export interface MapController {
  /** The underlying MapLibre map (exports, tests, dev harness). */
  readonly map: MapLibreMap;
  resize(): void;
  /** Redraw the drawing preview and switch the cursor and double-click for drawing. */
  updateDraw(): void;
  /** Redraw the issue markers after the display settings changed. */
  updateIssues(): void;
  dispose(): void;
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
  { packs, store, showFlights, packBase, draw, issues: issueDisplay }: MapControllerOptions,
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
    maxZoom: 20,
    renderWorldCopies: false,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
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
    for (const id of Object.values(SRC)) {
      if (id === SRC.issues) continue;
      map.addSource(id, { type: 'geojson', data: EMPTY });
    }
    // Issues cluster on the GPU side of MapLibre: badges carry the count and the worst rank.
    map.addSource(SRC.issues, {
      type: 'geojson',
      data: EMPTY,
      cluster: true,
      clusterRadius: 42,
      clusterMaxZoom: 19,
      clusterProperties: { top: ['max', ['get', 'rank']] },
    });
    map.addLayer({
      id: 'aio-issues-heat',
      type: 'heatmap',
      source: SRC.issuesHeat,
      maxzoom: 21,
      paint: {
        'heatmap-weight': ['get', 'weight'],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 18, 2.2],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 18, 19, 40],
        'heatmap-opacity': 0.75,
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0,
          'rgba(0,0,0,0)',
          0.15,
          'rgba(120,179,214,0.45)',
          0.4,
          '#ebc751',
          0.7,
          '#f48d3c',
          1,
          '#f05653',
        ],
      },
    });
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
    map.addLayer({
      id: 'aio-issues-cluster',
      type: 'circle',
      source: SRC.issues,
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': ['step', ['get', 'point_count'], 10, 10, 12, 50, 15, 200, 18, 1000, 21],
        'circle-color': INK.fg2,
        'circle-stroke-color': INK.bg0,
        'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'aio-issues-count',
      type: 'symbol',
      source: SRC.issues,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': INK.bg0 },
    });
    map.addLayer({
      id: 'aio-issues-circle',
      type: 'circle',
      source: SRC.issues,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': 5.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': INK.bg0,
        'circle-stroke-width': 1.5,
      },
    });
    // Codes only where they fit (symbol collision) and only close in.
    map.addLayer({
      id: 'aio-issues-label',
      type: 'symbol',
      source: SRC.issues,
      filter: ['!', ['has', 'point_count']],
      minzoom: 17,
      layout: {
        'text-field': ['get', 'code'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-padding': 4,
      },
      paint: { 'text-color': INK.fg0, 'text-halo-color': INK.bg0, 'text-halo-width': 1.5 },
    });
    map.addLayer({
      id: 'aio-issues-focus',
      type: 'circle',
      source: SRC.issuesFocus,
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 9, 7],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': ['case', ['get', 'selected'], INK.fg0, INK.bg0],
        'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
      },
    });
    map.addLayer({
      id: 'aio-issues-focus-label',
      type: 'symbol',
      source: SRC.issuesFocus,
      layout: {
        'text-field': ['get', 'code'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 12,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': INK.fg0, 'text-halo-color': INK.bg0, 'text-halo-width': 2 },
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
      // Draw one coarse level as a grid of image quads (at most 16 tiles).
      const res = await fetch(assetUrl(id, layer.src));
      const tiles = (await res.json()) as {
        levels?: { z: number; tileSize: number; cols: number; rows: number; pattern: string }[];
        corners?: { tl: Vec3; tr: Vec3; bl: Vec3 };
      };
      const corners = tiles.corners ?? layer.corners;
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

  function clearProject(): void {
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
  let hoverIssue: string | null = null;
  function renderIssues(s: Workspace, focusOnly = false): void {
    if (!map.getSource(SRC.issues)) return;
    const models = s.project?.manifest.severityModels ?? [];
    const f = issueFeatures(s.issues, proj, models, issueDisplay?.() ?? ALL_ISSUES, {
      selected: s.selection?.kind === 'issue' ? s.selection.id : null,
      hover: hoverIssue,
    });
    setData(SRC.issuesFocus, fc(f.focus));
    if (focusOnly) return;
    setData(SRC.issues, fc(f.points));
    setData(SRC.issuesHeat, fc(f.heat));
  }

  /** Cluster badges take the colour of their worst member, from the project's models. */
  function paintClusters(s: Workspace): void {
    if (!map.getLayer('aio-issues-cluster')) return;
    const pairs = severityRankColors(s.project?.manifest.severityModels ?? []);
    const color = pairs.length
      ? (['match', ['get', 'top'], ...pairs.flat(), INK.fg2] as unknown as ExpressionSpecification)
      : INK.fg2;
    map.setPaintProperty('aio-issues-cluster', 'circle-color', color);
  }

  function applyVisibility(s: Workspace): void {
    for (const sid of rasterIds) {
      const layerId = (map.getLayer(sid)?.metadata as { layerId?: string } | undefined)?.layerId;
      if (layerId) map.setLayoutProperty(sid, 'visibility', s.hidden[layerId] ? 'none' : 'visible');
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
    paintClusters(now);
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
      layers: [
        'aio-issues-focus',
        'aio-issues-cluster',
        'aio-issues-circle',
        'aio-drone-point',
        'aio-flights-line',
      ],
    })[0];
    const props = hit?.properties as
      { issueId?: string; layerId?: string; cluster_id?: number } | undefined;
    const st = store.getState();
    if (props?.cluster_id !== undefined && hit?.geometry.type === 'Point') {
      // Expand a badge: zoom to where it splits.
      const center = hit.geometry.coordinates as [number, number];
      const src = map.getSource<GeoJSONSource>(SRC.issues);
      void src?.getClusterExpansionZoom(props.cluster_id).then((zoom) => {
        map.easeTo({ center, zoom: Math.min(zoom, 20), duration: 400 });
      });
    } else if (props?.issueId) {
      st.select({ kind: 'issue', id: props.issueId });
    } else if (props?.layerId) {
      st.setActiveClip(props.layerId);
      st.select({ kind: 'clip', id: props.layerId });
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
    for (const id of [
      'aio-issues-circle',
      'aio-issues-cluster',
      'aio-issues-focus',
      'aio-flights-line',
      'aio-drone-point',
    ]) {
      map.on('mouseenter', id, () => {
        if (!drawing()) map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', id, () => {
        if (!drawing()) map.getCanvas().style.cursor = '';
      });
    }
    updateDraw();
    // Hover shows a pin's code wherever it is.
    map.on('mousemove', 'aio-issues-circle', (e) => {
      const id = (e.features?.[0]?.properties as { issueId?: string } | undefined)?.issueId;
      if (id && id !== hoverIssue) {
        hoverIssue = id;
        renderIssues(store.getState(), true);
      }
    });
    map.on('mouseleave', 'aio-issues-circle', () => {
      if (hoverIssue === null) return;
      hoverIssue = null;
      renderIssues(store.getState(), true);
    });

    let prev = store.getState();
    void openProject(prev);
    let frame = 0;
    cleanups.push(
      store.subscribe((s) => {
        const last = prev;
        prev = s;
        if (s.project !== last.project) {
          paintClusters(s);
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
    updateIssues: () => {
      if (ready) renderIssues(store.getState());
    },
    dispose: () => {
      disposed = true;
      for (const c of cleanups) c();
      map.remove();
    },
  };
}
