import { PANO_FOV, type PanoLook } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { useT } from '@aio/ui';
import { FrameImage } from '@aio/video';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { createLookLink, type LookLinkState } from '../lookLink';
import { PanoSurface, useCoverage } from '../panoSurface';
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
  headingDeg: number;
  projectId: string;
  id: string;
  lookDeg: number;
  look?: StoreApi<LookLinkState>;
  label: string;
}) {
  const coverage = useCoverage(p.projectId);
  const [own] = useState(() =>
    createLookLink({ yawDeg: p.lookDeg, pitchDeg: 0, fovDeg: PANO_FOV.start }),
  );
  const store = p.look ?? own;
  const look: PanoLook = useStore(store, (s) => s.look);
  return (
    <PanoSurface
      url={p.url}
      headingDeg={p.headingDeg}
      cov={coverage.get(p.id) ?? null}
      look={look}
      label={p.label}
      arrowKeys={false}
      onLook={(l) => {
        store.getState().set(l);
      }}
    />
  );
}

/**
 * One image of a spot, whatever its kind: a photo or a video frame fitted to the box, a clip
 * paused at its moment (playable in the viewer), a 360 turned towards the spot. Look only.
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
          headingDeg={pano.headingDeg}
          projectId={p.projectId}
          id={pano.id}
          lookDeg={match.lookDeg ?? pano.headingDeg}
          {...(p.look ? { look: p.look } : {})}
          label={pano.id}
        />
      );
  }
  // walk frames: Task 12
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
