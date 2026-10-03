import {
  clipWindow,
  clockForVideoTime,
  syncDecision,
  type ClipTiming,
  type SyncAction,
} from './clock';
import { findVideoLayer, resolveAsset, videoStore, type VideoLayer } from './runtime';

export type PlayerStatus = 'loading' | 'ready' | 'no-footage' | 'error';

/**
 * One `<video>` element for one video layer, kept in sync with the project clock by the rules in
 * `clock.ts`. Shared by every consumer of the clip (video windows, the 3D projector) through
 * `acquirePlayer` / `releasePlayer`, so a clip is decoded once.
 */
export class ClipPlayer {
  readonly video: HTMLVideoElement;
  readonly layer: VideoLayer;
  status: PlayerStatus = 'loading';
  error: string | null = null;
  /** Frame rate estimated from presented frames (30 until known). */
  fps = 30;
  private lastAction: SyncAction | null = null;
  private lastWrittenMs: number | null = null;
  private lastMediaTime = -1;
  private readonly listeners = new Set<() => void>();
  private readonly unsub: () => void;
  private disposed = false;
  private rvfcId = 0;

  constructor(layer: VideoLayer) {
    this.layer = layer;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    // aio:// must answer with CORS headers so WebGL and canvas can read the frames.
    v.crossOrigin = 'anonymous';
    v.disablePictureInPicture = true;
    v.src = resolveAsset(layer.src);
    this.video = v;
    v.addEventListener('loadedmetadata', this.onMeta);
    v.addEventListener('ended', this.onEnded);
    v.addEventListener('error', this.onError);
    v.addEventListener('seeked', this.emit);
    v.addEventListener('play', this.emit);
    v.addEventListener('pause', this.emit);
    this.unsub = videoStore().subscribe(this.apply);
    this.scheduleFrame();
    this.apply();
  }

  get timing(): ClipTiming {
    return {
      startUtcMs: this.layer.flight.startUtcMs,
      offsetMs: this.layer.offsetMs,
      durationS: this.video.duration,
    };
  }

  /** Clip extent on the project clock (end is the start until metadata is loaded). */
  get window(): { startMs: number; endMs: number } {
    return clipWindow(this.timing);
  }

  get playing(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Resolves once the frame for the current clock time is decoded. */
  async ready(): Promise<void> {
    const v = this.video;
    if (v.readyState < 2 || v.seeking) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (v.readyState >= 2 && !v.seeking) {
            cleanup();
            resolve();
          }
        };
        const fail = () => {
          cleanup();
          reject(new Error(this.error ?? 'Video failed to load'));
        };
        const cleanup = () => {
          v.removeEventListener('loadeddata', done);
          v.removeEventListener('seeked', done);
          v.removeEventListener('error', fail);
        };
        v.addEventListener('loadeddata', done);
        v.addEventListener('seeked', done);
        v.addEventListener('error', fail);
      });
    }
  }

  private readonly emit = () => {
    for (const l of this.listeners) l();
  };

  private readonly onMeta = () => {
    this.apply();
    this.emit();
  };

  private readonly onEnded = () => {
    const s = videoStore().getState();
    if (s.playing && s.activeClip === this.layer.id) {
      s.pause();
      s.setTime(this.window.endMs);
    }
  };

  private readonly onError = () => {
    this.status = 'error';
    this.error = `Could not play ${this.layer.name}`;
    this.emit();
  };

  private scheduleFrame() {
    if (this.disposed) return;
    const v = this.video;
    if ('requestVideoFrameCallback' in v) {
      this.rvfcId = v.requestVideoFrameCallback((_now, meta) => {
        this.onFrame(meta.mediaTime);
        this.scheduleFrame();
      });
    } else {
      requestAnimationFrame(() => {
        this.onFrame((v as HTMLVideoElement).currentTime);
        this.scheduleFrame();
      });
    }
  }

  /** A new frame is on screen: the master writes the clock from it (frame accurate). */
  private onFrame(mediaTime: number) {
    const dt = mediaTime - this.lastMediaTime;
    if (dt > 0.005 && dt < 0.1 && this.playing) {
      const est = 1 / dt;
      const snapped = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60].reduce((a, b) =>
        Math.abs(b - est) < Math.abs(a - est) ? b : a,
      );
      if (Math.abs(snapped - est) < 2) this.fps = snapped;
    }
    this.lastMediaTime = mediaTime;
    if (this.lastAction?.kind === 'drive' && this.playing) {
      const t = clockForVideoTime(this.timing, mediaTime);
      this.lastWrittenMs = t;
      videoStore().getState().setTime(t);
    }
  }

  /** Applies the sync decision for the current workspace state. */
  readonly apply = () => {
    if (this.disposed) return;
    const s = videoStore().getState();
    const v = this.video;
    const master = s.activeClip === this.layer.id;
    const action = syncDecision({
      timing: this.timing,
      nowMs: s.nowMs,
      playing: s.playing,
      master,
      videoTimeS: v.currentTime,
      videoPaused: v.paused,
      lastWrittenMs: this.lastAction?.kind === 'drive' ? this.lastWrittenMs : null,
    });
    this.lastAction = action;
    if (action.kind !== 'drive') this.lastWrittenMs = null;
    const prevStatus = this.status;
    if (this.status !== 'error') {
      this.status =
        action.kind === 'no-footage' ? 'no-footage' : v.readyState >= 1 ? 'ready' : 'loading';
    }
    switch (action.kind) {
      case 'ended':
        s.pause();
        s.setTime(this.window.endMs);
        break;
      case 'no-footage':
        if (!v.paused) v.pause();
        break;
      case 'hold':
        if (!v.paused) v.pause();
        if (action.seekTo !== undefined && v.readyState >= 1) v.currentTime = action.seekTo;
        break;
      case 'drive':
      case 'follow':
        if (action.seekTo !== undefined && v.readyState >= 1) {
          v.currentTime = action.seekTo;
          if (action.kind === 'drive')
            this.lastWrittenMs = clockForVideoTime(this.timing, action.seekTo);
        }
        if (v.playbackRate !== s.rate) v.playbackRate = s.rate;
        if (v.paused) v.play().catch(() => undefined);
        break;
    }
    if (prevStatus !== this.status) this.emit();
  };

  dispose() {
    this.disposed = true;
    this.unsub();
    const v = this.video;
    if ('cancelVideoFrameCallback' in v && this.rvfcId) v.cancelVideoFrameCallback(this.rvfcId);
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
    this.listeners.clear();
  }
}

const players = new Map<string, { player: ClipPlayer; refs: number }>();

/** Shared player for a video layer; call `releasePlayer` when done. */
export function acquirePlayer(layerId: string): ClipPlayer {
  const hit = players.get(layerId);
  if (hit) {
    hit.refs += 1;
    return hit.player;
  }
  const layer = findVideoLayer(layerId);
  if (!layer) throw new Error(`No video layer "${layerId}" in the open project`);
  const player = new ClipPlayer(layer);
  players.set(layerId, { player, refs: 1 });
  return player;
}

export function releasePlayer(layerId: string): void {
  const hit = players.get(layerId);
  if (!hit) return;
  hit.refs -= 1;
  if (hit.refs <= 0) {
    players.delete(layerId);
    hit.player.dispose();
  }
}

export function getPlayer(layerId: string): ClipPlayer | undefined {
  return players.get(layerId)?.player;
}

/**
 * The current frame of a video layer as a JPEG data URL (for the AI stream). Uses the open player
 * when there is one, otherwise loads the clip at the project clock time.
 */
export async function captureFrame(layerId: string, quality = 0.9): Promise<string> {
  const player = acquirePlayer(layerId);
  try {
    await player.ready();
    const v = player.video;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext('2d');
    if (!g || !c.width) throw new Error('No video frame to capture');
    g.drawImage(v, 0, 0);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    releasePlayer(layerId);
  }
}
