/**
 * Hydrology on the 2D map (M11 G10): the selected run's outputs (the flood outline and its depth
 * view, the runoff path with an optional animated drop, catchments and streams, the rainfall
 * depth frame) and a click to pick a point for the panel. Run files are GeoJSON in the project CRS
 * and colour PNGs with project-CRS bounds; both are placed with `toWgs84` (`@aio/geo`).
 */
import { fromWgs84, toWgs84 } from '@aio/geo';
import type { HydroRun } from '@aio/schema';
import type { MapController } from '@aio/maps';
import { hydro, picked, runFileUrl, selectedRun, type HydroState } from './hydroStore';

const SRC = 'aio-hydro';
const IMG = 'aio-hydro-img';
const LAYERS = ['aio-hydro-fill', 'aio-hydro-line', 'aio-hydro-pt'] as const;
const WATER = '#1f8fff';
const PATH = '#ff7a1a';
const STREAM = '#36c5f0';
const CATCHMENT = '#ffd166';

interface MapMouse {
  lngLat: { lng: number; lat: number };
}

interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

/** A position (E, N, ...) in lon/lat. */
function lonLat(p: readonly number[], epsg: number): [number, number] {
  const ll = toWgs84([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], epsg);
  return [ll[0], ll[1]];
}

/** GeoJSON geometry coordinates of any depth (positions are arrays of numbers) in lon/lat. */
function reproject(c: unknown, epsg: number): unknown {
  if (!Array.isArray(c)) return c;
  if (typeof c[0] === 'number') return lonLat(c as number[], epsg);
  return c.map((x) => reproject(x, epsg));
}

/** The files a run draws as vectors, with their colour. */
function vectorFiles(run: HydroRun): { file: string; color: string; kind: string }[] {
  const f = run.files;
  const out: { file: string; color: string; kind: string }[] = [];
  if (f.outline) out.push({ file: f.outline, color: WATER, kind: 'outline' });
  if (f.catchments) out.push({ file: f.catchments, color: CATCHMENT, kind: 'catchment' });
  if (f.streams) out.push({ file: f.streams, color: STREAM, kind: 'stream' });
  if (f.path) out.push({ file: f.path, color: PATH, kind: 'path' });
  return out;
}

/** The colour image of the run as shown: the rainfall frame, else the run's own view. */
function imageOf(run: HydroRun, frame: number): { file: string; bounds: number[] } | null {
  const view = run.files.view;
  if (run.pipeline === 'hydro.rainfall') {
    const f = run.results.frames[Math.min(frame, run.results.frames.length - 1)];
    if (f && view) return { file: f.view, bounds: view.bounds };
  }
  return view ? { file: view.file, bounds: view.bounds } : null;
}

/** Draw the selected run on the map and take picks from it. Returns the detach. */
export function attachHydroMap(ctl: MapController, projectId: string, epsg: number): () => void {
  const map = ctl.map;
  const canvas = map.getCanvas();
  let features: Feature[] = [];
  let shown: string | null = null;
  let token = 0;
  let detached = false;

  const loadVectors = async (run: HydroRun | null) => {
    const mine = ++token;
    if (!run) {
      features = [];
      draw();
      return;
    }
    const all: Feature[] = [];
    for (const v of vectorFiles(run)) {
      try {
        const r = await fetch(runFileUrl(projectId, run, v.file));
        if (!r.ok) continue;
        const gj = (await r.json()) as { features?: Feature[] };
        for (const f of gj.features ?? [])
          all.push({
            type: 'Feature',
            properties: { color: v.color, kind: v.kind },
            geometry: {
              type: f.geometry.type,
              coordinates: reproject(f.geometry.coordinates, epsg),
            },
          });
      } catch {
        // a missing or damaged file is left out
      }
    }
    if (run.pipeline === 'hydro.flow') {
      for (const o of run.results.outlets ?? [])
        all.push({
          type: 'Feature',
          properties: { color: CATCHMENT, kind: 'pour' },
          geometry: { type: 'Point', coordinates: lonLat(o.pourPoint, epsg) },
        });
      const p = run.results.path;
      if (p)
        all.push({
          type: 'Feature',
          properties: { color: PATH, kind: 'drop' },
          geometry: { type: 'Point', coordinates: lonLat(p.start, epsg) },
        });
    }
    if (mine !== token) return;
    features = all;
    draw();
  };

  const drawImage = (s: HydroState) => {
    const run = selectedRun(s);
    const img = run ? imageOf(run, s.frame) : null;
    const key = img && run ? `${run.id}/${img.file}` : null;
    const present = map.getSource(IMG) !== undefined;
    if (key !== null && key === shown && present) return;
    if (key === null && !present && !map.getLayer(IMG)) {
      shown = null;
      return;
    }
    if (map.getLayer(IMG)) map.removeLayer(IMG);
    if (map.getSource(IMG)) map.removeSource(IMG);
    shown = key;
    if (!img || !run) return;
    const [w = 0, s0 = 0, e = 0, n = 0] = img.bounds;
    map.addSource(IMG, {
      type: 'image',
      url: runFileUrl(projectId, run, img.file),
      coordinates: [
        lonLat([w, n], epsg),
        lonLat([e, n], epsg),
        lonLat([e, s0], epsg),
        lonLat([w, s0], epsg),
      ],
    });
    map.addLayer(
      {
        id: IMG,
        type: 'raster',
        source: IMG,
        paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 },
      },
      map.getLayer(LAYERS[0]) ? LAYERS[0] : undefined,
    );
  };

  let waiting = false;
  function draw() {
    try {
      if (!map.isStyleLoaded()) {
        // sources still loading (the rasters): draw once the map is idle
        if (!waiting) {
          waiting = true;
          map.once('idle', () => {
            waiting = false;
            if (!detached) draw();
          });
        }
        return;
      }
      drawImage(hydro.getState());
      const data = { type: 'FeatureCollection', features };
      const src = map.getSource(SRC) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(data);
      else map.addSource(SRC, { type: 'geojson', data: data as never });
      if (!map.getLayer(LAYERS[0]))
        map.addLayer({
          id: LAYERS[0],
          type: 'fill',
          source: SRC,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 },
        });
      if (!map.getLayer(LAYERS[1]))
        map.addLayer({
          id: LAYERS[1],
          type: 'line',
          source: SRC,
          filter: ['!=', ['geometry-type'], 'Point'],
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['match', ['get', 'kind'], 'path', 3, 'stream', 2, 2],
          },
        });
      if (!map.getLayer(LAYERS[2]))
        map.addLayer({
          id: LAYERS[2],
          type: 'circle',
          source: SRC,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 5,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#000000',
            'circle-stroke-width': 1,
          },
        });
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  }

  const onClick = (e: MapMouse) => {
    if (!hydro.getState().pick) return;
    const [east, north] = fromWgs84([e.lngLat.lng, e.lngLat.lat, 0], epsg);
    void picked(east, north);
  };
  const onStyle = () => {
    draw();
  };
  map.on('click', onClick as never);
  map.on('styledata', onStyle);
  const off = hydro.subscribe((s, prev) => {
    if (s.selected !== prev.selected || s.runs !== prev.runs) void loadVectors(selectedRun(s));
    else if (s.frame !== prev.frame) draw();
    canvas.style.cursor = s.pick ? 'crosshair' : '';
  });
  void loadVectors(selectedRun(hydro.getState()));
  return () => {
    detached = true;
    off();
    token++;
    map.off('click', onClick as never);
    map.off('styledata', onStyle);
    canvas.style.cursor = '';
    try {
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
      if (map.getLayer(IMG)) map.removeLayer(IMG);
      if (map.getSource(IMG)) map.removeSource(IMG);
    } catch {
      // the map is going away
    }
  };
}
