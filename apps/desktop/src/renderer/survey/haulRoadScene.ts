/**
 * The selected haul-road run in the views (M11 G11): its centreline in pieces coloured by pass
 * (green), fail (red) or no data (grey), as three.js lines over the 3D site view and a GeoJSON
 * line layer on the 2D map. Site points (E, N, Z) in the project CRS go through the measurement
 * frame (`measureScene.ts`).
 */
import type { EngineStage } from '@aio/engine';
import { toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial } from 'three';
import { haul, type HaulState } from './haulRoadStore';
import type { Frame } from './measureScene';

const changed = (s: HaulState, prev: HaulState) =>
  s.pieces !== prev.pieces || s.shown !== prev.shown;

/** Draw the selected run in the 3D stage; returns the detach. */
export function attachHaul3d(stage: EngineStage, frame: Frame): () => void {
  const group = new Group();
  group.name = 'aio-haul-road';
  group.renderOrder = 39;
  stage.scene.add(group);
  const clear = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const l = c as Line;
      l.geometry.dispose();
      (l.material as LineBasicMaterial).dispose();
    }
  };
  const rebuild = () => {
    clear();
    const s = haul.getState();
    if (s.shown)
      for (const p of s.pieces) {
        const g = new BufferGeometry();
        g.setAttribute(
          'position',
          new Float32BufferAttribute(
            p.points.flatMap((q) => frame.toLocal(q)),
            3,
          ),
        );
        const line = new Line(
          g,
          new LineBasicMaterial({ color: p.color, depthTest: false, transparent: true }),
        );
        line.renderOrder = 39;
        line.frustumCulled = false;
        line.raycast = () => undefined;
        group.add(line);
      }
    stage.requestRender();
  };
  const off = haul.subscribe((s, prev) => {
    if (changed(s, prev)) rebuild();
  });
  rebuild();
  return () => {
    off();
    clear();
    stage.scene.remove(group);
    stage.requestRender();
  };
}

const SRC = 'aio-haul-road';
const LAYER = 'aio-haul-road-line';

/** Draw the selected run on the map; returns the detach. */
export function attachHaulMap(ctl: MapController, frame: Frame): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const data = () => {
    const s = haul.getState();
    return {
      type: 'FeatureCollection',
      features: s.shown
        ? s.pieces.map((p) => ({
            type: 'Feature',
            properties: { color: p.color, station: p.station, status: p.status },
            geometry: {
              type: 'LineString',
              coordinates: p.points.map((q) => {
                const ll = toWgs84(q, epsg);
                return [ll[0], ll[1]];
              }),
            },
          }))
        : [],
    };
  };
  const draw = () => {
    try {
      if (!map.isStyleLoaded()) return;
      const src = map.getSource(SRC) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(data());
      else map.addSource(SRC, { type: 'geojson', data: data() as never });
      if (!map.getLayer(LAYER))
        map.addLayer({
          id: LAYER,
          type: 'line',
          source: SRC,
          paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
        });
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  };
  const onStyle = () => {
    draw();
  };
  map.on('styledata', onStyle);
  const off = haul.subscribe((s, prev) => {
    if (changed(s, prev)) draw();
  });
  draw();
  return () => {
    off();
    map.off('styledata', onStyle);
    try {
      if (map.getLayer(LAYER)) map.removeLayer(LAYER);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {
      // the map is going away
    }
  };
}
