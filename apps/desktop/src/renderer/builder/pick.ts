import { getActiveScene } from '@aio/engine';
import type { Vec3 } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useEffect, useRef } from 'react';
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  type Intersection,
  type Object3D,
} from 'three';

/** The layer a scene hit belongs to (layer roots carry `userData.layerId`). */
export function hitLayer(hit: Intersection): string | null {
  let o: Object3D | null = hit.object;
  while (o) {
    const id = (o.userData as { layerId?: unknown }).layerId;
    if (typeof id === 'string') return id;
    o = o.parent;
  }
  return null;
}

const paneEl = () => document.querySelector<HTMLElement>('.pane-3d');

/**
 * While `armed`, a click (no drag) on the 3D view calls `onPick` with what is under the cursor.
 * Orbiting still works; the selection the stage makes on that click is undone.
 */
export function useStagePick(
  armed: boolean,
  onPick: (hit: Intersection | null, client: { x: number; y: number }) => void,
): void {
  const cb = useRef(onPick);
  useEffect(() => {
    cb.current = onPick;
  }, [onPick]);
  useEffect(() => {
    if (!armed) return;
    const pane = paneEl();
    if (!pane) return;
    let down: { x: number; y: number } | null = null;
    const pd = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    };
    const pu = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const canvas = pane.querySelector('canvas');
      const r = (canvas ?? pane).getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const before = workspace.getState().selection;
      const hit = getActiveScene()?.raycast(x, y) ?? null;
      cb.current(hit, { x: e.clientX, y: e.clientY });
      // the stage selects on the same click (its own pointerup runs after this capture
      // listener); put the selection back once it has
      setTimeout(() => {
        workspace.getState().select(before);
      }, 0);
    };
    pane.addEventListener('pointerdown', pd, true);
    pane.addEventListener('pointerup', pu, true);
    const cursor = pane.style.cursor;
    pane.style.cursor = 'crosshair';
    pane.dataset.picking = 'true';
    return () => {
      pane.removeEventListener('pointerdown', pd, true);
      pane.removeEventListener('pointerup', pu, true);
      pane.style.cursor = cursor;
      delete pane.dataset.picking;
    };
  }, [armed]);
}

export interface Marker {
  pos: Vec3;
  /** CSS-like hex colour. */
  color: number;
}

/** Small screen-sized spheres drawn over everything at picked points. */
export function usePickMarkers(markers: readonly Marker[]): void {
  useEffect(() => {
    const h = getActiveScene();
    if (!h || !markers.length) return;
    const group = new Group();
    group.name = 'AlignMarkers';
    const geo = new SphereGeometry(1, 16, 12);
    const mats: MeshBasicMaterial[] = [];
    for (const m of markers) {
      const mat = new MeshBasicMaterial({ color: m.color, depthTest: false, transparent: true });
      mats.push(mat);
      const mesh = new Mesh(geo, mat);
      mesh.position.set(...m.pos);
      mesh.renderOrder = 60;
      group.add(mesh);
    }
    h.scene.add(group);
    const off = h.onFrame(() => {
      for (const c of group.children) {
        const d = h.camera.position.distanceTo(c.position);
        c.scale.setScalar(Math.max(0.02, d * 0.006));
      }
    });
    h.requestRender();
    return () => {
      off();
      h.scene.remove(group);
      geo.dispose();
      for (const m of mats) m.dispose();
      h.requestRender();
    };
  }, [markers]);
}
