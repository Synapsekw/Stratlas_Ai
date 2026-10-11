import { PANO_FOV, dragLook, zoomLook, type PanoLook } from '@aio/engine';
import type { WalkFile } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { createPanoVideoView, type PanoVideoView } from '@aio/video';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatWalkTime, pickWalk, walkKeyAction } from './walkModel';
import { useWalks, walks } from './walks';

/** Where the view starts: along the picture centre, level, at the panorama viewer's zoom. */
const START: PanoLook = { yawDeg: 0, pitchDeg: 0, fovDeg: PANO_FOV.start };

type Status = 'loading' | 'ready' | 'error' | 'no-graphics';

/**
 * The look-around player of one walk: its equirectangular playback copy on the inside of a
 * sphere. Drag to look, wheel to zoom, the bar below plays and scrubs. It has its own clock: a
 * walk has no place on the project timeline yet.
 */
function WalkPlayer({ projectId, walk }: { projectId: string; walk: WalkFile }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const view = useRef<PanoVideoView | null>(null);
  const look = useRef<PanoLook>(START);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [shown, setShown] = useState<PanoLook>(START);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(walk.video.durationS);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [sound, setSound] = useState(false);
  const [dragging, setDragging] = useState(false);

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
    v.src = assetUrl(projectId, { path: walk.video.src });
    video.current = v;
    look.current = START;

    let pano: PanoVideoView | null = null;
    try {
      pano = createPanoVideoView(el, v, START);
      view.current = pano;
    } catch {
      queueMicrotask(() => {
        setStatus('no-graphics');
      });
    }
    const onReady = () => {
      setStatus((s) => (s === 'no-graphics' ? s : 'ready'));
      if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    };
    const onTime = () => {
      setTime(v.currentTime);
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

    // the wheel zooms the view and must not scroll the page behind it
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const next = zoomLook(look.current, e.deltaY);
      look.current = next;
      pano?.setLook(next);
      setShown(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    return () => {
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
      pano?.dispose();
      view.current = null;
      video.current = null;
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
  }, [projectId, walk.video.src]);

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
      fps: walk.video.fps,
    });
    if (!a) return;
    e.preventDefault();
    if (a.rate !== undefined) v.playbackRate = a.rate;
    if (a.play !== undefined) toggle(a.play);
    if (a.seekBy !== undefined) seek(v.currentTime + a.seekBy);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    setLook(
      dragLook(look.current, e.clientX - from.x, e.clientY - from.y, e.currentTarget.clientHeight),
    );
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => {
    drag.current = null;
    setDragging(false);
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
    <>
      <div
        ref={host}
        className={`fill-col walk-view${dragging ? ' dragging' : ''}`}
        tabIndex={0}
        role="application"
        aria-label={t('walk.view', { name: walk.name })}
        data-testid="walk-view"
        data-status={status}
        data-yaw={shown.yawDeg.toFixed(1)}
        data-pitch={shown.pitchDeg.toFixed(1)}
        data-fov={shown.fovDeg.toFixed(1)}
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
        <button
          type="button"
          className="btn sm ghost"
          data-testid="walk-sound"
          aria-pressed={sound}
          disabled={!walk.video.audio}
          title={walk.video.audio ? undefined : t('walk.sound.none')}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            v.muted = sound;
            setSound(!sound);
          }}
        >
          {t('walk.sound')}
        </button>
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
  const walk = pickWalk(list, selected);
  if (!projectId || !walk) return <p className="pane-empty">{t('walk.none')}</p>;
  return (
    <div className="pane-col" data-testid="walk-360" data-walk={walk.id}>
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
        {walk.source.lowRes && <span className="faint">{t('walk.lowRes')}</span>}
      </div>
      <WalkPlayer key={walk.id} projectId={projectId} walk={walk} />
    </div>
  );
}
