import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import { clipCamera, clipPoseAt, localToProject, toWgs84 } from '@aio/geo';
import { frameProjection, getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import type { Layer } from '@aio/schema';
import { arrowFocus, Icon, useFocusTrap, useT, type IconName } from '@aio/ui';
import { setCameraMode, videoRig } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { getMedia, loadFlight } from '../media';
import { useShell } from '../shell';
import { alignCamera, useAlign } from './alignSession';
import { claimEvent, clipAtFlightTime, nearestSampleMs, rigHit } from './droneHits';

type VideoLayer = Extract<Layer, { kind: 'video' }>;

/** A right-click closer than this to its press (pixels) is a click, not a pan or rotate. */
const CLICK_PX = 5;
/** Map layers of the drone (its marker, heading arrow and view footprint). */
const MAP_DRONE = [
  'aio-drone-point',
  'aio-drone-heading',
  'aio-drone-footprint',
  'aio-dir-handle-pt',
];

interface MenuAt {
  x: number;
  y: number;
  layerId: string;
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

const videos = (): VideoLayer[] =>
  (workspace.getState().project?.manifest.layers ?? []).filter(
    (l): l is VideoLayer => l.kind === 'video',
  );

/** Move the playhead to flight time `flightMs` of the clip (or the clip of its flight there). */
function jumpTo(layerId: string, flightMs: number) {
  const clip = videos().find((c) => c.id === layerId);
  if (!clip) return null;
  const same = videos().filter(
    (c) => JSON.stringify(c.flight.src) === JSON.stringify(clip.flight.src),
  );
  const pick = clipAtFlightTime(same, flightMs, (id) => getMedia().durations[id] ?? null) ?? clip;
  const w = workspace.getState();
  w.pause();
  if (w.activeClip !== pick.id) w.setActiveClip(pick.id);
  w.setTime(pick.flight.startUtcMs + flightMs);
  return pick.id;
}

/** Text to copy for the drone position now: latitude, longitude and height. */
function positionText(layerId: string): string | null {
  const project = workspace.getState().project;
  const clip = videos().find((c) => c.id === layerId);
  const samples = getMedia().flights[layerId];
  if (!project || !clip || !samples?.length || !('epsg' in project.manifest.crs)) return null;
  const p = clipPoseAt(
    samples,
    workspace.getState().nowMs - clip.flight.startUtcMs,
    clipCamera(clip),
  ).pos;
  const e = localToProject(p, project.manifest.origin);
  const [lon, lat, h] = toWgs84(e, project.manifest.crs.epsg);
  return `${lat.toFixed(7)}, ${lon.toFixed(7)}, ${h.toFixed(1)} m`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    console.warn('Copy position failed', e);
  }
}

/**
 * Right-click on the drone (its marker, heading or footprint on the map; the drone, frustum or
 * frame in 3D) or on a flight path (the playhead jumps there first): Align camera to map, set a
 * direction keyframe, look through the drone camera, play or pause, show or hide the view
 * footprint, clear the clip's keyframes, copy the position.
 */
export function DroneMenu() {
  const t = useT();
  const pkg = useShell((s) => s.pkg);
  const scene = useScene();
  const map = useMap();
  const project = useWorkspace((s) => s.project);
  const playing = useWorkspace((s) => s.playing);
  const session = useAlign((s) => s.session);
  const footprint = useAlign((s) => s.footprint);
  const [menu, setMenuState] = useState<MenuAt | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const setMenu = useCallback((m: MenuAt | null) => {
    setConfirmClear(false);
    setMenuState(m);
  }, []);
  const list = useRef<HTMLDivElement>(null);

  // flights for the path jumps and the position (small files, read once)
  useEffect(() => {
    if (!project) return;
    for (const l of project.manifest.layers) if (l.kind === 'video') loadFlight(project, l);
  }, [project]);

  // 3D: the rig under a right-click
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
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
      const hit = rigHit(scene, pane, e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      claimEvent(e);
      let layerId = workspace.getState().activeClip;
      if (hit.kind === 'path') {
        const flight = videoRig(scene).flightOf(hit.layerId);
        const ms = flight ? nearestSampleMs(flight.samples, hit.point) : null;
        layerId = ms === null ? hit.layerId : jumpTo(hit.layerId, ms);
      }
      if (layerId) setMenu({ x: e.clientX, y: e.clientY, layerId });
    };
    pane.addEventListener('pointerdown', pd, true);
    pane.addEventListener('contextmenu', ctx);
    return () => {
      pane.removeEventListener('pointerdown', pd, true);
      pane.removeEventListener('contextmenu', ctx);
    };
  }, [scene, setMenu]);

  // map: the drone or a flight path under a right-click
  useEffect(() => {
    const m = map?.map;
    if (!m || !project) return;
    const proj = frameProjection(project.manifest.crs, project.manifest.origin);
    let down: { x: number; y: number } | null = null;
    const md = (e: { originalEvent: MouseEvent; point: { x: number; y: number } }) => {
      if (e.originalEvent.button === 2) down = { x: e.point.x, y: e.point.y };
    };
    const ctx = (e: {
      originalEvent: MouseEvent;
      point: { x: number; y: number };
      lngLat: { lng: number; lat: number };
    }) => {
      const d = down;
      down = null;
      if (d && Math.hypot(e.point.x - d.x, e.point.y - d.y) > CLICK_PX) return;
      const box: [[number, number], [number, number]] = [
        [e.point.x - 6, e.point.y - 6],
        [e.point.x + 6, e.point.y + 6],
      ];
      const layers = [...MAP_DRONE, 'aio-flights-line'].filter((l) => m.getLayer(l));
      const hits = m.queryRenderedFeatures(box, { layers });
      const drone = hits.find((f) => MAP_DRONE.includes(f.layer.id));
      const path = hits.find((f) => f.layer.id === 'aio-flights-line');
      let layerId: string | null = null;
      if (drone) layerId = workspace.getState().activeClip;
      else if (path && proj) {
        const id = (path.properties as { layerId?: unknown } | null)?.layerId;
        const samples = typeof id === 'string' ? getMedia().flights[id] : undefined;
        const ms = samples
          ? nearestSampleMs(samples, proj.toLocal(e.lngLat.lng, e.lngLat.lat))
          : null;
        if (typeof id === 'string') layerId = ms === null ? id : jumpTo(id, ms);
      }
      if (!layerId) return;
      e.originalEvent.preventDefault();
      claimEvent(e.originalEvent);
      setMenu({ x: e.originalEvent.clientX, y: e.originalEvent.clientY, layerId });
    };
    m.on('mousedown', md);
    m.on('contextmenu', ctx);
    return () => {
      m.off('mousedown', md);
      m.off('contextmenu', ctx);
    };
  }, [map, project, setMenu]);

  // the view footprint switch: map footprint and 3D frustum
  useEffect(() => {
    const m = map?.map;
    if (m?.getLayer('aio-drone-footprint'))
      m.setLayoutProperty('aio-drone-footprint', 'visibility', footprint ? 'visible' : 'none');
    if (scene) {
      videoRig(scene).frustumOn = footprint;
      scene.requestRender();
    }
  }, [footprint, map, scene]);

  // a click elsewhere closes the menu
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
  const clip = videos().find((c) => c.id === menu.layerId);
  if (!clip) return null;
  const keys = clip.directionKeys ?? [];
  const aligning = session?.layerId === clip.id;
  const droneEye = scene ? videoRig(scene).cameraMode === 'drone' : false;
  const readOnly = !!pkg;
  const close = () => {
    setMenu(null);
  };

  const item = (
    id: string,
    icon: IconName,
    label: string,
    run: () => void,
    o: { primary?: boolean; disabled?: boolean; keepOpen?: boolean } = {},
  ) => (
    <button
      key={id}
      type="button"
      role="menuitem"
      className={`dmenu-item${o.primary ? ' primary' : ''}`}
      disabled={o.disabled}
      data-testid={`drone-menu-${id}`}
      onClick={() => {
        if (!o.keepOpen) close();
        run();
      }}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );

  const W = 260;
  const left = Math.min(menu.x, window.innerWidth - W - 8);
  const top = Math.min(menu.y, window.innerHeight - 300);
  return createPortal(
    <div
      ref={list}
      className="dmenu"
      role="menu"
      aria-label={t('droneMenu.label', { clip: clip.name })}
      style={{ left, top, width: W }}
      data-testid="drone-menu"
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (list.current && arrowFocus(list.current, e.key)) e.preventDefault();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div className="dmenu-h faint">{clip.name}</div>
      {!readOnly &&
        item(
          'align',
          'droneeye',
          t('droneMenu.align'),
          () => {
            alignCamera.getState().start(clip.id);
          },
          { primary: true, disabled: aligning },
        )}
      {!readOnly &&
        (aligning || keys.length > 0) &&
        item('set-key', 'point', t('droneMenu.setKey'), () => {
          alignCamera.getState().start(clip.id);
          alignCamera.getState().setKey();
        })}
      {scene &&
        item('drone-eye', 'camera', droneEye ? t('droneMenu.leaveEye') : t('droneMenu.eye'), () => {
          setCameraMode(scene, droneEye ? 'free' : 'drone');
        })}
      {item(
        'play',
        playing ? 'pause' : 'play',
        playing ? t('droneMenu.pause') : t('droneMenu.play'),
        () => {
          const w = workspace.getState();
          if (w.activeClip !== clip.id) w.setActiveClip(clip.id);
          if (playing) w.pause();
          else w.play();
        },
      )}
      {item(
        'footprint',
        footprint ? 'eye-off' : 'eye',
        footprint ? t('droneMenu.hideFootprint') : t('droneMenu.showFootprint'),
        () => {
          alignCamera.getState().setFootprint(!footprint);
        },
      )}
      {!readOnly &&
        keys.length > 0 &&
        item(
          'clear',
          'x',
          confirmClear ? t('droneMenu.clearConfirm', { count: keys.length }) : t('droneMenu.clear'),
          () => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            close();
            void alignCamera.getState().clear(clip.id);
          },
          { keepOpen: true },
        )}
      {item('copy', 'copy', t('droneMenu.copy'), () => {
        const text = positionText(clip.id);
        if (text) void copyText(text);
      })}
    </div>,
    document.body,
  );
}
