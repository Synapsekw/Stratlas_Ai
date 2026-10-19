import type { CaptureLineUpTurn, ChangeSet, DateShift, ProjectManifest } from '@aio/schema';
import { isZeroShift, turnOf } from '@aio/schema';
import { captureShift, shiftKey } from '@aio/workspace';

/**
 * Whether a change set was computed before one of its dates was lined up (or its line-up
 * changed): the shifts it recorded, with their turns, an absent side meaning none, against the
 * dates' shifts now, within a millimetre (and the turn's own precision).
 */

type Source = Pick<ProjectManifest, 'captures' | 'origin'>;

const shiftOfDate = (m: Source, id: string): DateShift | null =>
  captureShift({ captures: m.captures, layers: [], origin: m.origin }, id);

/** A recorded side as a shift: its `lineUp` and its `lineUpTurn`, the pivot placed with `origin`. */
function recorded(
  shift: DateShift | undefined,
  turn: CaptureLineUpTurn | undefined,
  origin: Source['origin'],
): DateShift | null {
  if (!shift && !turn) return null;
  const s: DateShift = { eastM: shift?.eastM ?? 0, northM: shift?.northM ?? 0 };
  if (turn)
    s.turn = {
      rotationDeg: turn.rotationDeg,
      scale: turn.scale,
      pivotE: turn.pivotE,
      pivotN: turn.pivotN,
      pivotX: turn.pivotE - origin[0],
      pivotZ: origin[1] - turn.pivotN,
    };
  return s;
}

/** Whether two shifts differ: their keys (millimetre east/north, and the turn) are not equal. */
const differs = (a: DateShift | null, b: DateShift | null): boolean =>
  shiftKey(isZeroShift(a) ? null : a) !== shiftKey(b);

export function changeSetStale(set: ChangeSet, m: Source): boolean {
  const side = (k: 'from' | 'to') =>
    differs(recorded(set.lineUp?.[k], set.lineUpTurn?.[k], m.origin), shiftOfDate(m, set[k]));
  return side('from') || side('to');
}

/** The shifts of a pair's dates for a set being written (absent when both are zero). */
export function lineUpOfPair(m: Source, from: string, to: string): ChangeSet['lineUp'] | undefined {
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  const side = (id: string): DateShift | undefined => {
    const s = shiftOfDate(m, id);
    return s ? { eastM: mm(s.eastM), northM: mm(s.northM) } : undefined;
  };
  const f = side(from);
  const t = side(to);
  return f || t ? { ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) } : undefined;
}

/**
 * The turns of a pair's dates for a set being written, beside `lineUpOfPair` (absent when neither
 * date has one): without them a set computed on a turned date would read stale at once.
 */
export function lineUpTurnOfPair(
  m: Source,
  from: string,
  to: string,
): ChangeSet['lineUpTurn'] | undefined {
  const f = turnOf(shiftOfDate(m, from));
  const t = turnOf(shiftOfDate(m, to));
  return f || t ? { ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) } : undefined;
}
