import { PANO_FOV, dragLook, zoomLook, type PanoLook } from '@aio/engine';
import type { Layer, WalkLayer } from '@aio/schema';
import { useT } from '@aio/ui';
import { FrameImage, createPanoVideoView, type PanoVideoView } from '@aio/video';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { levelOn, playbackRef } from '../../walks/walkModel';
import { useWalks } from '../../walks/walks';
import { walkFolderId } from '../../walks/walkStore';
import { createLookLink, fromShared, toShared, type LookLinkState } from '../lookLink';
import { PanoSurface, panoFrame, useCoverage } from '../panoSurface';
import { safeAssetUrl } from './safeAssetUrl';
import type { SpotMatch } from './spotTypes';

/** A clip paused at `t` with its controls: it can be played from the matched moment. */
function SpotVideo(p: { src: string; t: number; label: string }) {
  const v = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    const seek = () => {
      el.currentTime = p.t;
      el.pause();
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener('loadedmetadata', seek, { once: true });
    return () => {
      el.removeEventListener('loadedmetadata', seek);
    };
  }, [p.src, p.t]);
  return (
    <video
      ref={v}
      className="spot-video"
      src={p.src}
      controls
      preload="auto"
      aria-label={p.label}
    />
  );
}

function SpotPano(p: {
  url: string;
  pano: Parameters<typeof panoFrame>[0];
  projectId: string;
  lookDeg: number;
  look?: StoreApi<LookLinkState>;
  label: string;
}) {
  const coverage = useCoverage(p.projectId);
  const frame = useMemo(() => panoFrame(p.pano, coverage), [p.pano, coverage]);
  const [own] = useState(() =>
    createLookLink({ yawDeg: p.lookDeg, pitchDeg: 0, fovDeg: PANO_FOV.start }),
  );
  const store = p.look ?? own;
  const look: PanoLook = useStore(store, (s) => s.look);
  return (
    <PanoSurface
      url={p.url}
      headingDeg={frame.headingDeg}
      cov={frame.cov}
      look={look}
      label={p.label}
      arrowKeys={false}
      onLook={(l) => {
        store.getState().set(l);
      }}
    />
  );
}

type WalkStatus = 'loading' | 'ready' | 'error' | 'no-graphics';

/**
 * A walk frame: the walk's playback copy paused at `t` on a sphere. The look store holds compass
 * bearings (shared with other 360s in Compare); this frame turns by them minus its picture
 * centre's bearing at `t`. Drag and wheel turn and zoom; the arrow keys are left to the viewer.
 */
function SpotWalkFrame(p: {
  url: string;
  t: number;
  lookDeg: number;
  centreDeg: number;
  look?: StoreApi<LookLinkState>;
  label: string;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const view = useRef<PanoVideoView | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState<WalkStatus>('loading');
  const [own] = useState(() =>
    createLookLink({ yawDeg: p.lookDeg, pitchDeg: 0, fovDeg: PANO_FOV.start }),
  );
  const store = p.look ?? own;
  const shared = useStore(store, (s) => s.look);
  const local = fromShared(shared, p.centreDeg);
  const live = useRef({ local, centreDeg: p.centreDeg, store });
  useEffect(() => {
    live.current = { local, centreDeg: p.centreDeg, store };
  });
  const turn = (next: PanoLook) => {
    live.current = { ...live.current, local: next };
    live.current.store.getState().set(toShared(next, live.current.centreDeg));
  };

  const { url } = p;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    // aio:// answers with CORS headers so WebGL can read the frames
    v.crossOrigin = 'anonymous';
    v.src = url;
    video.current = v;
    let pano: PanoVideoView | null = null;
    try {
      pano = createPanoVideoView(el, v, live.current.local);
      view.current = pano;
    } catch {
      queueMicrotask(() => {
        setStatus('no-graphics');
      });
    }
    const onReady = () => {
      setStatus((s) => (s === 'no-graphics' ? s : 'ready'));
    };
    const onError = () => {
      setStatus((s) => (s === 'no-graphics' ? s : 'error'));
    };
    v.addEventListener('loadeddata', onReady);
    v.addEventListener('error', onError);
    // the wheel zooms the view and must not scroll the page behind it
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const next = zoomLook(live.current.local, e.deltaY);
      live.current = { ...live.current, local: next };
      live.current.store.getState().set(toShared(next, live.current.centreDeg));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      v.removeEventListener('loadeddata', onReady);
      v.removeEventListener('error', onError);
      pano?.dispose();
      view.current = null;
      video.current = null;
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
  }, [url]);

  // the matched moment, paused: the frame is a still of the walk
  const at = p.t;
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const seek = () => {
      v.currentTime = at;
      v.pause();
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener('loadedmetadata', seek, { once: true });
    return () => {
      v.removeEventListener('loadedmetadata', seek);
    };
  }, [url, at]);

  const { yawDeg, pitchDeg, fovDeg } = local;
  useEffect(() => {
    view.current?.setLook({ yawDeg, pitchDeg, fovDeg });
  }, [yawDeg, pitchDeg, fovDeg]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const zoom = e.key === '+' || e.key === '=' ? -1 : e.key === '-' ? 1 : 0;
    if (zoom === 0) return;
    e.preventDefault();
    e.stopPropagation();
    turn(zoomLook(live.current.local, zoom));
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.focus();
    if (typeof e.currentTarget.setPointerCapture === 'function')
      e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    turn(
      dragLook(
        live.current.local,
        e.clientX - from.x,
        e.clientY - from.y,
        e.currentTarget.clientHeight,
      ),
    );
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => {
    drag.current = null;
  };
  const message =
    status === 'loading'
      ? t('walk.loading')
      : status === 'error'
        ? t('walk.error')
        : status === 'no-graphics'
          ? t('walk.noGraphics')
          : null;
  return (
    <div
      ref={host}
      className="fill-col walk-view"
      tabIndex={0}
      role="img"
      aria-label={p.label}
      data-testid="spot-walk"
      data-status={status}
      data-yaw={yawDeg.toFixed(1)}
      onKeyDown={onKey}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {message && (
        <div className="walk-status" role="status">
          {message}
        </div>
      )}
    </div>
  );
}

/** A walk frame of `layer`, from the copy the walk plays (levelled when Level horizon is on). */
function SpotWalk(p: {
  projectId: string;
  layer: WalkLayer;
  match: SpotMatch;
  t: number;
  look?: StoreApi<LookLinkState>;
  missing: ReactElement;
}) {
  const processed = useWalks((s) => s.processed[walkFolderId(p.layer)]);
  const level = useWalks((s) => levelOn(s.level, p.layer.id));
  const url = safeAssetUrl(p.projectId, playbackRef(p.layer, processed, level));
  if (!url) return p.missing;
  const centreDeg = p.match.centreDeg ?? 0;
  return (
    <SpotWalkFrame
      key={p.layer.id}
      url={url}
      t={p.t}
      lookDeg={p.match.lookDeg ?? centreDeg}
      centreDeg={centreDeg}
      {...(p.look ? { look: p.look } : {})}
      label={p.layer.name}
    />
  );
}

/**
 * One image of a spot, whatever its kind: a photo or a video frame fitted to the box, a clip
 * paused at its moment (playable in the viewer), a 360 or a walk frame turned towards the spot.
 * Look only.
 */
export function SpotMatchView(p: {
  projectId: string;
  layers: readonly Layer[];
  match: SpotMatch;
  look?: StoreApi<LookLinkState>;
  playable?: boolean;
}) {
  const t = useT();
  const { match } = p;
  const layer = p.layers.find((l) => l.id === match.item.layer);
  const missing = <p className="pane-empty">{t('spot.missing')}</p>;
  let body = missing;
  const item = match.item;
  if (item.kind === 'photo' && layer?.kind === 'photos') {
    const photo = layer.items.find((x) => x.id === item.photo);
    const src = photo && safeAssetUrl(p.projectId, photo.src);
    if (photo && src)
      body = <FrameImage kind="photo" src={src} missing={t('spot.missing')} alt={photo.id} />;
  } else if (item.kind === 'video' && layer?.kind === 'video') {
    const src = safeAssetUrl(p.projectId, layer.src);
    if (src)
      body = p.playable ? (
        <SpotVideo src={src} t={item.t} label={layer.name} />
      ) : (
        <FrameImage kind="video" src={src} t={item.t} missing={t('spot.missing')} />
      );
  } else if (item.kind === 'pano' && layer?.kind === 'panoramas') {
    const pano = layer.items.find((x) => x.id === item.pano);
    const url = pano && safeAssetUrl(p.projectId, pano.src);
    if (pano && url)
      body = (
        <SpotPano
          key={`${layer.id}/${pano.id}`}
          url={url}
          pano={pano}
          projectId={p.projectId}
          lookDeg={match.lookDeg ?? pano.headingDeg}
          {...(p.look ? { look: p.look } : {})}
          label={pano.id}
        />
      );
  } else if (item.kind === 'walk' && layer?.kind === 'walk') {
    body = (
      <SpotWalk
        projectId={p.projectId}
        layer={layer}
        match={match}
        t={item.t}
        {...(p.look ? { look: p.look } : {})}
        missing={missing}
      />
    );
  }
  return (
    <div
      className="spot-view"
      data-testid="spot-view"
      data-kind={match.kind}
      data-capture={match.capture}
    >
      {body}
    </div>
  );
}
