import type { SceneHandle } from '@aio/engine';
import { correctPos, photoCorrection } from '@aio/geo';
import { MAP_INK, type MapController } from '@aio/maps';
import type { Layer } from '@aio/schema';
import type { PhotoPick } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { Vector3 } from 'three';
import { photosInRect } from './photoBox';
import { nextPicks, photoPicks, usePhotoPicks } from './photoPicks';
import { CLICK_PX, photosAt3d, useMap, useScene } from './PhotoMenu';
import './photoBand.css';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;
type MapLibreMap = MapController['map'];
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const PHOTO_SOURCE = 'aio-photos';

const HIGHLIGHT = 'aio-photos-picked';

/** The picks whose photo set and photo are still in the manifest. */
export function prunePicks(picks: readonly PhotoPick[], layers: readonly Layer[]): PhotoPick[] {
  return picks.filter((p) =>
    layers.some(
      (l) => l.kind === 'photos' && l.id === p.layerId && l.items.some((i) => i.id === p.photoId),
    ),
  );
}

/** A ring over the picked pins (re-added when the map style reloads). */
function showPicked(m: MapLibreMap, picks: readonly PhotoPick[]) {
  if (!m.isStyleLoaded() || !m.getSource('aio-photos')) return;
  const keys = picks.map((p) => `${p.layerId}/${p.photoId}`);
  const filter: unknown[] = [
    'all',
    ['!', ['has', 'point_count']],
    ['in', ['concat', ['get', 'photoLayer'], '/', ['get', 'photoId']], ['literal', keys]],
  ];
  if (!m.getLayer(HIGHLIGHT))
    m.addLayer({
      id: HIGHLIGHT,
      type: 'circle',
      source: 'aio-photos',
      paint: {
        'circle-radius': 10,
        'circle-color': MAP_INK.accStrong,
        'circle-opacity': 0.25,
        'circle-stroke-color': MAP_INK.accStrong,
        'circle-stroke-width': 2,
      },
    });
  m.setFilter(HIGHLIGHT, filter as never);
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

  // picks live only as long as this scene and the photos they name
  useEffect(() => {
    let id = workspace.getState().project?.id;
    const off = workspace.subscribe((w) => {
      const now = w.project?.id;
      const picks = photoPicks.getState().picks;
      if (now !== id) {
        id = now;
        photoPicks.getState().clear();
      } else if (picks.length) {
        const kept = prunePicks(picks, w.project?.manifest.layers ?? []);
        if (kept.length !== picks.length) photoPicks.setState({ picks: kept });
      }
    });
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        t.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      photoPicks.getState().clear();
    };
    window.addEventListener('keydown', key);
    return () => {
      off();
      window.removeEventListener('keydown', key);
      photoPicks.getState().clear();
    };
  }, []);

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
        if (Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0) <= CLICK_PX) return;
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
    const pc = () => {
      down = null;
      end();
    };
    pane.addEventListener('pointerdown', pd, true);
    window.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', pu, true);
    window.addEventListener('pointercancel', pc, true);
    return () => {
      pane.removeEventListener('pointerdown', pd, true);
      window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu, true);
      window.removeEventListener('pointercancel', pc, true);
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
      if (o.altKey) return;
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
    let panWas = false;
    const end = () => {
      if (box && panWas) m.dragPan.enable();
      box?.el.remove();
      box = null;
      window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu, true);
      window.removeEventListener('pointercancel', end, true);
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
      if (Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0) <= CLICK_PX) return;
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
      end();
      panWas = m.dragPan.isEnabled();
      m.dragPan.disable();
      box = { x0: e.clientX, y0: e.clientY, el: makeBand() };
      drawBand(box.el, { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      window.addEventListener('pointermove', pm);
      window.addEventListener('pointerup', pu, true);
      window.addEventListener('pointercancel', end, true);
    };
    m.on('click', click);
    canvas.addEventListener('pointerdown', pd, true);
    return () => {
      m.off('click', click);
      canvas.removeEventListener('pointerdown', pd, true);
      end();
    };
  }, [map]);

  // a ring on the picked pins
  const picks = usePhotoPicks((s) => s.picks);
  useEffect(() => {
    const m = map?.map;
    if (!m) return;
    const show = () => {
      showPicked(m, picks);
    };
    show();
    m.on('styledata', show);
    return () => {
      m.off('styledata', show);
      if (m.getLayer(HIGHLIGHT)) m.removeLayer(HIGHLIGHT);
    };
  }, [map, picks]);

  return null;
}
