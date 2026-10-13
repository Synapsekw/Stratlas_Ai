import type { RemovalPlan, RemoveTarget, RemoveWhy } from '@aio/schema';
import { formatBytes } from '../format';
import type { MessageKey, Vars } from '../i18n';

/*
 * The words of the delete confirm (delete and start over, spec "The confirm dialog"): what was
 * asked for, what goes with it, what is kept, the space and the trash note. Pure, so the dialog
 * and its tests read the same lines.
 */

export interface RemoveTextOptions {
  /** A survey date in words ("12 Oct 2026"). */
  dateLabel: (captureId: string) => string;
  /** "2.3 GB". Default `formatBytes`. */
  size?: (bytes: number) => string;
}
export interface RemoveText {
  title: string;
  asked: string[];
  also: string[];
  keeps: string[];
  space: string | null;
  note: string;
  refused: string | null;
}

type T = (key: MessageKey, vars?: Vars) => string;
const SHOWN = 8;
const madeBy = (why: RemoveWhy, id: string) =>
  typeof why === 'object' && 'madeBy' in why && why.madeBy === id;
const KEPT_DATE = {
  volume: 'remove.keep.date.volume',
  qa: 'remove.keep.date.qa',
  measurement: 'remove.keep.date.measurement',
} as const;

export function removeText(
  targets: readonly RemoveTarget[],
  plan: RemovalPlan,
  t: T,
  o: RemoveTextOptions,
): RemoveText {
  const size = o.size ?? formatBytes;
  const first = targets[0];
  const asked = (why: RemoveWhy) => why === 'asked';
  const title =
    targets.length === 1 && first !== undefined && 'capture' in first
      ? t('remove.title.date', { date: o.dateLabel(first.capture) })
      : targets.length === 1 && first !== undefined && 'run' in first
        ? t('remove.title.run', { run: first.run })
        : targets.length === 1 && first !== undefined && 'layer' in first
          ? t('remove.title.one', {
              name: plan.layers.find((l) => l.id === first.layer)?.name ?? first.layer,
            })
          : t('remove.title.many', { count: targets.length });

  const askedLines: string[] = [];
  const filed = plan.layers.filter(
    (l) => typeof l.why === 'object' && 'filedUnder' in l.why,
  ).length;
  if (filed > 0) askedLines.push(t('remove.line.filed', { count: filed }));
  const names = [
    ...plan.layers.filter((l) => asked(l.why)).map((l) => l.name),
    ...plan.runs.filter((r) => asked(r.why)).map((r) => t('remove.line.run', { run: r.id })),
  ];
  askedLines.push(...names.slice(0, SHOWN));
  if (names.length > SHOWN) askedLines.push(t('remove.line.more', { count: names.length - SHOWN }));

  const also: string[] = [];
  const runIds = new Set(plan.runs.map((r) => r.id));
  for (const r of plan.runs) {
    const count = plan.layers.filter((l) => madeBy(l.why, r.id)).length;
    if (!asked(r.why))
      also.push(
        count > 0
          ? t('remove.line.runWith', { run: r.id, count })
          : t('remove.line.run', { run: r.id }),
      );
    else if (count > 0) also.push(t('remove.line.runLayers', { run: r.id, count }));
  }
  const others = plan.layers.filter(
    (l) =>
      !asked(l.why) &&
      !(typeof l.why === 'object' && 'filedUnder' in l.why) &&
      ![...runIds].some((id) => madeBy(l.why, id)),
  ).length;
  if (others > 0) also.push(t('remove.line.layers', { count: others }));
  if (plan.changes.length > 0)
    also.push(
      t('remove.line.changes', {
        count: plan.changes.length,
        names: plan.changes.map((c) => c.name).join(', '),
      }),
    );
  if (plan.surfaces.length > 0)
    also.push(t('remove.line.surfaces', { count: plan.surfaces.length }));
  if (plan.tilesets.length > 0)
    also.push(t('remove.line.tilesets', { count: plan.tilesets.length }));
  if (plan.detections.length > 0)
    also.push(t('remove.line.detections', { count: plan.detections.length }));
  if (plan.jobs.length > 0) also.push(t('remove.line.jobs', { count: plan.jobs.length }));

  const keeps: string[] = [];
  if (plan.touches.issues > 0) keeps.push(t('remove.keep.issues', { count: plan.touches.issues }));
  if (plan.touches.walkPins > 0)
    keeps.push(t('remove.keep.pins', { count: plan.touches.walkPins }));
  for (const k of plan.keptCaptures) keeps.push(t(KEPT_DATE[k.by], { date: o.dateLabel(k.id) }));
  if (plan.keptOutside.length > 0) keeps.push(t('remove.keep.originals'));

  return {
    title,
    asked: askedLines,
    also,
    keeps,
    space: plan.bytes > 0 ? t('remove.space', { size: size(plan.bytes) }) : null,
    note: t('remove.note'),
    refused: plan.refused ?? null,
  };
}
