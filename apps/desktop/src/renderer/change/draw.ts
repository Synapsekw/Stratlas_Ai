/**
 * Drawing "Show changes": change pins in a 3D view (screen-sized sprites, the selected one ringed)
 * and on a map (a GeoJSON circle layer). One date per view; see `@aio/change` `changeMarkers`.
 */
import type { ChangeMarker } from '@aio/change';
import type { SceneHandle } from '@aio/engine';
import { localToProject, toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { ProjectManifest, Vec3 } from '@aio/schema';
import { CanvasTexture, Group, Sprite, SpriteMaterial } from 'three';

let disc: CanvasTexture | null = null;
let ring: CanvasTexture | null = null;

function texture(kind: 'disc' | 'ring'): CanvasTexture {
  const cached = kind === 'disc' ? disc : ring;
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.beginPath();
    g.arc(32, 32, kind === 'disc' ? 22 : 28, 0, Math.PI * 2);
    if (kind === 'disc') {
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 5;
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.stroke();
    } else {
      g.lineWidth = 6;
      g.strokeStyle = '#ffffff';
      g.stroke();
    }
  }
  const t = new CanvasTexture(c);
  if (kind === 'disc') disc = t;
  else ring = t;
  return t;
}

/** Pins of one view in a 3D scene; returns the function that removes them. */
export function drawPins3d(scene: SceneHandle, markers: readonly ChangeMarker[]): () => void {
  const group = new Group();
  group.name = 'aio-change-pins';
  group.renderOrder = 999;
  for (const m of markers) {
    const mat = new SpriteMaterial({
      map: texture('disc'),
      color: m.color,
      depthTest: false,
      transparent: true,
      opacity: m.ghost ? 0.35 : 1,
      sizeAttenuation: false,
    });
    const s = new Sprite(mat);
    s.position.set(m.p[0], m.p[1], m.p[2]);
    const size = m.selected ? 0.034 : 0.022;
    s.scale.set(size, size, 1);
    s.renderOrder = 999;
    s.userData = { changeId: m.id, verdict: m.verdict };
    group.add(s);
    if (m.selected) {
      const r = new Sprite(
        new SpriteMaterial({
          map: texture('ring'),
          color: '#ffffff',
          depthTest: false,
          transparent: true,
          sizeAttenuation: false,
        }),
      );
      r.position.copy(s.position);
      r.scale.set(0.055, 0.055, 1);
      r.renderOrder = 1000;
      group.add(r);
    }
  }
  scene.scene.add(group);
  scene.requestRender();
  return () => {
    scene.scene.remove(group);
    for (const c of group.children) if (c instanceof Sprite) c.material.dispose();
    scene.requestRender();
  };
}

/** Local frame to lon/lat, when the project CRS is a known EPSG code. */
export function localToLonLat(
  manifest: Pick<ProjectManifest, 'crs' | 'origin'>,
): ((p: Vec3) => [number, number]) | null {
  const epsg = 'epsg' in manifest.crs ? manifest.crs.epsg : undefined;
  if (epsg === undefined) return null;
  return (p) => {
    const [lon, lat] = toWgs84(localToProject(p, manifest.origin), epsg);
    return [lon, lat];
  };
}

const SOURCE = 'aio-change';
const LAYERS = ['aio-change-sel', 'aio-change-pins'];

/** Pins of one view on a map; returns the function that removes them. */
export function drawPinsMap(
  ctl: MapController,
  markers: readonly ChangeMarker[],
  toLonLat: (p: Vec3) => [number, number],
): () => void {
  const map = ctl.map;
  const data = {
    type: 'FeatureCollection' as const,
    features: markers.map((m) => ({
      type: 'Feature' as const,
      properties: {
        id: m.id,
        color: m.color,
        opacity: m.ghost ? 0.35 : 1,
        selected: m.selected ? 1 : 0,
      },
      geometry: { type: 'Point' as const, coordinates: toLonLat(m.p) },
    })),
  };
  const add = () => {
    try {
      if (!map.isStyleLoaded()) return;
      const src = map.getSource(SOURCE) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(data);
      else map.addSource(SOURCE, { type: 'geojson', data });
      if (!map.getLayer('aio-change-sel'))
        map.addLayer({
          id: 'aio-change-sel',
          type: 'circle',
          source: SOURCE,
          filter: ['==', ['get', 'selected'], 1],
          paint: {
            'circle-radius': 13,
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3,
          },
        });
      if (!map.getLayer('aio-change-pins'))
        map.addLayer({
          id: 'aio-change-pins',
          type: 'circle',
          source: SOURCE,
          paint: {
            'circle-radius': ['case', ['==', ['get', 'selected'], 1], 8, 6],
            'circle-color': ['get', 'color'],
            'circle-opacity': ['get', 'opacity'],
            'circle-stroke-color': 'rgba(0,0,0,0.6)',
            'circle-stroke-width': 1.5,
          },
        });
    } catch {
      // the style is being replaced: the next styledata adds them again
    }
  };
  add();
  map.on('styledata', add);
  return () => {
    map.off('styledata', add);
    try {
      for (const l of LAYERS) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    } catch {
      // the map is gone
    }
  };
}
