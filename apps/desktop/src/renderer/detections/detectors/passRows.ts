import {
  PASS_BAR_MAX,
  PASS_BAR_MIN,
  detectorThreshold,
  isDetectorDraft,
  passDefaultBars,
  type Detection,
} from '@aio/annotate/detections';
import type { DetectionsFile } from '@aio/schema';

export interface DetectorPassRow {
  pass: string;
  /** The names of the detectors that ran in the pass, joined with ", ". */
  detectorName: string;
  /** When the run was made (ISO), or null when the pass does not say. */
  runAt: string | null;
  /**
   * The slider's value: the pass's own bar, else its default bar (`passDefaultBars`, the value
   * the queue uses), else the lowest bar the header lists.
   */
  threshold: number;
  /** Waiting drafts at or over their bar (unscored drafts always count here). */
  shown: number;
  /** Waiting drafts the bar hides. */
  hidden: number;
}

type Header = Pick<DetectionsFile, 'detectors' | 'run' | 'createdAt'>;

/**
 * One row per local-detector pass (`vlm-*`): the detectors it ran, when, the bar and how many
 * waiting drafts that bar shows and hides. The counts use `detectorThreshold`, as the queue does.
 */
export function detectorPassRows(
  list: readonly Detection[],
  headers: ReadonlyMap<string, Header>,
  passThreshold: Readonly<Record<string, number>>,
): DetectorPassRow[] {
  const passNames = new Set([...headers.keys(), ...list.map((d) => d.pass)]);
  const rows: DetectorPassRow[] = [];
  for (const pass of [...passNames].sort()) {
    if (!pass.startsWith('vlm-')) continue;
    const header = headers.get(pass);
    const mine = list.filter((d) => d.pass === pass);
    const ran = mine.flatMap((d) =>
      d.origin.kind === 'model' && d.origin.detector ? [d.origin.detector] : [],
    );
    const listed = header?.detectors ?? [];
    const names = listed.length > 0 ? listed.map((x) => x.name) : ran.map((x) => x.id);
    // a pass with no detector boxes has nothing to hide: the header's bars only fill the slider
    const fallback =
      passDefaultBars(list).get(pass) ??
      (listed.length > 0 ? Math.min(...listed.map((x) => x.threshold)) : PASS_BAR_MIN);
    let shown = 0;
    let hidden = 0;
    for (const d of mine) {
      if (!isDetectorDraft(d)) continue;
      const bar = detectorThreshold({ passThreshold, detections: list }, d);
      if (d.unscored || d.confidence === undefined || bar === null || d.confidence >= bar) shown++;
      else hidden++;
    }
    rows.push({
      pass,
      detectorName: [...new Set(names)].join(', '),
      runAt: header?.run?.at ?? header?.createdAt ?? null,
      threshold: Math.min(PASS_BAR_MAX, Math.max(PASS_BAR_MIN, passThreshold[pass] ?? fallback)),
      shown,
      hidden,
    });
  }
  return rows;
}
