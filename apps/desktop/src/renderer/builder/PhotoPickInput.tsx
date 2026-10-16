import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import { correctPos, photoCorrection } from '@aio/geo';
import { getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import type { Layer } from '@aio/schema';
import type { PhotoPick } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { Vector3 } from 'three';
import { photosInRect } from './photoBox';
import { nextPicks, photoPicks } from './photoPicks';
import { photosAt3d } from './PhotoMenu';
import './photoBand.css';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const CLICK_PX = 5;
const PHOTO_SOURCE = 'aio-photos';

function useScene(): SceneHandle | null {
  const [h, setH] = useState<SceneHandle | null>(() => getActiveScene());
  useEffect(() => onActiveScene(setH), []);
  return h;
}

function useMap(): MapController | null {
  const [m, setM] = useState<MapController | null>(() => getActiveMap());
  useEffect(() => onActiveMap(setM), []);
  return m;
}

/** The rubber band of an Alt+drag, drawn in client pixels. */
function drawBand(el: HTMLDivElement, r: Rect) {
  el.style.left = `${String(Math.min(r.x0, r.x1))}px`;
  el.style.top = `${String(Math.min(r.y0, r.y1))}px`;
  el.style.width = `${String(Math.abs(r.x1 - r.x0))}px`;
  el.style.height = `${String(Math.abs(r.y1 - r.y0))}px`;
}

function makeBand(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'photo-band';
  el.dataset.testid = 'photo-band';
  document.body.appendChild(el);
  return el;
}

/** Corrected positions of the photos of the visible photo sets, as client pixels in the 3D pane. */
function projectedPhotos(scene: SceneHandle, pane: HTMLElement) {
  const r = (pane.querySelector('canvas') ?? pane).getBoundingClientRect();
  const w = workspace.getState();
  const out: (PhotoPick & { x: number; y: number })[] = [];
  for (const g of scene.scene.children) {
    const layerId: unknown = g.userData.photosLayer;
    if (typeof layerId !== 'string' || !g.visible) continue;
    const set = w.project?.manifest.layers.find((l): l is PhotosLayer => l.id === layerId);
    if (!set) continue;
    for (const p of set.items) {
      if (!p.pos) continue;
      const pos = correctPos(p.pos, photoCorrection(w.orientation, layerId, p.id));
      const v = new Vector3(...pos).project(scene.camera);
      if (v.z > 1) continue;
      out.push({
        layerId,
        photoId: p.id,
        x: r.left + ((v.x + 1) / 2) * r.width,
        y: r.top + ((1 - v.y) / 2) * r.height,
      });
    }
  }
  return out;
}

/**
 * Picking several photos: Ctrl or Shift click on a pin (map) or a frustum or marker (3D), and
 * Alt+drag for a box (Shift+drag is the map's box zoom). A plain click clears the picks. Draws
 * nothing but the rubber band; the photo menu and the notice read `photoPicks`.
 */
export function PhotoPickInput() {
  const scene = useScene();
  const map = useMap();

  // 3D
  useEffect(() => {
    const pane = document.querySelector<HTMLElement>('.pane-3d');
    if (!scene || !pane) return;
    let down: { x: number; y: number } | null = null;
    let box: { x0: number; y0: number; el: HTMLDivElement } | null = null;
    const end = () => {
      box?.el.remove();
      box = null;
    };
    const pd = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY };
      if (e.altKey) {
        e.stopPropagation();
        end();
        box = { x0: e.clientX, y0: e.clientY, el: makeBand() };
        drawBand(box.el, { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      }
    };
    const pm = (e: PointerEvent) => {
      if (box) drawBand(box.el, { x0: box.x0, y0: box.y0, x1: e.clientX, y1: e.clientY });
    };
    const pu = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const d = down;
      down = null;
      if (box) {
        const rect = { x0: box.x0, y0: box.y0, x1: e.clientX, y1: e.clientY };
        end();
        photoPicks.getState().add(photosInRect(projectedPhotos(scene, pane), rect));
        return;
      }
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl && !e.shiftKey) {
        photoPicks.getState().clear();
        return;
      }
      const hit = photosAt3d(scene, pane, e.clientX, e.clientY);
      const id = hit?.photoIds.length === 1 ? hit.photoIds[0] : undefined;
      if (!hit || !id) return;
      photoPicks.setState({
        picks: nextPicks(
          photoPicks.getState().picks,
          { layerId: hit.layerId, photoId: id },
          { ctrl, shift: e.shiftKey },
        ),
      });
    };
    pane.addEventListener('pointerdown', pd, true);
    window.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', pu, true);
    return () => {
      pane.removeEventListener('pointerdown', pd, true);
      window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu, true);
      end();
    };
  }, [scene]);

  // map
  useEffect(() => {
    const m = map?.map;
    if (!m) return;
    const hitAt = (point: { x: number; y: number }): PhotoPick | null => {
      if (!m.getLayer('aio-photos-pt')) return null;
      const f = m.queryRenderedFeatures(
        [
          [point.x - 5, point.y - 5],
          [point.x + 5, point.y + 5],
        ],
        { layers: ['aio-photos-pt'] },
      )[0];
      const props = f?.properties as { photoLayer?: string; photoId?: string } | null | undefined;
      return props?.photoLayer && props.photoId
        ? { layerId: props.photoLayer, photoId: props.photoId }
        : null;
    };
    const click = (e: { originalEvent: MouseEvent; point: { x: number; y: number } }) => {
      const o = e.originalEvent;
      const ctrl = o.ctrlKey || o.metaKey;
      if (!ctrl && !o.shiftKey) {
        photoPicks.getState().clear();
        return;
      }
      const hit = hitAt(e.point);
      if (hit)
        photoPicks.setState({
          picks: nextPicks(photoPicks.getState().picks, hit, { ctrl, shift: o.shiftKey }),
        });
    };
    const canvas = m.getCanvasContainer();
    let box: { x0: number; y0: number; el: HTMLDivElement } | null = null;
    const end = () => {
      box?.el.remove();
      box = null;
      window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu, true);
    };
    const pm = (e: PointerEvent) => {
      if (box) drawBand(box.el, { x0: box.x0, y0: box.y0, x1: e.clientX, y1: e.clientY });
    };
    const pu = (e: PointerEvent) => {
      if (!box) return;
      const r = canvas.getBoundingClientRect();
      const rect = {
        x0: box.x0 - r.left,
        y0: box.y0 - r.top,
        x1: e.clientX - r.left,
        y1: e.clientY - r.top,
      };
      end();
      m.dragPan.enable();
      const seen = new Set<string>();
      const points: (PhotoPick & { x: number; y: number })[] = [];
      for (const f of m.querySourceFeatures(PHOTO_SOURCE)) {
        const props = f.properties as { photoLayer?: string; photoId?: string } | null;
        if (!props?.photoLayer || !props.photoId || f.geometry.type !== 'Point') continue;
        const key = `${props.photoLayer}/${props.photoId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [lon, lat] = f.geometry.coordinates;
        if (lon === undefined || lat === undefined) continue;
        const px = m.project([lon, lat]);
        points.push({ layerId: props.photoLayer, photoId: props.photoId, x: px.x, y: px.y });
      }
      photoPicks.getState().add(photosInRect(points, rect));
    };
    const pd = (e: PointerEvent) => {
      if (e.button !== 0 || !e.altKey) return;
      m.dragPan.disable();
      end();
      box = { x0: e.clientX, y0: e.clientY, el: makeBand() };
      drawBand(box.el, { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      window.addEventListener('pointermove', pm);
      window.addEventListener('pointerup', pu, true);
    };
    m.on('click', click);
    canvas.addEventListener('pointerdown', pd, true);
    return () => {
      m.off('click', click);
      canvas.removeEventListener('pointerdown', pd, true);
      end();
      m.dragPan.enable();
    };
  }, [map]);

  return null;
}
