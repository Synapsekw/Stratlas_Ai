import type { ChangeSet, DateShift, ProjectManifest } from '@aio/schema';
import { isZeroShift } from '@aio/schema';
import { captureShift, shiftKey } from '@aio/workspace';

/**
 * Whether a change set was computed before one of its dates was lined up (or its line-up
 * changed): the shifts it recorded, an absent side meaning none, against the dates' shifts now,
 * within a millimetre.
 */

type Source = Pick<ProjectManifest, 'captures' | 'origin'>;

const shiftOfDate = (m: Source, id: string): DateShift | null =>
  captureShift({ captures: m.captures, layers: [], origin: m.origin }, id);

/** Whether two shifts differ: their keys (millimetre east/north, and the turn) are not equal. */
const differs = (a: DateShift | null | undefined, b: DateShift | null): boolean =>
  shiftKey(isZeroShift(a) ? null : a) !== shiftKey(b);

export function changeSetStale(set: ChangeSet, m: Source): boolean {
  return (
    differs(set.lineUp?.from, shiftOfDate(m, set.from)) ||
    differs(set.lineUp?.to, shiftOfDate(m, set.to))
  );
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
