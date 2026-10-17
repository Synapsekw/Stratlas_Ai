import { configureEngine, engineConfig, type SceneHandle } from '@aio/engine';
import { correctedPhoto, localToProject, photoCorrection, toWgs84 } from '@aio/geo';
import { setPhotoMapClickHandler } from '@aio/maps';
import type { Layer, PhotoRef } from '@aio/schema';
import {
  actionsFor,
  arrowFocus,
  ContextMenu,
  Icon,
  makeActionCtx,
  useFocusTrap,
  useT,
  type IconName,
  type PhotoPick,
} from '@aio/ui';
import { DEFAULT_PHOTO_LENS } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import { useAnnotateReadOnly } from '@aio/annotate';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Quaternion, Vector3, type InstancedMesh } from 'three';
import { useShell } from '../shell';
import { editBlocked } from '../shell/actions/reasons';
import { toastHost } from '../shell/actions/toastHost';
import { useMap, useScene } from './activeViews';
import { photoAlign, usePhotoAlign } from './alignSession';
import { isClaimed, paneRay } from './droneHits';
import { openPhoto } from './photoOpen';
import { photoPicks, usePhotoPicks } from './photoPicks';

// the views as stores live in `activeViews.ts`; kept here for the menus that import them from here
export { useMap, useScene };

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;

export const CLICK_PX = 5;

/** The pin actions of the registry a single photo's menu lists (pinned media design). */
const PIN_ACTIONS: readonly string[] = [
  'media.place',
  'media.move',
  'media.direction',
  'media.remove',
];

interface MenuPhoto {
  layerId: string;
  photoId: string;
}

interface MenuAt {
  x: number;
  y: number;
  layerId: string;
  /** One photo: its menu; several (a cluster or a merged marker): the list first. */
  photoIds: string[];
  /** Which view the menu was opened on. Open puts the photo beside that view. */
  from: '3d' | 'map';
  /** A left click on a map cluster: choosing a row opens that photo, it does not open this menu. */
  photos?: MenuPhoto[];
}

const setOf = (id: string): PhotosLayer | null => {
  const l = workspace.getState().project?.manifest.layers.find((x) => x.id === id);
  return l?.kind === 'photos' ? l : null;
};

/** The photos under a right-click in 3D: a frustum's image plane or a (merged) marker. */
export function photosAt3d(h: SceneHandle, pane: HTMLElement, x: number, y: number) {
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

export { openPhoto };

/** Put the 3D camera where the photo was taken, looking as it looked. */
function lookThrough(h: SceneHandle, layerId: string, p: PhotoRef) {
  const c = correctedPhoto(p, photoCorrection(workspace.getState().orientation, layerId, p.id));
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

function positionText(layerId: string, p: PhotoRef): string | null {
  const project = workspace.getState().project;
  const c = correctedPhoto(p, photoCorrection(workspace.getState().orientation, layerId, p.id));
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
 * hide the footprint, reset its alignment, copy its position. A plain left click opens that photo
 * in the split view (the 3D model beside it, or the map on the left).
 */
export function PhotoMenu() {
  const t = useT();
  const pkg = useShell((s) => s.pkg);
  const scene = useScene();
  const map = useMap();
  const project = useWorkspace((s) => s.project);
  const footprint = usePhotoAlign((s) => s.footprint);
  const orientation = useWorkspace((s) => s.orientation);
  const picks = usePhotoPicks((s) => s.picks);
  const lookOnly = useAnnotateReadOnly();
  const [menu, setMenuState] = useState<MenuAt | null>(null);
  const [alignAt, setAlignAt] = useState<{ x: number; y: number; picks: PhotoPick[] } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const setMenu = useCallback((m: MenuAt | null) => {
    setMenuState(m);
  }, []);

  // A plain click opens the photo in the split view. A merged map cluster lists its photos first.
  useEffect(() => {
    const prev = engineConfig().onPhotoOpen;
    configureEngine({
      onPhotoOpen: (layerId, photoId) => {
        setMenu(null);
        openPhoto(layerId, photoId, '3d');
      },
    });
    setPhotoMapClickHandler((hit) => {
      if (hit.kind === 'pin') {
        setMenu(null);
        openPhoto(hit.layerId, hit.photoId, 'map');
        return;
      }
      const first = hit.photos[0];
      if (!first) return;
      setMenu({
        x: hit.x,
        y: hit.y,
        layerId: first.layerId,
        photoIds: hit.photos.map((p) => p.photoId),
        from: 'map',
        photos: hit.photos,
      });
    });
    return () => {
      configureEngine({ onPhotoOpen: prev ?? null });
      setPhotoMapClickHandler(null);
    };
  }, [setMenu]);

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
      setMenu({ x: e.clientX, y: e.clientY, ...hit, from: '3d' });
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
        setMenu({ ...at, layerId: props.photoLayer, photoIds: [props.photoId], from: 'map' });
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
        setMenu({ ...at, layerId: first, photoIds: ids, from: 'map' });
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

  const alignMenu =
    alignAt && project ? (
      <ContextMenu
        items={actionsFor(
          { kind: 'photos', picks: alignAt.picks },
          makeActionCtx({
            manifest: project.manifest,
            canEdit: !pkg && !lookOnly,
            pkg: !!pkg,
            host: toastHost(t('align.to.notice')),
          }),
        )}
        x={alignAt.x}
        y={alignAt.y}
        label={t('align.photoMenu.alignTo')}
        title={t('align.photoMenu.picked', { count: alignAt.picks.length })}
        testId="ctx-menu"
        initialSub="photos.alignTo"
        onClose={() => {
          setAlignAt(null);
        }}
      />
    ) : null;
  if (!menu || !project) return alignMenu;
  if (menu.photos && menu.photos.length > 0) {
    const photos = menu.photos;
    const width = 260;
    return createPortal(
      <div
        ref={list}
        className="dmenu"
        role="menu"
        aria-label={t('align.photoMenu.list', { count: photos.length })}
        style={{
          left: Math.min(menu.x, window.innerWidth - width - 8),
          top: Math.min(menu.y, window.innerHeight - 320),
          width,
        }}
        data-testid="photo-map-list"
        onKeyDown={(e) => {
          if (list.current && arrowFocus(list.current, e.key)) e.preventDefault();
        }}
      >
        <div className="dmenu-h faint">{t('align.photoMenu.list', { count: photos.length })}</div>
        <div className="dmenu-scroll">
          {photos.map((p) => (
            <button
              key={`${p.layerId}/${p.photoId}`}
              type="button"
              role="menuitem"
              className="dmenu-item"
              onClick={() => {
                setMenu(null);
                openPhoto(p.layerId, p.photoId, 'map');
              }}
            >
              <Icon name="photo" size={14} />
              <span className="mono">{p.photoId}</span>
            </button>
          ))}
        </div>
      </div>,
      document.body,
    );
  }
  const set = setOf(menu.layerId);
  if (!set) return alignMenu;
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

  const photoIdsOf = (id: string): PhotoPick => ({ layerId: menu.layerId, photoId: id });
  const alignBlocked = editBlocked({ pkg: !!pkg, canEdit: !pkg && !lookOnly });
  const pickedHere =
    menu.photoIds.length === 1 &&
    picks.length > 1 &&
    picks.some((p) => p.layerId === menu.layerId && p.photoId === menu.photoIds[0]);
  if (pickedHere)
    return createPortal(
      <div
        ref={list}
        className="dmenu"
        role="menu"
        aria-label={t('align.photoMenu.picked', { count: picks.length })}
        style={style}
        data-testid="photo-menu"
        onKeyDown={keys}
        onContextMenu={(e) => {
          e.preventDefault();
        }}
      >
        <div className="dmenu-h faint">{t('align.photoMenu.picked', { count: picks.length })}</div>
        <button
          type="button"
          role="menuitem"
          className="dmenu-item primary"
          data-testid="photo-menu-alignTo"
          disabled={alignBlocked !== false}
          title={alignBlocked || undefined}
          onClick={() => {
            setMenu(null);
            setAlignAt({ x: menu.x, y: menu.y, picks: [...picks] });
          }}
        >
          <Icon name="target" size={14} />
          <span>{t('align.photoMenu.alignTo')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="dmenu-item"
          data-testid="photo-menu-clearPicks"
          onClick={() => {
            setMenu(null);
            photoPicks.getState().clear();
          }}
        >
          <Icon name="x" size={14} />
          <span>{t('align.photoMenu.clearPicks')}</span>
        </button>
      </div>,
      document.body,
    );

  if (menu.photoIds.length > 1)
    return createPortal(
      <div
        ref={list}
        className="dmenu"
        role="menu"
        aria-label={t('align.photoMenu.list', { count: menu.photoIds.length })}
        style={style}
        data-testid="photo-menu-list"
        onKeyDown={keys}
      >
        <div className="dmenu-h faint">
          {t('align.photoMenu.list', { count: menu.photoIds.length })}
        </div>
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
  // Place on site, Move pin, Set direction, Remove pin: the shared actions, as every menu has them
  const pinItems = readOnly
    ? []
    : actionsFor(
        { kind: 'photos', picks: [photoIdsOf(photo.id)] },
        makeActionCtx({
          manifest: project.manifest,
          canEdit: !lookOnly,
          pkg: false,
          host: toastHost(photo.id),
        }),
      ).filter((i) => PIN_ACTIONS.includes(i.id));
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
      aria-label={t('align.photoMenu.label', { photo: photo.id })}
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
          t('align.photoMenu.align'),
          () => {
            photoAlign.getState().start(set.id, photo.id);
          },
          { primary: true, disabled: !posed },
        )}
      {!readOnly &&
        item('alignTo', 'target', t('align.photoMenu.alignTo'), () => {
          setAlignAt({ x: menu.x, y: menu.y, picks: [photoIdsOf(photo.id)] });
        })}
      {pinItems.map((pi) => (
        <button
          key={pi.id}
          type="button"
          role="menuitem"
          className="dmenu-item"
          disabled={pi.disabled !== false}
          data-testid={pi.testId}
          onClick={() => {
            close();
            pi.run();
          }}
        >
          <Icon name={pi.icon ?? 'pin'} size={14} />
          <span>{pi.label}</span>
        </button>
      ))}
      {item('open', 'photo', t('align.photoMenu.open'), () => {
        openPhoto(set.id, photo.id, menu.from);
      })}
      {scene &&
        item(
          'eye',
          'camera',
          t('align.photoMenu.eye'),
          () => {
            lookThrough(scene, set.id, photo);
          },
          { disabled: !posed },
        )}
      {item(
        'footprint',
        footprint ? 'eye-off' : 'eye',
        footprint ? t('align.photoMenu.hideFootprint') : t('align.photoMenu.showFootprint'),
        () => {
          photoAlign.getState().setFootprint(!footprint);
        },
      )}
      {!readOnly &&
        photoCorrection(orientation, set.id, photo.id) &&
        item('reset', 'undo', t('align.photoMenu.reset'), () => {
          void photoAlign.getState().resetSaved(set.id, photo.id);
        })}
      {item(
        'copy',
        'copy',
        t('align.photoMenu.copy'),
        () => {
          const text = positionText(set.id, photo);
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
