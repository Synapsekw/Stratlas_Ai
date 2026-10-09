/**
 * Difference heat maps of the focused polygon (M11 G4): 3D on the terrain (a vertex-coloured mesh
 * at the surface's heights, lifted a few centimetres) and 2D on the map (a coloured image placed
 * at the grid's corners), with contours of the difference when asked. Drawn from the engine
 * worker's coarse grid (`HeatGrid`) with the site's stops (`@aio/survey` `heatRamp`); cells inside
 * the deadband are left clear.
 */
import type { EngineStage } from '@aio/engine';
import { toWgs84 } from '@aio/geo';
import type { MapController } from '@aio/maps';
import { colourGrid, contourSegments, heatRamp, niceInterval } from '@aio/survey';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Material,
} from 'three';
import { assetUrl } from '@aio/workspace';
import { compareStore, type CompareState, type SiteTiles } from './compareStore';
import type { HeatGrid } from './engineProtocol';
import { measureStore, type MeasureState } from './measureStore';
import type { Frame } from './measureScene';

const LIFT_M = 0.04;

/** The heat grid to draw now (the focused polygon's chosen item), or null. */
export function activeHeat(c: CompareState, s: MeasureState): HeatGrid | null {
  if (!s.focus) return null;
  const done = c.computed[s.focus];
  if (!done || done.heat.length === 0) return null;
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!m) return null;
  const id =
    c.heat.item && m.items.some((it) => it.id === c.heat.item) ? c.heat.item : m.items[0]?.id;
  return done.heat.find((h) => h.item === id) ?? null;
}

/** Contour interval for a difference grid: a round step giving about ten levels. */
export function contourInterval(h: HeatGrid): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of h.dz)
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  return lo === Infinity ? 0 : niceInterval(hi - lo);
}

export function attachHeat3d(stage: EngineStage, frame: Frame): () => void {
  const group = new Group();
  group.name = 'aio-survey-heat';
  group.renderOrder = 35;
  stage.scene.add(group);
  const clear = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      const o = c as Mesh | LineSegments;
      o.geometry.dispose();
      (o.material as Material).dispose();
    }
  };
  let last: unknown[] = [];
  const draw = () => {
    const c = compareStore.getState();
    const s = measureStore.getState();
    const h = c.heat.show3d ? activeHeat(c, s) : null;
    const key = [h, c.heat.contours, s.settings.heatmap];
    if (key.every((k, i) => k === last[i])) return;
    last = key;
    clear();
    if (h) {
      const ramp = heatRamp(s.settings.heatmap, 255);
      const { nx, ny, x0, y0, cellM } = h;
      const pos = new Float32Array(nx * ny * 3);
      const col = new Float32Array(nx * ny * 4);
      const ok = new Uint8Array(nx * ny);
      for (let r = 0; r < ny; r++)
        for (let i = 0; i < nx; i++) {
          const k = r * nx + i;
          const z = h.z[k] ?? NaN;
          const c4 = ramp.colorOf(h.dz[k] ?? NaN);
          if (!Number.isFinite(z) || !c4) continue;
          ok[k] = 1;
          const l = frame.toLocal([x0 + (i + 0.5) * cellM, y0 + (r + 0.5) * cellM, z + LIFT_M]);
          pos.set(l, k * 3);
          col.set([c4[0] / 255, c4[1] / 255, c4[2] / 255, 0.8], k * 4);
        }
      const index: number[] = [];
      for (let r = 0; r + 1 < ny; r++)
        for (let i = 0; i + 1 < nx; i++) {
          const a = r * nx + i;
          const b = a + 1;
          const c2 = a + nx;
          const d = c2 + 1;
          if (ok[a] && ok[b] && ok[d]) index.push(a, b, d);
          if (ok[a] && ok[d] && ok[c2]) index.push(a, d, c2);
        }
      if (index.length) {
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new Float32BufferAttribute(col, 4));
        g.setIndex(index);
        const mat = new MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          side: DoubleSide,
          depthWrite: false,
          // an overlay like the measurement lines: seen through a draped or lower terrain
          depthTest: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const mesh = new Mesh(g, mat);
        mesh.renderOrder = 35;
        mesh.raycast = () => undefined;
        group.add(mesh);
      }
      if (c.heat.contours) {
        const step = contourInterval(h);
        const segs: number[] = [];
        for (const lv of contourSegments(h.dz, nx, ny, step))
          for (const [ax, ay, bx, by] of lv.segments) {
            const at = (x: number, y: number) => {
              const k = Math.min(ny - 1, Math.round(y)) * nx + Math.min(nx - 1, Math.round(x));
              const z = h.z[k] ?? NaN;
              return frame.toLocal([
                x0 + (x + 0.5) * cellM,
                y0 + (y + 0.5) * cellM,
                (Number.isFinite(z) ? z : 0) + LIFT_M * 2,
              ]);
            };
            segs.push(...at(ax, ay), ...at(bx, by));
          }
        if (segs.length) {
          const g = new BufferGeometry();
          g.setAttribute('position', new Float32BufferAttribute(segs, 3));
          const lines = new LineSegments(
            g,
            new LineBasicMaterial({ color: '#111111', transparent: true, opacity: 0.8 }),
          );
          lines.raycast = () => undefined;
          lines.renderOrder = 36;
          group.add(lines);
        }
      }
    }
    stage.requestRender();
  };
  const offA = compareStore.subscribe(draw);
  const offB = measureStore.subscribe((s, p) => {
    if (s.focus !== p.focus || s.settings !== p.settings) draw();
  });
  draw();
  return () => {
    offA();
    offB();
    clear();
    stage.scene.remove(group);
    stage.requestRender();
  };
}

const SRC = 'aio-survey-heat';
const CONTOURS = 'aio-survey-heat-contours';

/** A grid's image as a data URL (north up). */
function imageOf(h: HeatGrid, s: MeasureState): string | null {
  const ramp = heatRamp(s.settings.heatmap, 210);
  const px = new Uint8ClampedArray(colourGrid(h.dz, h.nx, h.ny, ramp));
  const canvas = document.createElement('canvas');
  canvas.width = h.nx;
  canvas.height = h.ny;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(px, h.nx, h.ny), 0, 0);
  return canvas.toDataURL('image/png');
}

export function attachHeatMap(ctl: MapController, frame: Frame): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const ll = (e: number, n: number): [number, number] => {
    const p = toWgs84([e, n, 0], epsg);
    return [p[0], p[1]];
  };
  const remove = () => {
    try {
      for (const id of [`${CONTOURS}-line`, `${SRC}-layer`])
        if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [CONTOURS, SRC]) if (map.getSource(id)) map.removeSource(id);
    } catch {
      // the style is being replaced
    }
  };
  let last: unknown[] = [];
  const draw = (force = false) => {
    const c = compareStore.getState();
    const s = measureStore.getState();
    const h = c.heat.show2d ? activeHeat(c, s) : null;
    const key = [h, c.heat.contours, s.settings.heatmap];
    if (!force && key.every((k, i) => k === last[i])) return;
    last = key;
    try {
      if (!map.isStyleLoaded()) return;
      remove();
      if (!h) return;
      const url = imageOf(h, s);
      if (!url) return;
      const x1 = h.x0 + h.nx * h.cellM;
      const y1 = h.y0 + h.ny * h.cellM;
      map.addSource(SRC, {
        type: 'image',
        url,
        coordinates: [ll(h.x0, y1), ll(x1, y1), ll(x1, h.y0), ll(h.x0, h.y0)],
      });
      const before = map.getLayer('aio-survey-fill') ? 'aio-survey-fill' : undefined;
      map.addLayer(
        {
          id: `${SRC}-layer`,
          type: 'raster',
          source: SRC,
          paint: { 'raster-opacity': 0.85, 'raster-resampling': 'nearest' },
        },
        before,
      );
      if (c.heat.contours) {
        const step = contourInterval(h);
        const features = contourSegments(h.dz, h.nx, h.ny, step).flatMap((lv) =>
          lv.segments.map(([ax, ay, bx, by]) => ({
            type: 'Feature' as const,
            properties: { level: lv.level },
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                ll(h.x0 + (ax + 0.5) * h.cellM, h.y0 + (ay + 0.5) * h.cellM),
                ll(h.x0 + (bx + 0.5) * h.cellM, h.y0 + (by + 0.5) * h.cellM),
              ],
            },
          })),
        );
        map.addSource(CONTOURS, { type: 'geojson', data: { type: 'FeatureCollection', features } });
        map.addLayer(
          {
            id: `${CONTOURS}-line`,
            type: 'line',
            source: CONTOURS,
            paint: { 'line-color': '#111111', 'line-width': 1, 'line-opacity': 0.8 },
          },
          before,
        );
      }
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  };
  const onStyle = () => {
    if (!map.getSource(SRC)) draw(true);
  };
  map.on('styledata', onStyle);
  const offA = compareStore.subscribe(() => {
    draw();
  });
  const offB = measureStore.subscribe((s, p) => {
    if (s.focus !== p.focus || s.settings !== p.settings) draw();
  });
  draw(true);
  return () => {
    offA();
    offB();
    map.off('styledata', onStyle);
    remove();
  };
}

const SITE = 'aio-survey-site';
const DRAFTS = 'aio-survey-drafts';

/** The finest pyramid level with at most `max` tiles. */
export function siteLevel(t: SiteTiles, max = 16): SiteTiles['levels'][number] | null {
  let best: SiteTiles['levels'][number] | null = null;
  for (const lv of t.levels) if (lv.cols * lv.rows <= max && (!best || lv.z > best.z)) best = lv;
  return best;
}

/**
 * The whole-site job's heat map (its tile pyramid, placed tile by tile at the index's corners)
 * and the draft regions on the map.
 */
export function attachSiteMap(ctl: MapController, frame: Frame, projectId: string): () => void {
  const epsg = frame.epsg;
  if (epsg === null) return () => undefined;
  const map = ctl.map;
  const ll = (e: number, n: number): [number, number] => {
    const p = toWgs84([e, n, 0], epsg);
    return [p[0], p[1]];
  };
  let ids: string[] = [];
  const remove = () => {
    try {
      for (const id of [`${DRAFTS}-line`, ...ids.map((x) => `${x}-layer`)])
        if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [DRAFTS, ...ids]) if (map.getSource(id)) map.removeSource(id);
    } catch {
      // the style is being replaced
    }
    ids = [];
  };
  let last: unknown = null;
  const draw = (force = false) => {
    const site = compareStore.getState().site;
    const key = site
      ? `${site.out}|${String(site.tiles !== null)}|${String(site.drafts.length)}`
      : null;
    if (!force && key === last) return;
    last = key;
    try {
      if (!map.isStyleLoaded()) return;
      remove();
      if (!site) return;
      const t = site.tiles;
      const lv = t ? siteLevel(t) : null;
      if (t && lv) {
        const [tl, tr, bl] = [t.corners.tl, t.corners.tr, t.corners.bl];
        const at = (u: number, v: number): [number, number] => {
          const x =
            (tl[0] ?? 0) + u * ((tr[0] ?? 0) - (tl[0] ?? 0)) + v * ((bl[0] ?? 0) - (tl[0] ?? 0));
          const z =
            (tl[2] ?? 0) + u * ((tr[2] ?? 0) - (tl[2] ?? 0)) + v * ((bl[2] ?? 0) - (tl[2] ?? 0));
          const p = frame.toSite([x, 0, z]);
          return ll(p[0], p[1]);
        };
        for (let ty = 0; ty < lv.rows; ty++)
          for (let tx = 0; tx < lv.cols; tx++) {
            const id = `${SITE}-${String(tx)}-${String(ty)}`;
            const path = lv.pattern
              .replace('{z}', String(lv.z))
              .replace('{x}', String(tx))
              .replace('{y}', String(ty));
            const u0 = tx / lv.cols;
            const u1 = (tx + 1) / lv.cols;
            const v0 = ty / lv.rows;
            const v1 = (ty + 1) / lv.rows;
            map.addSource(id, {
              type: 'image',
              url: assetUrl(projectId, { path }),
              coordinates: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)],
            });
            map.addLayer(
              { id: `${id}-layer`, type: 'raster', source: id, paint: { 'raster-opacity': 0.8 } },
              map.getLayer('aio-survey-fill') ? 'aio-survey-fill' : undefined,
            );
            ids.push(id);
          }
      }
      if (site.drafts.length) {
        map.addSource(DRAFTS, {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: site.drafts.map((d, k) => ({
              type: 'Feature' as const,
              properties: { k, color: d.kind === 'cut' ? '#b2182b' : '#2166ac' },
              geometry: {
                type: 'Polygon' as const,
                coordinates: [[...d.ring.map(([e, n]) => ll(e, n)), ll(...(d.ring[0] ?? [0, 0]))]],
              },
            })),
          },
        });
        map.addLayer({
          id: `${DRAFTS}-line`,
          type: 'line',
          source: DRAFTS,
          paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [2, 2] },
        });
      }
    } catch {
      // the style is being replaced: drawn again on its next load
    }
  };
  const onStyle = () => {
    if (compareStore.getState().site && !map.getSource(DRAFTS) && ids.length === 0) draw(true);
  };
  map.on('styledata', onStyle);
  const off = compareStore.subscribe((s, p) => {
    if (s.site !== p.site) draw();
  });
  draw(true);
  return () => {
    off();
    map.off('styledata', onStyle);
    remove();
  };
}
