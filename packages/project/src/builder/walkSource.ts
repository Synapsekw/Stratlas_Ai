import type { WalkLayout } from '@aio/schema';

/*
 * Recognising 360 video sources (pure, no file access): the names a 360 camera gives its files,
 * which file is the low resolution proxy of which clip, and how a file holds the picture, read
 * from its track list. Layouts that were not verified on a real file are refused with a message
 * that says what was found; nothing is guessed.
 */

/** One track of an MP4 file as the track reader reports it (`readMp4Tracks` in `@aio/video`). */
export interface WalkTrack {
  /** Handler type: `vide`, `soun`, ... */
  handler: string;
  width: number;
  height: number;
  codec: string;
  fps: number;
  durationMs: number;
  /** What the track's Spherical Video metadata says, when it has any. */
  spherical?: 'equirectangular' | 'other' | null;
}

/** Extensions only a 360 camera writes. */
const CAMERA_EXT = /\.(insv|lrv)$/i;
/** Extensions of a stitched video given through "Add 360 video". */
const STITCHED_EXT = /\.(mp4|mov)$/i;

/** A file a 360 camera wrote itself (`.insv`, `.lrv`), by its extension. */
export function isWalkFile(name: string): boolean {
  return CAMERA_EXT.test(name);
}

export interface Insta360Name {
  /** `clip` for the recording, `proxy` for its low resolution copy (`LRV_...`). */
  role: 'clip' | 'proxy';
  /** `YYYYMMDD_HHMMSS` as in the name. */
  stamp: string;
  /** The running number at the end of the name. */
  seq: string;
  /** The camera's local time, `YYYY-MM-DDTHH:MM:SS`. */
  capturedAt: string;
}

/** The parts of a name like `VID_20260101_120000_00_001.insv`, or null for any other name. */
export function insta360Name(name: string): Insta360Name | null {
  const m =
    /^(VID|LRV)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_\d{2}_(\d{3})\.(insv|lrv)$/i.exec(name);
  if (!m) return null;
  const [, prefix = '', y = '', mo = '', d = '', h = '', mi = '', s = '', seq = '', ext = ''] = m;
  const inRange = (v: string, lo: number, hi: number) => Number(v) >= lo && Number(v) <= hi;
  if (!inRange(mo, 1, 12) || !inRange(d, 1, 31) || !inRange(h, 0, 23)) return null;
  if (!inRange(mi, 0, 59) || !inRange(s, 0, 59)) return null;
  return {
    role: prefix.toUpperCase() === 'LRV' || ext.toLowerCase() === 'lrv' ? 'proxy' : 'clip',
    stamp: `${y}${mo}${d}_${h}${mi}${s}`,
    seq,
    capturedAt: `${y}-${mo}-${d}T${h}:${mi}:${s}`,
  };
}

/** A low resolution proxy by its name or extension. */
export function isProxyName(name: string): boolean {
  return /\.lrv$/i.test(name) || /^LRV_/i.test(name);
}

/**
 * The clip among `others` (file names) that `name` is the proxy of: same time stamp and running
 * number. Null when `name` is not a proxy or its clip is not there.
 */
export function proxyOwner(name: string, others: readonly string[]): string | null {
  const me = insta360Name(name);
  if (me?.role !== 'proxy') return null;
  return (
    others.find((o) => {
      const n = insta360Name(o);
      return n?.role === 'clip' && n.stamp === me.stamp && n.seq === me.seq;
    }) ?? null
  );
}

export type WalkSourceKind =
  | {
      ok: true;
      layout: WalkLayout;
      /** The video tracks the picture is made from (two lens streams, else one). */
      video: WalkTrack[];
      audio: boolean;
      /** A low resolution proxy, not the full clip. */
      lowRes: boolean;
    }
  | { ok: false; message: string };

const size = (t: WalkTrack) => `${String(t.width)} x ${String(t.height)}`;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * 0.02;

const SUPPORTED =
  'This version reads Insta360 files with one video track per lens (verified on the X4) and their LRV proxies.';
const STUDIO =
  'Export a stitched 360 video from Insta360 Studio and bring it in with Add 360 video.';

/**
 * How a file holds its 360 picture, from its name and track list. Camera files (`.insv`, `.lrv`)
 * are stitched; an MP4 or MOV must already be equirectangular (a 2:1 frame, or spherical
 * metadata that says so).
 */
export function classifyWalkSource(i: {
  name: string;
  tracks: readonly WalkTrack[];
}): WalkSourceKind {
  const video = i.tracks.filter((t) => t.handler === 'vide' && t.width > 0 && t.height > 0);
  const audio = i.tracks.some((t) => t.handler === 'soun');
  const [a, b] = video;
  if (!a) return { ok: false, message: 'The file has no video track.' };

  if (CAMERA_EXT.test(i.name)) {
    const proxy = isProxyName(i.name);
    if (video.length === 2 && b) {
      if (a.width !== b.width || a.height !== b.height)
        return {
          ok: false,
          message: `Two video tracks of different sizes (${size(a)} and ${size(b)}). ${SUPPORTED}`,
        };
      if (!near(a.width, a.height))
        return {
          ok: false,
          message: `Two video tracks of ${size(a)}, not square lens pictures. ${SUPPORTED}`,
        };
      return { ok: true, layout: 'insv-dual-stream', video: [a, b], audio, lowRes: proxy };
    }
    if (video.length === 1) {
      if (proxy && near(a.width, a.height * 2))
        return { ok: true, layout: 'dual-fisheye', video: [a], audio, lowRes: true };
      return {
        ok: false,
        message: `This file has one video track (${size(a)}). ${SUPPORTED} Clips that a camera splits over two files, and single track clips, are not read yet. ${STUDIO}`,
      };
    }
    return {
      ok: false,
      message: `This file has ${String(video.length)} video tracks. ${SUPPORTED} ${STUDIO}`,
    };
  }

  if (STITCHED_EXT.test(i.name)) {
    if (a.spherical === 'other')
      return {
        ok: false,
        message:
          'The video says it is spherical but not equirectangular. Export it as equirectangular (2:1), then add it again.',
      };
    if (a.spherical === 'equirectangular' || near(a.width, a.height * 2))
      return { ok: true, layout: 'equirect', video: [a], audio, lowRes: false };
    return {
      ok: false,
      message: `The frame is ${size(a)}, not a 2:1 equirectangular picture, and the file has no 360 metadata. Drone video is imported with Add data, together with its SRT.`,
    };
  }

  return {
    ok: false,
    message: '360 video is read from .insv and .lrv camera files and from stitched .mp4 or .mov.',
  };
}
