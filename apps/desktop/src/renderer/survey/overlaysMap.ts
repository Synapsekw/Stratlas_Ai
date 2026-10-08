/**
 * Terrain overlays on the map (M11 G5): a raster overlay (slope, elevation, relief) is its kit
 * pyramid's tiles as image sources at the finest level within a tile budget (`overlayTiles`), the
 * way the map draws raster layers; contours are a GeoJSON line source (major lines wider). Visible
 * overlays only; drawn under the measurements.
 */
import { localToProject, toWgs84 } from '@aio/geo';
import { overlayTiles, type MapController, type PyramidIndex } from '@aio/maps';
import type { SurveyOverlay, Vec3 } from '@aio/schema';
import { assetUrl, workspace } from '@aio/workspace';
import { overlays } from './overlaysStore';

const PREFIX = 'aio-ov-';
const MAX_TILES = 64;

type Quad = [[number, number], [number, number], [number, number], [number, number]];

interface Drawn {
  key: string;
  ids: string[];
}

async function fetchJson(projectId: string, path: string): Promise<unknown> {
  const r = await fetch(assetUrl(projectId, { path }));
  if (!r.ok) throw new Error(`${path} answered ${String(r.status)}`);
  return (await r.json()) as unknown;
}

export function attachOverlaysMap(ctl: MapController, epsg: number | null): () => void {
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const drawn = new Map<string, Drawn>();
  let gen = 0;
  let disposed = false;

  const lngLat = (e: number, n: number): [number, number] => {
    const p = toWgs84([e, n, 0], epsg);
    return [p[0], p[1]];
  };
  const before = () => (map.getLayer('aio-survey-fill') ? 'aio-survey-fill' : undefined);

  const remove = (d: Drawn) => {
    for (const id of [...d.ids].reverse()) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
  };

  async function add(projectId: string, o: SurveyOverlay, origin: Vec3): Promise<string[]> {
    const ids: string[] = [];
    if (o.kind === 'contours') {
      const doc = (await fetchJson(projectId, `${o.dir}/contours.geojson`)) as {
        features: {
          properties: { levelM: number; major: boolean };
          geometry: { coordinates: number[][] };
        }[];
      };
      const data = {
        type: 'FeatureCollection',
        features: doc.features.map((f) => ({
          type: 'Feature',
          properties: f.properties,
          geometry: {
            type: 'LineString',
            coordinates: f.geometry.coordinates.map((c) => lngLat(c[0] ?? 0, c[1] ?? 0)),
          },
        })),
      };
      const id = `${PREFIX}${o.id}`;
      map.addSource(id, { type: 'geojson', data: data as never });
      map.addLayer(
        {
          id,
          type: 'line',
          source: id,
          metadata: { overlay: o.id },
          paint: {
            'line-color': (o.options.color as string | undefined) ?? '#f2e8cf',
            'line-width': ['case', ['get', 'major'], 2, 0.8],
            'line-opacity': ['case', ['get', 'major'], 0.95, 0.7],
          },
        },
        before(),
      );
      ids.push(id);
      return ids;
    }
    const tiles = (await fetchJson(projectId, `${o.dir}/tiles.json`)) as PyramidIndex;
    const toLl = (l: Vec3) => {
      const p = localToProject(l, origin);
      return lngLat(p[0], p[1]);
    };
    overlayTiles(tiles, MAX_TILES).forEach((t, k) => {
      const { tl, tr, bl } = t.corners;
      const br: Vec3 = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]];
      const quad: Quad = [toLl(tl), toLl(tr), toLl(br), toLl(bl)];
      const id = `${PREFIX}${o.id}-${String(k)}`;
      map.addSource(id, {
        type: 'image',
        url: assetUrl(projectId, { path: t.path }),
        coordinates: quad,
      });
      map.addLayer(
        {
          id,
          type: 'raster',
          source: id,
          metadata: { overlay: o.id },
          paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 },
        },
        before(),
      );
      ids.push(id);
    });
    return ids;
  }

  const sync = async () => {
    const my = ++gen;
    const project = workspace.getState().project;
    const file = overlays.getState().file;
    try {
      if (!map.isStyleLoaded()) return;
    } catch {
      return;
    }
    const want = new Map<string, SurveyOverlay>();
    if (project && file && overlays.getState().projectId === project.id)
      for (const o of file.overlays) if (o.visible) want.set(`${o.id}|${o.fingerprint}`, o);
    for (const [id, d] of drawn)
      if (!want.has(d.key)) {
        remove(d);
        drawn.delete(id);
      }
    if (!project) return;
    for (const [key, o] of want) {
      if (drawn.get(o.id)?.key === key) continue;
      // claimed before the fetch, so a sync that starts meanwhile does not add it twice
      const entry: Drawn = { key, ids: [] };
      drawn.set(o.id, entry);
      try {
        entry.ids = await add(project.id, o, project.manifest.origin);
        if (disposed || drawn.get(o.id) !== entry) remove(entry);
      } catch (e) {
        if (drawn.get(o.id) === entry) drawn.delete(o.id);
        console.warn(`Map: overlay ${o.id} not shown`, e);
      }
      if (disposed || my !== gen) return;
    }
  };
  const onStyle = () => {
    // a new style dropped every source: draw everything again
    if (
      drawn.size &&
      !drawn
        .values()
        .next()
        .value?.ids.every((id) => map.getLayer(id))
    )
      drawn.clear();
    void sync();
  };
  map.on('styledata', onStyle);
  const off = overlays.subscribe((s, prev) => {
    if (s.file !== prev.file || s.projectId !== prev.projectId) void sync();
  });
  void sync();
  return () => {
    disposed = true;
    off();
    map.off('styledata', onStyle);
    try {
      for (const d of drawn.values()) remove(d);
    } catch {
      // the map is going away
    }
    drawn.clear();
  };
}
