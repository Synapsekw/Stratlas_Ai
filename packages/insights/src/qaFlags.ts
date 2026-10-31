/**
 * QA fitness flags of a survey date (study item 5.5), pure: what a figure measured on that date
 * should be read with. A view worked out when read (the digest, later the report and the agent),
 * never stored: the QA files and the site level change after a figure is made. From the date's
 * survey QA file and the site's QA level:
 *
 * - `qa-hold`: a failed check holds the date and nobody released it;
 * - `qa-released`: a person released such a hold;
 * - `qa-unchecked`: the date has no QA file, or was checked at level Off (no verdict). The
 *   earliest date without a file has nothing to be checked against and is not flagged;
 * - `no-checkpoints`: its check had no checkpoints (a check against the previous survey only);
 * - `rmse-over-limit`: its checkpoint RMSE is over the site's limit.
 */
import type { ComparisonResult, QaLevel, SurveyQa } from '@aio/schema';

/** The flags, in the order they are given. */
export const QA_FLAGS = [
  'qa-hold',
  'qa-released',
  'qa-unchecked',
  'no-checkpoints',
  'rmse-over-limit',
] as const;
export type QaFlag = (typeof QA_FLAGS)[number];

/** RMSE limits by level, metres, as the QA panel and the pipeline use them. */
export const RMSE_LIMIT: Record<Exclude<QaLevel, 'off'>, number> = {
  strict: 0.05,
  moderate: 0.1,
  lenient: 0.2,
};

/** The site's checkpoint RMSE limit (its own `rmseM` replaces the level's); null at level Off. */
export function rmseLimit(level: QaLevel, rmseM?: number): number | null {
  if (level === 'off') return null;
  return rmseM ?? RMSE_LIMIT[level];
}

export interface QaFlagContext {
  /** QA files by capture id. */
  qa: Readonly<Record<string, SurveyQa>>;
  /** The project's survey dates. */
  captures: readonly { id: string; date: string }[];
  /** The site's checkpoint RMSE limit (`rmseLimit`), null without one. */
  rmseLimitM: number | null;
}

/** The earliest survey date's capture id (date, then id), or null without dates. */
export function earliestCapture(captures: readonly { id: string; date: string }[]): string | null {
  let best: { id: string; date: string } | null = null;
  for (const c of captures)
    if (!best || c.date < best.date || (c.date === best.date && c.id < best.id)) best = c;
  return best?.id ?? null;
}

/** The flags of one survey date, in `QA_FLAGS` order. */
export function qaFlagsFor(capture: string, ctx: QaFlagContext): QaFlag[] {
  const qa = ctx.qa[capture];
  if (!qa) {
    const known = ctx.captures.some((c) => c.id === capture);
    return known && earliestCapture(ctx.captures) !== capture ? ['qa-unchecked'] : [];
  }
  const flags: QaFlag[] = [];
  if (qa.status === 'hold' || qa.status === 'fail') flags.push('qa-hold');
  if (qa.status === 'released') flags.push('qa-released');
  if (qa.status === 'unchecked') flags.push('qa-unchecked');
  if (!qa.checkpoints || qa.checkpoints.count === 0) flags.push('no-checkpoints');
  else if (ctx.rmseLimitM !== null && qa.checkpoints.rmseM > ctx.rmseLimitM)
    flags.push('rmse-over-limit');
  return flags;
}

/** The date a result is for: its `to` capture, else its `from` one (as `seriesDate`). */
export const resultCapture = (r: Pick<ComparisonResult, 'toCapture' | 'fromCapture'>): string =>
  r.toCapture ?? r.fromCapture ?? '';

/** The flags of the date a result is for (none for a result without a date). */
export function resultQaFlags(
  r: Pick<ComparisonResult, 'toCapture' | 'fromCapture'>,
  ctx: QaFlagContext,
): QaFlag[] {
  const capture = resultCapture(r);
  return capture ? qaFlagsFor(capture, ctx) : [];
}
