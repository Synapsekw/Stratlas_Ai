import { useTaxonomy } from '@aio/annotate';
import { PANO_FOV, dragLook, zoomLook, type PanoLook } from '@aio/engine';
import type { AssetRef, WalkFile, WalkLayer } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { createPanoVideoView, type PanoVideoView } from '@aio/video';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from 'zustand';
import { detectionLook } from '../detections/look';
import { loadDetections, useDetections } from '../detections/store';
import { SpotHistoryButton } from '../workspace/spot/SpotHistoryEntry';
import { wrapDeg } from '../workspace/spot/spotGeom';
import { bearingFromHeadingRad } from '../workspace/spot/spotWalk';
import { framesNear } from './detOverlay';
import { northTick, viewClickYawRad } from './placeModel';
import { placeSession, placeUi, useWalkViewHeading } from './placeWalk';
import { PlaceWalkHere } from './PlaceWalkStrip';
import {
  formatWalkTime,
  levelOn,
  pickWalk,
  playbackRef,
  walkKeyAction,
  walkUnstabilised,
} from './walkModel';
import { publishWalkPlayback } from './walkPlayback';
import { WalkDetOverlay, type OverlayBox } from './WalkDetOverlay';
import { useWalks, walks } from './walks';
import { walkFolderId, walkRecordKey } from './walkStore';

/** Where the view starts: along the picture centre, level, at the panorama viewer's zoom. */
const START: PanoLook = { yawDeg: 0, pitchDeg: 0, fovDeg: PANO_FOV.start };

type Status = 'loading' | 'ready' | 'error' | 'no-graphics';

/** Presses inside this many screen pixels are a click (Align view), not a drag. */
const CLICK_PX = 4;

/** Frame steps before main has listed the walk's record (its real rate comes with it). */
const DEFAULT_FPS = 30;

/**
 * The look-around player of one walk: its equirectangular playback copy on the inside of a
 * sphere. Drag to look, wheel to zoom, the bar below plays and scrubs. It has its own clock: a
 * walk has no place on the project timeline yet.
 */
function WalkPlayer({
  projectId,
  walk,
  record,
  src,
  levelled,
  level,
}: {
  projectId: string;
  walk: WalkLayer;
  /** The walk's `walk.json` as main listed it (frame rate, sound); absent until it answers. */
  record: WalkFile | undefined;
  /** The video to play (`playbackRef`): the levelled copy or the playback copy. */
  src: AssetRef;
  /** The walk has a levelled copy: the bar offers **Level horizon**. */
  levelled: boolean;
  level: boolean;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const view = useRef<PanoVideoView | null>(null);
  const look = useRef<PanoLook>(START);
  const drag = useRef<{ x: number; y: number; x0: number; y0: number } | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [shown, setShown] = useState<PanoLook>(START);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(walk.durationS);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [sound, setSound] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // where the other copy stopped when Level horizon switched copies: the new one goes on there
  const resume = useRef<{ time: number; play: boolean } | null>(null);
  const srcKey = 'path' in src ? src.path : `hash:${src.hash}`;
  const url = assetUrl(projectId, src);
  // Place walk: the session follows this player's time, seeks it, and takes Align view clicks
  const aiming = useStore(placeSession, (s) => s.layerId === walk.id && s.armed === 'align-360');
  const seekReq = useStore(placeUi, (s) => (s.layerId === walk.id ? s.seek : null));
  const heading = useWalkViewHeading(walk, time);
  const audio = record?.video.audio ?? false;
  const poster = walk.poster ? assetUrl(projectId, walk.poster) : undefined;
  // detections on this walk's frames (local detection writes them as drafts for the review)
  const allDetections = useDetections((s) => s.review.detections);
  const { classById } = useTaxonomy();
  const [showDets, setShowDets] = useState(true);
  const walkDets = useMemo(
    () => allDetections.filter((d) => d.source.kind === 'frame' && d.source.layer === walk.id),
    [allDetections, walk.id],
  );
  const nearDets = useMemo(() => framesNear(walkDets, walk.id, time), [walkDets, walk.id, time]);
  const overlayBoxes = useMemo<OverlayBox[]>(
    () => nearDets.map((d) => ({ detection: d, ...detectionLook(d, classById.get(d.classId)) })),
    [nearDets, classById],
  );
  // the boxes are in the playback copy's pixels: the levelled copy is turned and cannot show them
  const onLevelled = levelled && level;

  const setLook = (next: PanoLook) => {
    look.current = next;
    view.current?.setLook(next);
    setShown(next);
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    // aio:// answers with CORS headers so WebGL can read the frames
    v.crossOrigin = 'anonymous';
    v.disablePictureInPicture = true;
    v.src = url;
    video.current = v;
    // the player is made per walk: another copy of the same walk keeps where the person looks

    let pano: PanoVideoView | null = null;
    try {
      pano = createPanoVideoView(el, v, look.current);
      view.current = pano;
    } catch {
      queueMicrotask(() => {
        setStatus('no-graphics');
      });
    }
    const onReady = () => {
      setStatus((s) => (s === 'no-graphics' ? s : 'ready'));
      const at = resume.current;
      if (at) {
        resume.current = null;
        v.currentTime = at.time;
        if (at.play) v.play().catch(() => undefined);
      }
      if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    };
    const onTime = () => {
      setTime(v.currentTime);
      const place = placeSession.getState();
      if (place.layerId === walk.id) place.setTime(v.currentTime);
    };
    const onPlay = () => {
      setPlaying(!v.paused && !v.ended);
    };
    const onError = () => {
      setStatus((s) => (s === 'no-graphics' ? s : 'error'));
    };
    const onRate = () => {
      setRate(v.playbackRate);
    };
    v.addEventListener('loadeddata', onReady);
    v.addEventListener('durationchange', onReady);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('seeked', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPlay);
    v.addEventListener('ended', onPlay);
    v.addEventListener('ratechange', onRate);
    v.addEventListener('error', onError);
    // the map and the drawings show where this walk is, from the moment it has loaded
    const stopPublish = publishWalkPlayback(v, walk.id);

    // the wheel zooms the view and must not scroll the page behind it
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const next = zoomLook(look.current, e.deltaY);
      look.current = next;
      pano?.setLook(next);
      setShown(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // the view's size places the north tick
    const sized =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            setBox({ w: el.clientWidth, h: el.clientHeight });
          });
    sized?.observe(el);

    return () => {
      sized?.disconnect();
      el.removeEventListener('wheel', onWheel);
      v.removeEventListener('loadeddata', onReady);
      v.removeEventListener('durationchange', onReady);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('seeked', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPlay);
      v.removeEventListener('ended', onPlay);
      v.removeEventListener('ratechange', onRate);
      v.removeEventListener('error', onError);
      stopPublish();
      resume.current = { time: v.currentTime, play: !v.paused && !v.ended };
      pano?.dispose();
      view.current = null;
      video.current = null;
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
  }, [url, walk.id]);

  // the review's detections, read once per project (the review screen reads them again)
  useEffect(() => {
    void loadDetections(projectId);
  }, [projectId]);

  // a seek asked by Place walk (the start or end of the walk, a pin's moment)
  useEffect(() => {
    const v = video.current;
    if (!seekReq || !v) return;
    const end = Number.isFinite(v.duration) ? v.duration : seekReq.t;
    v.currentTime = Math.max(0, Math.min(end, seekReq.t));
  }, [seekReq]);

  const toggle = (play: boolean) => {
    const v = video.current;
    if (!v) return;
    if (play) {
      if (v.ended) v.currentTime = 0;
      v.play().catch(() => undefined);
    } else v.pause();
  };

  const seek = (seconds: number) => {
    const v = video.current;
    if (!v) return;
    const end = Number.isFinite(v.duration) ? v.duration : duration;
    v.currentTime = Math.max(0, Math.min(end, seconds));
    setTime(v.currentTime);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // modified keys are app shortcuts, not the player's
    const v = video.current;
    if (!v || e.altKey || e.ctrlKey || e.metaKey) return;
    const a = walkKeyAction(e.key, {
      playing: !v.paused && !v.ended,
      rate: v.playbackRate,
      fps: record?.video.fps ?? DEFAULT_FPS,
    });
    if (!a) return;
    e.preventDefault();
    // a key the player took goes no further: window listeners that do not look at
    // defaultPrevented (K adds a keyframe in the video annotator) must not act on it too
    e.stopPropagation();
    if (a.rate !== undefined) v.playbackRate = a.rate;
    if (a.play !== undefined) toggle(a.play);
    if (a.seekBy !== undefined) seek(v.currentTime + a.seekBy);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    setLook(
      dragLook(look.current, e.clientX - from.x, e.clientY - from.y, e.currentTarget.clientHeight),
    );
    drag.current = { ...from, x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    drag.current = null;
    setDragging(false);
    // Align view: a click (not a drag) on a landmark gives its direction in the camera frame
    if (!from || !aiming || Math.hypot(e.clientX - from.x0, e.clientY - from.y0) > CLICK_PX) return;
    const r = e.currentTarget.getBoundingClientRect();
    placeSession
      .getState()
      .align360(
        viewClickYawRad(look.current, e.clientX - r.left, e.clientY - r.top, r.width, r.height),
      );
  };
  const onCancel = () => {
    drag.current = null;
    setDragging(false);
  };
  const north =
    heading !== null && status === 'ready' && box.w > 0 && box.h > 0
      ? northTick(shown, heading, box.w, box.h)
      : null;

  const message =
    status === 'loading'
      ? t('walk.loading')
      : status === 'error'
        ? t('walk.error')
        : status === 'no-graphics'
          ? t('walk.noGraphics')
          : null;

  return (
    <>
      <div
        ref={host}
        className={`fill-col walk-view${dragging ? ' dragging' : ''}${aiming ? ' aiming' : ''}`}
        tabIndex={0}
        role="application"
        aria-label={t('walk.view', { name: walk.name })}
        data-testid="walk-view"
        data-status={status}
        data-src={srcKey}
        // the poster stands in while the first frame loads
        style={
          poster && status === 'loading'
            ? {
                backgroundImage: `url("${poster}")`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }
            : undefined
        }
        data-yaw={shown.yawDeg.toFixed(1)}
        data-pitch={shown.pitchDeg.toFixed(1)}
        data-fov={shown.fovDeg.toFixed(1)}
        onKeyDown={onKey}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
      >
        {north && (
          <span
            className={north.edge === 'in' ? 'walk-north' : 'walk-north edge'}
            data-testid="walk-north"
            title="North"
            style={{ left: `clamp(8px, ${(north.x * 100).toFixed(2)}%, calc(100% - 8px))` }}
          >
            N
          </span>
        )}
        {walkDets.length > 0 &&
          showDets &&
          status === 'ready' &&
          !onLevelled &&
          box.w > 0 &&
          box.h > 0 && (
            <WalkDetOverlay boxes={overlayBoxes} look={shown} width={box.w} height={box.h} />
          )}
        {walkDets.length > 0 && showDets && status === 'ready' && onLevelled && (
          <div className="walk-det-note" role="note" data-testid="walk-det-level-note">
            {t('walk.det.levelNote')}
          </div>
        )}
        {message && (
          <div className="walk-status" role="status">
            {message}
          </div>
        )}
      </div>
      <div className="pane-bar walk-bar" data-testid="walk-bar" data-time={time.toFixed(2)}>
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="walk-play"
          aria-label={t(playing ? 'walk.pause' : 'walk.play')}
          title={`${t(playing ? 'walk.pause' : 'walk.play')} (Space)`}
          disabled={status !== 'ready'}
          onClick={() => {
            toggle(!playing);
          }}
        >
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <span className="mono" data-testid="walk-time">
          {t('walk.time', { now: formatWalkTime(time), total: formatWalkTime(duration) })}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0.01, duration)}
          step={0.01}
          value={Math.min(time, duration)}
          aria-label={t('walk.scrub')}
          aria-valuetext={t('walk.time.spoken', {
            now: formatWalkTime(time),
            total: formatWalkTime(duration),
          })}
          data-testid="walk-scrub"
          disabled={status !== 'ready'}
          onChange={(e) => {
            seek(Number(e.target.value));
          }}
        />
        {rate !== 1 && (
          <span className="mono faint" data-testid="walk-rate">
            {String(rate)}x
          </span>
        )}
        <span className="grow" />
        {walkDets.length > 0 && (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="walk-det-toggle"
            aria-pressed={showDets}
            onClick={() => {
              setShowDets(!showDets);
            }}
          >
            {t('walk.det.show')}
          </button>
        )}
        {levelled && (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="walk-level"
            aria-pressed={level}
            title={t('walk.level.tip')}
            onClick={() => {
              walks.getState().setLevel(walk.id, !level);
            }}
          >
            {t('walk.level')}
          </button>
        )}
        <button
          type="button"
          className="btn sm ghost"
          data-testid="walk-sound"
          aria-pressed={sound}
          disabled={!audio}
          title={audio ? undefined : t('walk.sound.none')}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            v.muted = sound;
            setSound(!sound);
          }}
        >
          {t('walk.sound')}
        </button>
        <SpotHistoryButton
          open={{
            item: { kind: 'walk', layer: walk.id, t: time },
            // the compass bearing of the look; none while the walk is not placed
            ...(heading !== null
              ? { lookDeg: wrapDeg(bearingFromHeadingRad(heading) + shown.yawDeg) }
              : {}),
          }}
        />
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="walk-reset"
          aria-label={t('walk.resetView')}
          title={t('walk.resetView')}
          onClick={() => {
            setLook(START);
          }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
    </>
  );
}

/** The split pane: the chosen walk (or the first), with a chooser when there are several. */
export function Walk360Pane() {
  const t = useT();
  const projectId = useWorkspace((s) => s.project?.id);
  const list = useWalks((s) => s.walks);
  const selected = useWalks((s) => s.selected);
  const records = useWalks((s) => s.records);
  const walk = pickWalk(list, selected);
  const processed = useWalks((s) => (walk ? s.processed[walkFolderId(walk)] : undefined));
  const level = useWalks((s) => (walk ? levelOn(s.level, walk.id) : true));
  if (!projectId || !walk) return <p className="pane-empty">{t('walk.none')}</p>;
  const record = records[walkRecordKey(walk)];
  const levelled = processed?.stabilized !== undefined;
  return (
    <div className="pane-col" data-testid="walk-360" data-walk={walkFolderId(walk)}>
      <div className="pane-bar">
        <Icon name="pano" size={14} className="muted" />
        {list.length > 1 ? (
          <select
            className="input"
            aria-label={t('walk.which')}
            data-testid="walk-which"
            value={walk.id}
            onChange={(e) => {
              walks.getState().select(e.target.value);
            }}
          >
            {list.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="walk-name">{walk.name}</span>
        )}
        {record?.source.lowRes && <span className="faint">{t('walk.lowRes')}</span>}
        {record && walkUnstabilised(record) && !(level && levelled) && (
          <span className="faint" title={t('walk.rawHint')} data-testid="walk-unstabilised">
            {t('walk.unstabilised')}
          </span>
        )}
      </div>
      <PlaceWalkHere at="walk" />
      <WalkPlayer
        key={walk.id}
        projectId={projectId}
        walk={walk}
        record={record}
        src={playbackRef(walk, processed, level)}
        levelled={levelled}
        level={level}
      />
    </div>
  );
}
