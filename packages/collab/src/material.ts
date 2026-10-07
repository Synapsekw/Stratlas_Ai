import type { CollabTarget, MaterialField } from '@aio/schema';

/**
 * What an approval signs: the material content of its target (decision 6). Main hashes these
 * views (SHA-256 over canonical JSON); this module only picks the fields, so it stays pure and the
 * renderer and tests can reason about it.
 *
 * Status counts by phase, not by value: approving moves `reviewed` to `approved` and closing moves
 * on to `closed`, and neither may void the approval that allowed it. Going back to `draft` does.
 */
export function statusPhase(status: string): 'draft' | 'review' {
  return status === 'draft' ? 'draft' : 'review';
}

/** The fields of an issue that matter here (a plain object from `issues.json`). */
export interface IssueLike {
  id: string;
  code?: string;
  classId?: string;
  severityModelId?: string;
  severity?: unknown;
  status?: string;
  title?: string;
  note?: string;
  author?: string;
  sightings?: unknown[];
  measurements?: unknown[];
}

/** The material view of an issue under the policy's `materialFields`. */
export function issueMaterial(
  issue: IssueLike,
  fields: readonly MaterialField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: issue.id };
  for (const f of [...fields].sort()) {
    switch (f) {
      case 'class':
        out.class = [issue.classId ?? null, issue.severityModelId ?? null];
        break;
      case 'severity':
        out.severity = issue.severity ?? null;
        break;
      case 'sightings':
        out.sightings = issue.sightings ?? [];
        break;
      case 'measurements':
        out.measurements = issue.measurements ?? [];
        break;
      case 'status':
        out.status = statusPhase(issue.status ?? 'draft');
        break;
      case 'title':
        out.title = issue.title ?? '';
        break;
      case 'note':
        out.note = issue.note ?? '';
        break;
    }
  }
  return out;
}

/** A change item's review as it matters for sign-off: the verdict, not who wrote it or the note. */
export function changeItemMaterial(item: {
  id: string;
  review?: { status?: string; issueId?: string } | null;
}): Record<string, unknown> {
  return {
    id: item.id,
    review: item.review
      ? { status: item.review.status ?? 'open', issueId: item.review.issueId ?? null }
      : null,
  };
}

/** A change set: every item's review, in id order. */
export function changeSetMaterial(set: {
  id?: string;
  items?: { id: string; review?: { status?: string; issueId?: string } | null }[];
}): Record<string, unknown> {
  const items = [...(set.items ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { id: set.id ?? null, items: items.map(changeItemMaterial) };
}

/** Fields of a detection a review decides (data-conventions section 16); the note is not. */
const DETECTION_FIELDS = ['id', 'status', 'class', 'severity', 'geom', 'issueId', 'uncertain'];

export function detectionPassMaterial(file: { detections?: unknown[] }): Record<string, unknown> {
  return {
    detections: (file.detections ?? []).map((d) =>
      d && typeof d === 'object'
        ? Object.fromEntries(
            DETECTION_FIELDS.filter((k) => k in d).map((k) => [
              k,
              (d as Record<string, unknown>)[k],
            ]),
          )
        : d,
    ),
  };
}

/** A procedural model part, without its free-text note. */
export function partMaterial(part: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(part).filter(([k]) => k !== 'note'));
}

export function modelMaterial(model: { id?: string; parts?: unknown[] }): Record<string, unknown> {
  return {
    id: model.id ?? null,
    parts: (model.parts ?? []).map((p) =>
      p && typeof p === 'object' ? partMaterial(p as Record<string, unknown>) : p,
    ),
  };
}

/**
 * The report's inputs: every issue's material view, in id order, under the project id. A report
 * sign-off goes out of date when any finding changes materially.
 */
export function reportMaterial(
  projectId: string,
  issues: readonly IssueLike[],
  fields: readonly MaterialField[],
): Record<string, unknown> {
  const sorted = [...issues].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { project: projectId, issues: sorted.map((i) => issueMaterial(i, fields)) };
}

/** Targets an approval can sign. `project` has no content of its own. */
export function signable(target: CollabTarget): boolean {
  return target.kind !== 'project';
}
