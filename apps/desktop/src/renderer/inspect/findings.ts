/**
 * The findings model of Inspect: what one photo lists (the issues a person confirmed and the
 * drafts the AI is waiting on), the counts behind the filter chips, which photo to review next,
 * and which photo follows a selection. Pure functions; the screen holds the state.
 */
import { inQueue, type Detection, type ReviewState } from '@aio/annotate/detections';
import type { Issue } from '@aio/schema';
import type { PhotoPick } from '@aio/ui';
import type { Selection } from '@aio/workspace';
import { photoKey, rankOfSeverity, type PhotoFindings } from '../screens/mediaFindings';

/** Drafts at or above the bars (`inQueue(d, 'draft', minConfidence, passThreshold, all)`), plus every accepted and rejected one. */
export function visibleDetections(
  review: Pick<ReviewState, 'detections' | 'minConfidence' | 'passThreshold'>,
): Detection[] {
  const all = review.detections;
  return all.filter(
    (d) =>
      d.status !== 'draft' || inQueue(d, 'draft', review.minConfidence, review.passThreshold, all),
  );
}

export type FindingRow =
  | {
      kind: 'you';
      key: string;
      issueId: string;
      code: string;
      title: string;
      classId: string;
      severityModelId: string;
      severity: Issue['severity'];
      selected: boolean;
    }
  | {
      kind: 'ai';
      key: string;
      detectionId: string;
      classId: string;
      label: string | undefined;
      severity: Detection['severity'];
      uncertain: boolean;
      confidence: number | undefined;
      unscored: boolean;
      selected: boolean;
    };

const onPhoto = (s: Issue['sightings'][number], pick: PhotoPick) =>
  s.on === 'image' && s.layer === pick.layerId && s.photo === pick.photoId;

/** Issues with an image sighting on the photo (worst severity first), then its waiting drafts (most confident first). Accepted and rejected detections are left out: an accepted one is its issue. */
export function findingsOnPhoto(i: {
  pick: PhotoPick;
  issues: readonly Issue[];
  detections: readonly Detection[];
  selectedIssueId: string | null;
  currentDetectionId: string | null;
}): FindingRow[] {
  const you: FindingRow[] = i.issues
    .filter((issue) => issue.sightings.some((s) => onPhoto(s, i.pick)))
    .map((issue, n) => ({ issue, n }))
    .sort(
      (a, b) => rankOfSeverity(b.issue.severity) - rankOfSeverity(a.issue.severity) || a.n - b.n,
    )
    .map(({ issue }) => ({
      kind: 'you' as const,
      key: `issue:${issue.id}`,
      issueId: issue.id,
      code: issue.code,
      title: issue.title,
      classId: issue.classId,
      severityModelId: issue.severityModelId,
      severity: issue.severity,
      selected: issue.id === i.selectedIssueId,
    }));
  const ai: FindingRow[] = i.detections
    .filter(
      (d) =>
        d.status === 'draft' &&
        d.source.kind === 'photo' &&
        d.source.layer === i.pick.layerId &&
        d.source.photo === i.pick.photoId,
    )
    .map((d, n) => ({ d, n }))
    .sort((a, b) => (b.d.confidence ?? -1) - (a.d.confidence ?? -1) || a.n - b.n)
    .map(({ d }) => ({
      kind: 'ai' as const,
      key: `det:${d.id}`,
      detectionId: d.id,
      classId: d.classId,
      label: d.label,
      severity: d.severity,
      uncertain: d.uncertain,
      confidence: d.confidence,
      unscored: d.unscored === true,
      selected: d.id === i.currentDetectionId,
    }));
  return [...you, ...ai];
}

export type PhotoChip = 'review' | 'findings' | 'all';

export function chipCounts(
  sets: readonly { id: string; items: readonly { id: string }[] }[],
  index: ReadonlyMap<string, PhotoFindings>,
): Record<PhotoChip, number> {
  const out: Record<PhotoChip, number> = { review: 0, findings: 0, all: 0 };
  for (const set of sets) {
    for (const p of set.items) {
      const f = index.get(photoKey(set.id, p.id));
      out.all += 1;
      if (f) out.findings += 1;
      if (f && f.drafts > 0) out.review += 1;
    }
  }
  return out;
}

const samePick = (a: PhotoPick, b: PhotoPick) => a.layerId === b.layerId && a.photoId === b.photoId;

/** The next photo after `from` in `order` with waiting drafts, wrapping round; null when none. */
export function nextPhotoToReview(
  order: readonly PhotoPick[],
  index: ReadonlyMap<string, PhotoFindings>,
  from: PhotoPick | null,
): PhotoPick | null {
  const at = from ? order.findIndex((p) => samePick(p, from)) : -1;
  for (let step = 1; step <= order.length; step++) {
    const p = order[(at + step) % order.length];
    if (!p || (from && samePick(p, from))) continue;
    if ((index.get(photoKey(p.layerId, p.photoId))?.drafts ?? 0) > 0) return p;
  }
  return null;
}

export function photoPosition(
  order: readonly PhotoPick[],
  pick: PhotoPick | null,
): { index: number; total: number } | null {
  if (!pick) return null;
  const index = order.findIndex((p) => samePick(p, pick));
  return index < 0 ? null : { index, total: order.length };
}

/**
 * Which photo Inspect shows after a selection change: a picked photo; an issue on the open photo
 * keeps it; else the issue's first image sighting; else the current one. A photo selection without
 * a layer takes the first photo set that holds the id, when `photoSets` is given.
 */
export function followSelection(
  current: PhotoPick | null,
  selection: Selection | null,
  issues: readonly Issue[],
  photoSets: readonly { id: string; items: readonly { id: string }[] }[] = [],
): PhotoPick | null {
  if (!selection) return current;
  if (selection.kind === 'photo') {
    const layerId =
      selection.layer ?? photoSets.find((s) => s.items.some((p) => p.id === selection.id))?.id;
    return layerId ? { layerId, photoId: selection.id } : current;
  }
  if (selection.kind !== 'issue') return current;
  const issue = issues.find((x) => x.id === selection.id);
  if (!issue) return current;
  if (current && issue.sightings.some((s) => onPhoto(s, current))) return current;
  for (const s of issue.sightings) {
    if (s.on === 'image') return { layerId: s.layer, photoId: s.photo };
  }
  return current;
}

/** Three columns, or the findings panel as a drawer over the viewer when the screen is narrower than 1000 px. */
export const DRAWER_BELOW = 1000;

export function panelLayout(widthPx: number): 'columns' | 'drawer' {
  return widthPx < DRAWER_BELOW ? 'drawer' : 'columns';
}
