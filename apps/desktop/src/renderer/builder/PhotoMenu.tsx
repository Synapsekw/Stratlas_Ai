import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import { correctedPhoto, localToProject, toWgs84 } from '@aio/geo';
import { getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import type { Layer, PhotoRef } from '@aio/schema';
import { arrowFocus, Icon, useFocusTrap, useT, type IconName } from '@aio/ui';
import { DEFAULT_PHOTO_LENS } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Quaternion, Vector3, type InstancedMesh } from 'three';
import { useShell } from '../shell';
import { chooseSide, type SplitPref } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import { photoAlign, usePhotoAlign } from './alignSession';
import { isClaimed, paneRay } from './droneHits';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;

const CLICK_PX = 5;

interface MenuAt {
  x: number;
  y: number;
  layerId: string;
  /** One photo: its menu; several (a cluster or a merged marker): the list first. */
  photoIds: string[];
}

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

const setOf = (id: string): PhotosLayer | null => {
  const l = workspace.getState().project?.manifest.layers.find((x) => x.id === id);
  return l?.kind === 'photos' ? l : null;
};

/** The photos under a right-click in 3D: a frustum's image plane or a (merged) marker. */
function photosAt3d(h: SceneHandle, pane: HTMLElement, x: number, y: number) {
  const groups = h.scene.children.filter(
    (o) => typeof o.userData.photosLayer === 'string' && o.visible,
  );
  for (const g of groups) {
    const at = (g.userData.photoIdsAt as ((x: number, y: number) => string[] | null) | undefined)?.(
      x,
      y,
    );
    if (at?.length) return { layerId: g.userData.photosLayer as string, photoIds: at };
  }
  const ray = paneRay(h, pane, x, y);
  for (const g of groups) {
    const planes = g.getObjectByName('photo-planes') as InstancedMesh | undefined;
    if (!planes) continue;
    const hit = ray.intersectObject(planes, false)[0];
    const ids = planes.userData.photoIds as string[] | undefined;
    const id = hit?.instanceId !== undefined ? ids?.[hit.instanceId] : undefined;
    if (id) return { layerId: g.userData.photosLayer as string, photoIds: [id] };
  }
  return null;
}

/** Show or hide the frustums of every photo set in 3D (the "footprint" switch). */
function showPhotoFrustums(h: SceneHandle, on: boolean) {
  for (const g of h.scene.children)
    if (typeof g.userData.photosLayer === 'string')
      for (const c of g.children) if (c.name !== 'photo-stems') c.visible = on;
  h.requestRender();
}

/** Show the photo in the split view's photo pane (beside the 3D view). */
function openPhoto(layerId: string, photoId: string) {
  const w = workspace.getState();
  w.select({ kind: 'photo', id: photoId, layer: layerId });
  const id = w.project?.id;
  if (!id) return;
  const saved: SplitPref = stagePrefs.getState().byProject[id]?.split ?? {
    left: '3d',
    right: 'map',
  };
  if (saved.left !== 'photo' && saved.right !== 'photo')
    stagePrefs.getState().update(id, { split: chooseSide(saved, 'right', 'photo') });
}

/** Put the 3D camera where the photo was taken, looking as it looked. */
function lookThrough(h: SceneHandle, p: PhotoRef) {
  const c = correctedPhoto(p);
  if (!c.pos || !c.q) return;
  const lens = p.lens ?? DEFAULT_PHOTO_LENS;
  const cam = h.camera;
  const q = new Quaternion(...c.q);
  cam.position.set(...c.pos);
  cam.quaternion.copy(q);
  cam.up.set(0, 1, 0).applyQuaternion(q);
  cam.fov = (2 * Math.atan(Math.tan((lens.hfovDeg * Math.PI) / 360) / lens.aspect) * 180) / Math.PI;
  cam.updateProjectionMatrix();
  const controls = (h as SceneHandle & { controls?: { target: Vector3 } }).controls;
  controls?.target.copy(
    new Vector3(...c.pos).addScaledVector(new Vector3(0, 0, -1).applyQuaternion(q), 10),
  );
  h.requestRender();
}

function positionText(p: PhotoRef): string | null {
  const project = workspace.getState().project;
  const c = correctedPhoto(p);
  if (!project || !c.pos || !('epsg' in project.manifest.crs)) return null;
  const [lon, lat, h] = toWgs84(
    localToProject(c.pos, project.manifest.origin),
    project.manifest.crs.epsg,
  );
  return `${lat.toFixed(7)}, ${lon.toFixed(7)}, ${h.toFixed(1)} m`;
}

/**
 * Right-click on a photo (its pin on the map, its frustum or marker in 3D; a cluster or a merged
 * marker lists its photos first): Align photo to map, open it, look through its camera, show or
 * hide the footprint, reset its alignment, copy its position.
 */
export function PhotoMenu() {
  const t = useT();
  const pkg = useShell((s) => s.pkg);
  const scene = useScene();
  const map = useMap();
  const project = useWorkspace((s) => s.project);
  const footprint = usePhotoAlign((s) => s.footprint);
  const [menu, setMenuState] = useState<MenuAt | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const setMenu = useCallback((m: MenuAt | null) => {
    setMenuState(m);
  }, []);

  // 3D
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
      const hit = photosAt3d(scene, pane, e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, ...hit });
    };
    pane.addEventListener('pointerdown', pd, true);
    pane.addEventListener('contextmenu', ctx);
    return () => {
      pane.removeEventListener('pointerdown', pd, true);
      pane.removeEventListener('contextmenu', ctx);
    };
  }, [scene, setMenu]);

  // map: a pin, or a cluster (its photos listed)
  useEffect(() => {
    const m = map?.map;
    if (!m) return;
    let down: { x: number; y: number } | null = null;
    const md = (e: { originalEvent: MouseEvent; point: { x: number; y: number } }) => {
      if (e.originalEvent.button === 2) down = { x: e.point.x, y: e.point.y };
    };
    const ctx = (e: { originalEvent: MouseEvent; point: { x: number; y: number } }) => {
      const d = down;
      down = null;
      if (isClaimed(e.originalEvent)) return;
      if (d && Math.hypot(e.point.x - d.x, e.point.y - d.y) > CLICK_PX) return;
      const layers = ['aio-photos-pt', 'aio-photos-cluster'].filter((l) => m.getLayer(l));
      const f = m.queryRenderedFeatures(
        [
          [e.point.x - 5, e.point.y - 5],
          [e.point.x + 5, e.point.y + 5],
        ],
        { layers },
      )[0];
      if (!f) return;
      e.originalEvent.preventDefault();
      const at = { x: e.originalEvent.clientX, y: e.originalEvent.clientY };
      const props = f.properties as {
        photoLayer?: string;
        photoId?: string;
        cluster_id?: number;
      } | null;
      if (props?.photoId && props.photoLayer) {
        setMenu({ ...at, layerId: props.photoLayer, photoIds: [props.photoId] });
        return;
      }
      if (props?.cluster_id === undefined) return;
      const src = m.getSource(f.source) as
        | {
            getClusterLeaves(
              id: number,
              limit: number,
              offset: number,
            ): Promise<{ properties: { photoLayer?: string; photoId?: string } | null }[]>;
          }
        | undefined;
      void src?.getClusterLeaves(props.cluster_id, 50, 0).then((leaves) => {
        const first = leaves[0]?.properties?.photoLayer;
        if (!first) return;
        const ids = leaves
          .filter((l) => l.properties?.photoLayer === first)
          .flatMap((l) => (l.properties?.photoId ? [l.properties.photoId] : []));
        setMenu({ ...at, layerId: first, photoIds: ids });
      });
    };
    m.on('mousedown', md);
    m.on('contextmenu', ctx);
    return () => {
      m.off('mousedown', md);
      m.off('contextmenu', ctx);
    };
  }, [map, setMenu]);

  // the footprint switch: the photos' frustums in 3D
  useEffect(() => {
    if (scene) showPhotoFrustums(scene, footprint);
  }, [footprint, scene, project]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
    };
  }, [menu, setMenu]);
  useFocusTrap(list, menu !== null, {
    onEscape: () => {
      setMenu(null);
    },
  });

  if (!menu || !project) return null;
  const set = setOf(menu.layerId);
  if (!set) return null;
  const close = () => {
    setMenu(null);
  };
  const W = 260;
  const left = Math.min(menu.x, window.innerWidth - W - 8);
  const top = Math.min(menu.y, window.innerHeight - 320);
  const style = { left, top, width: W };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (list.current && arrowFocus(list.current, e.key)) e.preventDefault();
  };

  if (menu.photoIds.length > 1)
    return createPortal(
      <div
        ref={list}
        className="dmenu"
        role="menu"
        aria-label={t('photoMenu.list', { count: menu.photoIds.length })}
        style={style}
        data-testid="photo-menu-list"
        onKeyDown={keys}
      >
        <div className="dmenu-h faint">{t('photoMenu.list', { count: menu.photoIds.length })}</div>
        <div className="dmenu-scroll">
          {menu.photoIds.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              className="dmenu-item"
              onClick={() => {
                setMenu({ ...menu, photoIds: [id] });
              }}
            >
              <Icon name="photo" size={14} />
              <span className="mono">{id}</span>
            </button>
          ))}
        </div>
      </div>,
      document.body,
    );

  const photo = set.items.find((p) => p.id === menu.photoIds[0]);
  if (!photo) return null;
  const posed = !!photo.pos && !!photo.q;
  const readOnly = !!pkg;
  const item = (
    id: string,
    icon: IconName,
    label: string,
    run: () => void,
    o: { primary?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      key={id}
      type="button"
      role="menuitem"
      className={`dmenu-item${o.primary ? ' primary' : ''}`}
      disabled={o.disabled}
      data-testid={`photo-menu-${id}`}
      onClick={() => {
        close();
        run();
      }}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );
  return createPortal(
    <div
      ref={list}
      className="dmenu"
      role="menu"
      aria-label={t('photoMenu.label', { photo: photo.id })}
      style={style}
      data-testid="photo-menu"
      onKeyDown={keys}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div className="dmenu-h faint">{photo.id}</div>
      {!readOnly &&
        item(
          'align',
          'target',
          t('photoMenu.align'),
          () => {
            photoAlign.getState().start(set.id, photo.id);
          },
          { primary: true, disabled: !posed },
        )}
      {item('open', 'photo', t('photoMenu.open'), () => {
        openPhoto(set.id, photo.id);
      })}
      {scene &&
        item(
          'eye',
          'camera',
          t('photoMenu.eye'),
          () => {
            lookThrough(scene, photo);
          },
          { disabled: !posed },
        )}
      {item(
        'footprint',
        footprint ? 'eye-off' : 'eye',
        footprint ? t('photoMenu.hideFootprint') : t('photoMenu.showFootprint'),
        () => {
          photoAlign.getState().setFootprint(!footprint);
        },
      )}
      {!readOnly &&
        photo.correction &&
        item('reset', 'undo', t('photoMenu.reset'), () => {
          void photoAlign.getState().resetSaved(set.id, photo.id);
        })}
      {item(
        'copy',
        'copy',
        t('photoMenu.copy'),
        () => {
          const text = positionText(photo);
          if (text)
            void navigator.clipboard.writeText(text).catch((e: unknown) => {
              console.warn('Copy position failed', e);
            });
        },
        { disabled: !photo.pos },
      )}
    </div>,
    document.body,
  );
}
