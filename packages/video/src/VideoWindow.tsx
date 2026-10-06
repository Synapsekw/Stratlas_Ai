import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { videoTimeForClock } from './clock';
import type { Flight } from './flight';
import { acquirePlayer, releasePlayer, type ClipPlayer } from './player';
import { findVideoLayer, loadLayerFlight, videoStore } from './runtime';
import { formatTimecode, telemetryAt } from './telemetry';

export interface VideoWindowProps {
  /** Video layer id from the manifest. */
  layerId: string;
  className?: string;
  /** Overlay slot above the video (annotation tools, stream S7/S8). Fills the frame. */
  children?: ReactNode;
}

const hudText: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 11,
  lineHeight: 1.35,
  color: '#e8eef7',
  textShadow: '0 1px 2px rgba(0,0,0,.8)',
  letterSpacing: '0.02em',
};
const chip: CSSProperties = {
  background: 'rgba(8,14,24,.62)',
  borderRadius: 4,
  padding: '3px 7px',
  whiteSpace: 'nowrap',
};

function stepFrame(player: ClipPlayer, dir: 1 | -1) {
  const s = videoStore().getState();
  s.pause();
  s.setTime(s.nowMs + (dir * 1000) / player.fps);
}

/**
 * A video window synced to the project clock, with the Mission telemetry HUD (altitude, speed,
 * gimbal, heading, timecode). Keys: J / K / L (back, pause, play and faster), comma and period or
 * the arrow keys step one frame. Annotation tools mount inside it through `children`.
 */
export function VideoWindow({ layerId, className, children }: VideoWindowProps) {
  const host = useRef<HTMLDivElement>(null);
  const [player, setPlayer] = useState<ClipPlayer | null>(null);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const nowMs = useWorkspace((s) => s.nowMs);
  const playing = useWorkspace((s) => s.playing);
  const layer = useWorkspace(() => findVideoLayer(layerId));
  const name = layer?.name ?? layerId;

  useEffect(() => {
    const el = host.current;
    if (!el || !layer) return;
    let player: ClipPlayer;
    try {
      player = acquirePlayer(layerId);
    } catch (e) {
      queueMicrotask(() => {
        setError((e as Error).message);
      });
      return;
    }
    const v = player.video;
    Object.assign(v.style, {
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      display: 'block',
    });
    el.appendChild(v);
    const bump = () => {
      setTick((n) => n + 1);
    };
    const off = player.subscribe(bump);
    queueMicrotask(() => {
      setPlayer(player);
    });
    let live = true;
    loadLayerFlight(layer)
      .then((f) => {
        if (live) setFlight(f);
      })
      .catch((e: unknown) => {
        if (live) setError((e as Error).message);
      });
    return () => {
      live = false;
      off();
      v.remove();
      releasePlayer(layerId);
      queueMicrotask(() => {
        setPlayer((p) => (p === player ? null : p));
      });
    };
  }, [layerId, layer]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!player) return;
    const s = videoStore().getState();
    const k = e.key.toLowerCase();
    if (k === 'k' || k === ' ') {
      s.pause();
      s.setRate(1);
    } else if (k === 'l') {
      if (!s.playing || s.activeClip !== layerId) {
        s.setActiveClip(layerId);
        s.setRate(1);
        s.play();
      } else s.setRate(Math.min(8, s.rate * 2));
    } else if (k === 'j') {
      if (s.playing && s.rate > 1) s.setRate(s.rate / 2);
      else {
        s.pause();
        s.setTime(s.nowMs - 1000);
      }
    } else if (k === ',' || k === 'arrowleft') stepFrame(player, -1);
    else if (k === '.' || k === 'arrowright') stepFrame(player, 1);
    else return;
    e.preventDefault();
  };

  const tele = flight ? telemetryAt(flight.samples, nowMs - flight.startUtcMs) : null;
  const vt = layer
    ? videoTimeForClock(
        { startUtcMs: layer.flight.startUtcMs, offsetMs: layer.offsetMs, durationS: NaN },
        nowMs,
      )
    : 0;
  const status = error ? 'error' : (player?.status ?? 'loading');
  const clock = new Date(nowMs).toISOString().slice(11, 19);

  return (
    <div
      className={className}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`Video ${name}`}
      data-video-window={layerId}
      style={{ position: 'relative', overflow: 'hidden', background: '#05080d', outline: 'none' }}
    >
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div style={{ position: 'absolute', inset: 0 }}>{children}</div>
      {status !== 'ready' && (
        <div
          role="status"
          style={{
            ...hudText,
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            fontSize: 13,
            background: status === 'no-footage' ? 'rgba(5,8,13,.78)' : 'transparent',
            pointerEvents: 'none',
          }}
        >
          {status === 'no-footage'
            ? 'No footage at this time'
            : status === 'error'
              ? (error ?? player?.error ?? 'Video unavailable')
              : 'Loading video'}
        </div>
      )}
      <div
        style={{
          ...hudText,
          position: 'absolute',
          top: 8,
          left: 8,
          right: 8,
          display: 'flex',
          gap: 6,
          pointerEvents: 'none',
        }}
      >
        <span style={chip} data-hud="clip">
          <span
            role="img"
            aria-label={playing ? 'Recording time running' : 'Paused'}
            style={{
              display: 'inline-block',
              width: 7,
              height: 7,
              borderRadius: '50%',
              marginRight: 6,
              background: playing && player?.playing ? '#ff4d4f' : '#5c6675',
              boxShadow: playing && player?.playing ? '0 0 6px #ff4d4f' : 'none',
            }}
          />
          {name}
        </span>
        <span style={{ ...chip, marginLeft: 'auto' }} data-hud="timecode">
          {formatTimecode(Math.max(0, vt), player?.fps ?? 30)} · {clock} UTC
        </span>
      </div>
      {tele && (
        <div
          style={{
            ...hudText,
            position: 'absolute',
            left: 8,
            bottom: 8,
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            pointerEvents: 'none',
          }}
        >
          <span style={chip} data-hud="alt">
            ALT {tele.altitudeM.toFixed(1)} m
          </span>
          <span style={chip} data-hud="speed">
            SPD {tele.speedMps.toFixed(1)} m/s
          </span>
          <span style={chip} data-hud="gimbal">
            GIM {tele.pitchDeg.toFixed(1)}°
          </span>
          <span style={chip} data-hud="heading">
            HDG {Math.round(tele.headingDeg).toString().padStart(3, '0')}°
          </span>
        </div>
      )}
    </div>
  );
}
