import type { ChangeSet, DateShift, ProjectManifest } from '@aio/schema';
import { captureShift } from '@aio/workspace';

/**
 * Whether a change set was computed before one of its dates was lined up (or its line-up
 * changed): the shifts it recorded, an absent side meaning none, against the dates' shifts now,
 * within a millimetre.
 */

const TOLERANCE_M = 0.001;

const shiftOfDate = (m: Pick<ProjectManifest, 'captures'>, id: string): DateShift | null =>
  captureShift({ captures: m.captures, layers: [] }, id);

const differs = (a: DateShift | null | undefined, b: DateShift | null): boolean =>
  Math.abs((a?.eastM ?? 0) - (b?.eastM ?? 0)) > TOLERANCE_M ||
  Math.abs((a?.northM ?? 0) - (b?.northM ?? 0)) > TOLERANCE_M;

export function changeSetStale(set: ChangeSet, m: Pick<ProjectManifest, 'captures'>): boolean {
  return (
    differs(set.lineUp?.from, shiftOfDate(m, set.from)) ||
    differs(set.lineUp?.to, shiftOfDate(m, set.to))
  );
}

/** The shifts of a pair's dates for a set being written (absent when both are zero). */
export function lineUpOfPair(
  m: Pick<ProjectManifest, 'captures'>,
  from: string,
  to: string,
): ChangeSet['lineUp'] | undefined {
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  const side = (id: string): DateShift | undefined => {
    const s = shiftOfDate(m, id);
    return s ? { eastM: mm(s.eastM), northM: mm(s.northM) } : undefined;
  };
  const f = side(from);
  const t = side(to);
  return f || t ? { ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) } : undefined;
}
