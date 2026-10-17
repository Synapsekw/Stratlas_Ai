import {
  captureLineUpShift,
  isZeroShift,
  type DateShift,
  type Layer,
  type ProjectManifest,
} from '@aio/schema';
import { captureIndex, DATED_KINDS, type CaptureHints } from './captures';

/**
 * Which layer takes which date shift (line up dates, Decision 2). The layers `captureIndex`
 * files under a date without volume hints take that date's shift, when they are of a dated kind
 * and not a change result (computed in the lined-up frame already). The Python resolver follows
 * the same rules; one shared fixture holds them to the same answers.
 */

type Source = Pick<ProjectManifest, 'captures' | 'layers'>;

const memo = new WeakMap<object, Readonly<Record<string, DateShift>>>();

function movable(l: Layer): boolean {
  return DATED_KINDS.has(l.kind) && l.derived?.kind !== 'change';
}

/** The non-zero shift of every layer that moves, by layer id. */
export function layerDateShifts(m: Source): Readonly<Record<string, DateShift>> {
  const hit = memo.get(m);
  if (hit) return hit;
  const index = captureIndex(m);
  const shifts = new Map<string, DateShift>();
  for (const c of m.captures) {
    const s = captureLineUpShift(c);
    if (s && !isZeroShift(s)) shifts.set(c.id, s);
  }
  const out: Record<string, DateShift> = {};
  for (const l of m.layers) {
    const c = index.of[l.id];
    const s = c === undefined ? undefined : shifts.get(c);
    if (s && movable(l)) out[l.id] = s;
  }
  memo.set(m, out);
  return out;
}

/** The shift of one layer, or null when it does not move. */
export function dateShiftOf(m: Source, layerId: string): DateShift | null {
  return layerDateShifts(m)[layerId] ?? null;
}

/** The shift a survey date carries, or null when it has none (or is not in the project). */
export function captureShift(m: Source, captureId: string): DateShift | null {
  const c = m.captures.find((x) => x.id === captureId);
  const s = c ? captureLineUpShift(c) : null;
  return s && !isZeroShift(s) ? s : null;
}

/** A shift as a cache key, to the millimetre; empty for none. */
export function shiftKey(s: DateShift | null): string {
  if (!s) return '';
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  return `${mm(s.eastM)},${mm(s.northM)}`;
}

/**
 * The layers the volume hints file under `captureId` and the hintless index does not: they move
 * with the date only once they carry an explicit `capture`.
 */
export function hintOnlyLayers(m: Source, hints: CaptureHints, captureId: string): string[] {
  const plain = captureIndex(m).of;
  const hinted = captureIndex(m, hints).of;
  return m.layers
    .filter((l) => movable(l) && hinted[l.id] === captureId && plain[l.id] !== captureId)
    .map((l) => l.id);
}
