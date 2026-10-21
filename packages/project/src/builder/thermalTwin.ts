import type { PhotoRef, Quat, Vec3 } from '@aio/schema';
import { slug } from './create';
import type { PhotoMeta } from './exif';

/*
 * Thermal twins (photo position edit, 21 Oct 2026). A dual camera such as the DJI Zenmuse XT2
 * takes a thermal `_R` photo and a visual photo at the same moment. Thermals written by the FLIR
 * core carry no DJI XMP: no take-off relative height, no gimbal angles, a rounded lat/lon and
 * sometimes a wrapped altitude. Such a photo takes its visual twin's place and view direction,
 * stored as a correction so it shows "Edited" and Reset puts it back.
 */

/** Two photos of one pair are at most this far apart in capture time. */
const TWIN_GAP_MS = 3000;

/** The stem of a thermal file name: ends `_R` before `.jpg` or `.jpeg`, any case. */
const THERMAL_NAME = /_r\.jpe?g$/i;

/**
 * True for a thermal `_R` photo without DJI XMP that has a lat/lon (the correction needs the
 * photo's own place as its base). The altitude does not matter.
 */
export function needsTwin(name: string, meta: PhotoMeta): boolean {
  if (!THERMAL_NAME.test(name)) return false;
  if (meta.dji !== undefined) return false;
  return meta.gps !== undefined;
}

/** A photo by its file name or its project id, with its capture time and imported pose. */
export interface TwinCandidate {
  /** File name (`X_0006.jpg`) or photo id (`x-0006`): both compare by their slug. */
  name: string;
  /** ISO time with offset (`PhotoRef.takenAt`). */
  takenAt?: string;
  pos?: Vec3;
  q?: Quat;
  /** The candidate is itself a thermal waiting for a twin: never a twin. */
  needsTwin?: boolean;
}

/** `x-0005-r` for `X_0005_R.JPG` and for the id `x-0005-r`. */
const key = (name: string) => slug(name.replace(/\.jpe?g$/i, ''), '');

const time = (t: string | undefined) => (t === undefined ? Number.NaN : Date.parse(t));

/**
 * The visual twin of a thermal photo: same prefix and zero padding, number N + 1, then N - 1,
 * the first that exists, is placed, is not a thermal itself and was taken within 3 s of the
 * thermal (both must have a time). Null when there is none.
 */
export function findTwin<T extends TwinCandidate>(
  thermal: { name: string; takenAt?: string },
  candidates: readonly T[],
): T | null {
  const m = /^(.*?)(\d+)-r$/.exec(key(thermal.name));
  const at = time(thermal.takenAt);
  if (!m || Number.isNaN(at)) return null;
  const prefix = m[1] ?? '';
  const digits = m[2] ?? '';
  const n = Number(digits);
  for (const k of [n + 1, n - 1]) {
    if (k < 0) continue;
    const want = `${prefix}${String(k).padStart(digits.length, '0')}`;
    const hit = candidates.find((c) => key(c.name) === want);
    if (hit === undefined) continue;
    const t = time(hit.takenAt);
    if (hit.pos === undefined || hit.needsTwin === true || Number.isNaN(t)) continue;
    if (Math.abs(t - at) <= TWIN_GAP_MS) return hit;
  }
  return null;
}

const round01mm = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

/**
 * What a twin gives a thermal: the offset from its own place to the twin's (0.1 mm steps) and the
 * twin's view direction when it has one. Null when either has no place.
 */
export function twinFix(
  own: Pick<PhotoRef, 'pos'>,
  twin: Pick<PhotoRef, 'pos' | 'q'>,
): { offsetM: Vec3; q?: Quat } | null {
  if (!own.pos || !twin.pos) return null;
  const a = own.pos;
  const b = twin.pos;
  const offsetM: Vec3 = [round01mm(b[0] - a[0]), round01mm(b[1] - a[1]), round01mm(b[2] - a[2])];
  return twin.q ? { offsetM, q: twin.q } : { offsetM };
}
