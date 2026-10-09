/**
 * The site's designs in the views (M11 G6, DSN-1): every visible, not archived layer of
 * `survey/designs.json`, read from its normalised file and drawn in the 3D site view (three.js
 * objects in one group, never pickable) and on the 2D map (one GeoJSON source). Surfaces are their
 * `.tin` triangles (translucent) and outline at the layer's vertical offset; linework is drawn at
 * its heights, or on the terrain when the layer is clamped; points at their heights; alignments on
 * the terrain with a tick and a station label at every interval. Files are read once per project
 * and kept while their layer is shown; a change in the Designs panel redraws at once.
 */
import type { EngineStage } from '@aio/engine';
import { toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import type { DesignEntry, DesignLayer, DesignLayerKind } from '@aio/schema';
import { parseTin } from '@aio/survey';
import { assetUrl } from '@aio/workspace';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Line,
  Mesh,
  MeshLambertMaterial,
  Points,
  PointsMaterial,
  Uint32BufferAttribute,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { createStore } from 'zustand/vanilla';
import {
  alignmentDrawing,
  designPoints,
  drape,
  lineworkLines,
  tinOutline,
  type AlignmentDrawing,
  type DesignPoint,
  type P2,
  type P3,
} from './designsGeometry';
import { designs, loadAlignment, type DesignsState } from './designsStore';
import type { Frame } from './measureScene';

/** Colours by layer kind (distinct from the measurements' and the heat maps'). */
export const DESIGN_COLOURS: Record<DesignLayerKind, string> = {
  surface: '#e0b54a',
  linework: '#ff8a3d',
  points: '#ffd84d',
  alignment: '#e05dc4',
};

interface Parsed {
  tin?: { vertices: Float64Array; triangles: Uint32Array; outline: number[][] };
  lines?: P3[][];
  points?: DesignPoint[];
  alignment?: AlignmentDrawing;
}

/** One layer to draw, with the settings it is drawn with now. */
export interface DrawLayer extends Parsed {
  ref: string;
  kind: DesignLayerKind;
  name: string;
  offsetM: number;
  clamp: boolean;
}

export interface DesignsView {
  layers: DrawLayer[];
  /** Layers whose file could not be read, with the reason. */
  problems: string[];
}

export const designsView = createStore<DesignsView>()(() => ({ layers: [], problems: [] }));

const designPath = (d: DesignEntry, file: string) => `survey/designs/${d.id}/${file}`;

async function fetchOk(projectId: string, path: string): Promise<Response> {
  const r = await fetch(assetUrl(projectId, { path }));
  if (!r.ok) throw new Error(`Could not read ${path} (${String(r.status)}).`);
  return r;
}

async function parseLayer(projectId: string, d: DesignEntry, l: DesignLayer): Promise<Parsed> {
  if (l.kind === 'alignment') {
    const al = await loadAlignment(projectId, d, l);
    return { alignment: alignmentDrawing(al, al.intervalM ? { intervalM: al.intervalM } : {}) };
  }
  const r = await fetchOk(projectId, designPath(d, l.file));
  if (l.kind === 'surface') {
    const tin = parseTin(await r.arrayBuffer());
    return {
      tin: {
        vertices: tin.vertices,
        triangles: tin.triangles,
        outline: tinOutline(tin.triangles, tin.header.vertexCount),
      },
    };
  }
  const json = (await r.json()) as unknown;
  return l.kind === 'linework' ? { lines: lineworkLines(json) } : { points: designPoints(json) };
}

const intervalOf = (l: DesignLayer) => {
  const v = (l as { intervalM?: unknown }).intervalM;
  return typeof v === 'number' ? v : 0;
};

let cacheProject: string | null = null;
const cache = new Map<string, Promise<Parsed>>();
let token = 0;

/** Read the shown layers' files (cached) and publish what to draw. */
async function sync(s: DesignsState): Promise<void> {
  const mine = ++token;
  const projectId = s.projectId;
  if (projectId !== cacheProject) {
    cache.clear();
    cacheProject = projectId;
  }
  if (!projectId || !s.file) {
    designsView.setState({ layers: [], problems: [] });
    return;
  }
  const shown = s.file.designs.flatMap((d) =>
    d.layers.filter((l) => l.visible && !l.archived).map((l) => ({ d, l })),
  );
  const problems: string[] = [];
  const layers: DrawLayer[] = [];
  for (const { d, l } of shown) {
    const key = `${d.id}/${l.id}/${l.file}/${String(intervalOf(l))}`;
    let p = cache.get(key);
    if (!p) {
      p = parseLayer(projectId, d, l);
      cache.set(key, p);
    }
    try {
      const parsed = await p;
      layers.push({
        ...parsed,
        ref: `${d.id}/${l.id}`,
        kind: l.kind,
        name: l.name,
        offsetM: l.verticalOffsetM,
        clamp: l.clamp ?? false,
      });
    } catch (e) {
      cache.delete(key);
      problems.push(`${l.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (mine === token) designsView.setState({ layers, problems });
}

let following: (() => void) | null = null;
/** Follow the designs store (once); returns the stop. */
export function followDesigns(): () => void {
  if (following) return following;
  const off = designs.subscribe((s, prev) => {
    if (s.file !== prev.file || s.projectId !== prev.projectId) void sync(s);
  });
  void sync(designs.getState());
  following = () => {
    off();
    following = null;
  };
  return following;
}

// ---------------------------------------------------------------- 3D

type HeightAt = (e: number, n: number) => number | null;

/** The 3D objects of one layer, in the local frame. */
export function layerObjects(
  layer: DrawLayer,
  frame: Frame,
  heightAt: HeightAt | null,
  groundZ: number,
): Object3D[] {
  const colour = DESIGN_COLOURS[layer.kind];
  const out: Object3D[] = [];
  const segments = (pairs: number[]) => {
    if (pairs.length < 6) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pairs, 3));
    const ls = new LineSegments(
      g,
      new LineBasicMaterial({ color: colour, depthTest: false, transparent: true }),
    );
    ls.renderOrder = 37;
    out.push(ls);
  };
  const pairsOf = (lines: readonly (readonly P3[])[]) => {
    const pairs: number[] = [];
    for (const l of lines)
      for (let i = 0; i + 1 < l.length; i++) {
        const a = l[i];
        const b = l[i + 1];
        if (a && b) pairs.push(...frame.toLocal(a), ...frame.toLocal(b));
      }
    return pairs;
  };
  if (layer.tin) {
    const { vertices, triangles, outline } = layer.tin;
    const pos = new Float32Array(vertices.length);
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      const l = frame.toLocal([
        vertices[i] ?? 0,
        vertices[i + 1] ?? 0,
        (vertices[i + 2] ?? 0) + layer.offsetM,
      ]);
      pos[i] = l[0];
      pos[i + 1] = l[1];
      pos[i + 2] = l[2];
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setIndex(new Uint32BufferAttribute(triangles, 1));
    g.computeVertexNormals();
    const mesh = new Mesh(
      g,
      new MeshLambertMaterial({
        color: colour,
        transparent: true,
        opacity: 0.5,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.renderOrder = 36;
    out.push(mesh);
    const at = (k: number): P3 => [
      vertices[3 * k] ?? 0,
      vertices[3 * k + 1] ?? 0,
      (vertices[3 * k + 2] ?? 0) + layer.offsetM,
    ];
    segments(pairsOf(outline.map((c) => c.map(at))));
  }
  if (layer.lines) {
    const lines = layer.lines.map((l) =>
      l.map(([e, n, z]): P3 => [e, n, layer.clamp ? (heightAt?.(e, n) ?? z) : z + layer.offsetM]),
    );
    segments(pairsOf(lines));
  }
  if (layer.points?.length) {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new Float32BufferAttribute(
        layer.points.flatMap((p) => frame.toLocal([p.p[0], p.p[1], p.p[2] + layer.offsetM])),
        3,
      ),
    );
    const pts = new Points(
      g,
      new PointsMaterial({
        color: colour,
        size: 7,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
      }),
    );
    pts.renderOrder = 38;
    out.push(pts);
  }
  if (layer.alignment) {
    const line = drape(layer.alignment.line, heightAt, groundZ);
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new Float32BufferAttribute(
        line.flatMap((p) => frame.toLocal(p)),
        3,
      ),
    );
    const cl = new Line(
      g,
      new LineBasicMaterial({ color: colour, depthTest: false, transparent: true }),
    );
    cl.renderOrder = 38;
    out.push(cl);
    segments(pairsOf(layer.alignment.ticks.map((t) => drape([t.a, t.b], heightAt, groundZ))));
  }
  for (const o of out) {
    o.frustumCulled = false;
    o.raycast = () => undefined;
    o.userData.designRef = layer.ref;
  }
  return out;
}

/** Labels shown in the 3D view at most (a long alignment shows every k-th station). */
const MAX_LABELS = 300;

/** Draw the shown design layers in the 3D stage; returns the detach. */
export function attachDesigns3d(
  stage: EngineStage,
  frame: Frame,
  heightAt: HeightAt | null,
  groundZ: number,
): () => void {
  const group = new Group();
  group.name = 'aio-designs';
  stage.scene.add(group);
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const labelBox = document.createElement('div');
  labelBox.className = 'sv-labels';
  labelBox.setAttribute('aria-hidden', 'true');
  host.appendChild(labelBox);
  let labels: { text: string; p: P3 }[] = [];
  const clear = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const o = c as Mesh;
      o.geometry.dispose();
      (o.material as Material).dispose();
    }
  };
  const rebuild = () => {
    clear();
    labels = [];
    for (const layer of designsView.getState().layers) {
      for (const o of layerObjects(layer, frame, heightAt, groundZ)) group.add(o);
      const ticks = layer.alignment?.ticks ?? [];
      const every = Math.max(1, Math.ceil(ticks.length / MAX_LABELS));
      for (let i = 0; i < ticks.length; i += every) {
        const t = ticks[i];
        if (t) labels.push({ text: t.label, p: drape([t.at], heightAt, groundZ)[0] ?? [0, 0, 0] });
      }
    }
    while (labelBox.children.length > labels.length) labelBox.lastChild?.remove();
    while (labelBox.children.length < labels.length) {
      const el = document.createElement('span');
      el.className = 'sv-label dsn-station';
      labelBox.appendChild(el);
    }
    labels.forEach((l, i) => {
      const el = labelBox.children[i] as HTMLElement;
      el.textContent = l.text;
    });
    stage.requestRender();
  };
  const tmp = new Vector3();
  const place = () => {
    if (labels.length === 0) return;
    const r = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    labels.forEach((l, i) => {
      const el = labelBox.children[i] as HTMLElement | undefined;
      if (!el) return;
      const loc = frame.toLocal(l.p);
      tmp.set(loc[0], loc[1], loc[2]).project(stage.camera);
      const x = r.left + ((tmp.x + 1) / 2) * r.width;
      const y = r.top + ((1 - tmp.y) / 2) * r.height;
      if (tmp.z > 1 || x < r.left || x > r.right || y < r.top || y > r.bottom) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.transform = `translate(${String(Math.round(x - hr.left))}px, ${String(Math.round(y - hr.top))}px)`;
    });
  };
  const offFrame = stage.onFrame(place);
  const off = designsView.subscribe(rebuild);
  rebuild();
  // the terrain may load after the designs: drape again a little later
  const again = [setTimeout(rebuild, 2000), setTimeout(rebuild, 8000)];
  return () => {
    for (const t of again) clearTimeout(t);
    off();
    offFrame();
    clear();
    labelBox.remove();
    stage.scene.remove(group);
    stage.requestRender();
  };
}

// ---------------------------------------------------------------- 2D

export const DESIGNS_SOURCE = 'aio-designs';
export const DESIGNS_LAYERS = {
  line: 'aio-designs-line',
  point: 'aio-designs-point',
  label: 'aio-designs-label',
} as const;

/** The map features of the shown layers (lines, points and station labels), in WGS84. */
export function designFeatures(layers: readonly DrawLayer[], epsg: number): unknown[] {
  const ll = (p: readonly number[]): [number, number] => {
    const w = toWgs84([p[0] ?? 0, p[1] ?? 0, 0], epsg);
    return [w[0], w[1]];
  };
  const features: unknown[] = [];
  const lineFeature = (layer: DrawLayer, coords: readonly (readonly number[])[]) => {
    if (coords.length < 2) return;
    features.push({
      type: 'Feature',
      properties: { ref: layer.ref, kind: layer.kind, color: DESIGN_COLOURS[layer.kind] },
      geometry: { type: 'LineString', coordinates: coords.map(ll) },
    });
  };
  for (const layer of layers) {
    if (layer.tin) {
      const v = layer.tin.vertices;
      for (const chain of layer.tin.outline)
        lineFeature(
          layer,
          chain.map((k): P2 => [v[3 * k] ?? 0, v[3 * k + 1] ?? 0]),
        );
    }
    for (const l of layer.lines ?? []) lineFeature(layer, l);
    for (const p of layer.points ?? [])
      features.push({
        type: 'Feature',
        properties: { ref: layer.ref, kind: layer.kind, color: DESIGN_COLOURS[layer.kind] },
        geometry: { type: 'Point', coordinates: ll(p.p) },
      });
    if (layer.alignment) {
      lineFeature(layer, layer.alignment.line);
      for (const t of layer.alignment.ticks) {
        lineFeature(layer, [t.a, t.b]);
        features.push({
          type: 'Feature',
          properties: { ref: layer.ref, kind: 'station', label: t.label },
          geometry: { type: 'Point', coordinates: ll(t.at) },
        });
      }
    }
  }
  return features;
}

/** Draw the shown design layers on the map; returns the detach. */
export function attachDesignsMap(ctl: MapController, frame: Frame): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const data = () => ({
    type: 'FeatureCollection',
    features: designFeatures(designsView.getState().layers, epsg),
  });
  // sources still loading (rasters): draw again once the map is idle
  let waiting = false;
  const draw = () => {
    try {
      waiting = !map.isStyleLoaded();
      if (waiting) return;
      const src = map.getSource(DESIGNS_SOURCE) as { setData?: (d: unknown) => void } | undefined;
      if (src?.setData) src.setData(data());
      else map.addSource(DESIGNS_SOURCE, { type: 'geojson', data: data() as never });
      if (!map.getLayer(DESIGNS_LAYERS.line))
        map.addLayer({
          id: DESIGNS_LAYERS.line,
          type: 'line',
          source: DESIGNS_SOURCE,
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
        });
      if (!map.getLayer(DESIGNS_LAYERS.point))
        map.addLayer({
          id: DESIGNS_LAYERS.point,
          type: 'circle',
          source: DESIGNS_SOURCE,
          filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'kind'], 'station']],
          paint: {
            'circle-radius': 4,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#000000',
            'circle-stroke-width': 1,
          },
        });
      if (!map.getLayer(DESIGNS_LAYERS.label))
        map.addLayer({
          id: DESIGNS_LAYERS.label,
          type: 'symbol',
          source: DESIGNS_SOURCE,
          filter: ['==', ['get', 'kind'], 'station'],
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Medium'],
            'text-size': 11,
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
  const onStyle = () => {
    draw();
  };
  const onIdle = () => {
    if (waiting) draw();
  };
  map.on('styledata', onStyle);
  map.on('idle', onIdle);
  const off = designsView.subscribe(draw);
  draw();
  return () => {
    off();
    map.off('styledata', onStyle);
    map.off('idle', onIdle);
    try {
      for (const id of Object.values(DESIGNS_LAYERS)) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(DESIGNS_SOURCE)) map.removeSource(DESIGNS_SOURCE);
    } catch {
      // the map is going away
    }
  };
}
