import { hasPos } from '@aio/engine';
import { frameProjection } from '@aio/maps';
import type { ProjectManifest, Vec3 } from '@aio/schema';
import { actionsFor, ContextMenu } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useState } from 'react';
import { Vector3 } from 'three';
import { claimEvent, isClaimed } from '../builder/droneHits';
import { CLICK_PX, photosAt3d, useMap, useScene } from '../builder/PhotoMenu';
import { usePinActionCtx } from '../shell/actions/pinActions';
import { drawnPins, mediaItem, pinsAt, type MediaKey } from './pinModel';
import { mediaName } from './placePin';

/*
 * The right-click menu of pins and 360s in the views (pinned media design): a pin in 3D (its eye
 * or its ground ring) and a placed 360 in 3D or on the map. A photo under the cursor, in 3D or on
 * the map, is left to the photo menu (`PhotoMenu`), which lists the same pin actions besides Open
 * and Align. The items are the registered actions of a `media` target.
 */

interface Point {
  key: MediaKey;
  x: number;
  y: number;
}

const hiddenSet = (): ReadonlySet<string> => new Set(Object.keys(workspace.getState().hidden));

/** Placed 360s of the shown layers, where their markers are. */
function placedPanos(
  m: ProjectManifest,
  hidden: ReadonlySet<string>,
): { key: MediaKey; pos: Vec3 }[] {
  const out: { key: MediaKey; pos: Vec3 }[] = [];
  for (const l of m.layers) {
    if (l.kind !== 'panoramas' || !l.visible || hidden.has(l.id)) continue;
    for (const p of l.items.filter(hasPos))
      out.push({ key: { kind: 'pano', layerId: l.id, itemId: p.id }, pos: p.pos });
  }
  return out;
}

interface MenuAt {
  x: number;
  y: number;
  key: MediaKey;
  /** The project it was opened in (a menu belongs to its project). */
  projectId: string;
}

/** A right-click's menu on `key`, in the open project. */
const menuAt = (e: MouseEvent, key: MediaKey): MenuAt | null => {
  const projectId = workspace.getState().project?.id;
  return projectId ? { x: e.clientX, y: e.clientY, key, projectId } : null;
};

export function PinMenu() {
  const scene = useScene();
  const map = useMap();
  const project = useWorkspace((s) => s.project);
  const ctxOf = usePinActionCtx();
  const [menu, setMenu] = useState<MenuAt | null>(null);

  // 3D: a pin's eye or ground, or a placed 360's marker
  useEffect(() => {
    const pane = document.querySelector<HTMLElement>('.pane-3d');
    if (!scene || !pane) return;
    let down: { x: number; y: number } | null = null;
    const pd = (e: PointerEvent) => {
      if (e.button === 2) down = { x: e.clientX, y: e.clientY };
    };
    const ctx = (e: MouseEvent) => {
      const d = down;
      down = null;
      if (isClaimed(e)) return;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
      const m = workspace.getState().project?.manifest;
      if (!m) return;
      // a photo here has its own menu
      if (photosAt3d(scene, pane, e.clientX, e.clientY)) return;
      const r = scene.renderer.domElement.getBoundingClientRect();
      const v = new Vector3();
      const points: Point[] = [];
      const add = (key: MediaKey, p: Vec3) => {
        v.set(p[0], p[1], p[2]).project(scene.camera);
        if (v.z > 1) return;
        points.push({
          key,
          x: r.left + ((v.x + 1) / 2) * r.width,
          y: r.top + ((1 - v.y) / 2) * r.height,
        });
      };
      const hidden = hiddenSet();
      for (const p of drawnPins(m, hidden)) {
        add(p.key, p.eye);
        add(p.key, p.ground);
      }
      for (const p of placedPanos(m, hidden)) add(p.key, p.pos);
      const key = pinsAt(points, e.clientX, e.clientY);
      if (!key) return;
      e.preventDefault();
      claimEvent(e);
      setMenu(menuAt(e, key));
    };
    pane.addEventListener('pointerdown', pd, true);
    pane.addEventListener('contextmenu', ctx);
    return () => {
      pane.removeEventListener('pointerdown', pd, true);
      pane.removeEventListener('contextmenu', ctx);
    };
  }, [scene]);

  // map: a 360's marker (before the drone menu sees the click); photos have the photo menu
  useEffect(() => {
    const m = map?.map;
    if (!m) return;
    const el = m.getContainer();
    let down: { x: number; y: number } | null = null;
    const pd = (e: PointerEvent) => {
      if (e.button === 2) down = { x: e.clientX, y: e.clientY };
    };
    const ctx = (e: MouseEvent) => {
      const d = down;
      down = null;
      if (isClaimed(e)) return;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
      const man = workspace.getState().project?.manifest;
      const proj = man ? frameProjection(man.crs, man.origin) : null;
      if (!man || !proj) return;
      const r = m.getCanvas().getBoundingClientRect();
      const hidden = hiddenSet();
      const points = placedPanos(man, hidden).map((p) => {
        const at = m.project(proj.toLonLat(p.pos));
        return { key: p.key, x: r.left + at.x, y: r.top + at.y };
      });
      const key = pinsAt(points, e.clientX, e.clientY);
      if (!key) return;
      e.preventDefault();
      claimEvent(e);
      setMenu(menuAt(e, key));
    };
    el.addEventListener('pointerdown', pd, true);
    el.addEventListener('contextmenu', ctx, true);
    return () => {
      el.removeEventListener('pointerdown', pd, true);
      el.removeEventListener('contextmenu', ctx, true);
    };
  }, [map]);

  const close = useCallback(() => {
    setMenu(null);
  }, []);
  const ctx = menu ? ctxOf(menu.key) : null;
  if (!menu || !ctx || menu.projectId !== project?.id) return null;
  const item = mediaItem(project.manifest, menu.key);
  const items = actionsFor({ kind: 'media', picks: [menu.key] }, ctx);
  if (!item || items.length === 0) return null;
  const name = mediaName(item);
  return <ContextMenu items={items} x={menu.x} y={menu.y} label={name} onClose={close} />;
}
