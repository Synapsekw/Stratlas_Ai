import type { Issue, IssueStatus, Sighting } from '@aio/schema';
import { STATUS_ORDER, type Severity } from './ops';

export type DatasetKind = Sighting['on'];

export interface IssueFilter {
  severities?: readonly Severity[];
  classIds?: readonly string[];
  statuses?: readonly IssueStatus[];
  /** Sighting kinds: mesh, image, video, pointcloud, map, pano. */
  datasets?: readonly DatasetKind[];
  /** Layer ids a sighting must be on. */
  layers?: readonly string[];
  /** Free text over code, title, note, author and class label. */
  text?: string;
}

const some = <T>(list: readonly T[] | undefined): list is readonly T[] =>
  list !== undefined && list.length > 0;

export function filterIssues(
  issues: readonly Issue[],
  f: IssueFilter,
  classLabel: (classId: string) => string = (id) => id,
): Issue[] {
  const text = f.text?.trim().toLowerCase() ?? '';
  return issues.filter((i) => {
    if (some(f.severities) && !f.severities.includes(i.severity)) return false;
    if (some(f.classIds) && !f.classIds.includes(i.classId)) return false;
    if (some(f.statuses) && !f.statuses.includes(i.status)) return false;
    if (some(f.datasets) && !i.sightings.some((s) => f.datasets?.includes(s.on))) return false;
    if (some(f.layers) && !i.sightings.some((s) => f.layers?.includes(s.layer))) return false;
    if (text) {
      const hay = [i.code, i.title, i.note, i.author, classLabel(i.classId)]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}

/** Natural order for codes: prefix, then number (F2 before F10). */
export function compareCodes(a: string, b: string): number {
  const pa = /^([A-Z]*)(\d*)$/.exec(a);
  const pb = /^([A-Z]*)(\d*)$/.exec(b);
  const prefixA = pa?.[1] ?? a;
  const prefixB = pb?.[1] ?? b;
  if (prefixA !== prefixB) return prefixA < prefixB ? -1 : 1;
  return Number(pa?.[2] ?? 0) - Number(pb?.[2] ?? 0);
}

export type IssueSortKey = 'code' | 'severity' | 'status' | 'updated' | 'class';

const sevRank = (s: Severity) => (s === 'uncertain' ? -1 : s);

/**
 * Sort a copy. Ascending (`asc`) means the natural reading order of each key: codes up,
 * severity highest first, status draft first, last change newest first.
 */
export function sortIssues(
  issues: readonly Issue[],
  key: IssueSortKey,
  dir: 'asc' | 'desc' = 'asc',
): Issue[] {
  const cmp = (a: Issue, b: Issue): number => {
    switch (key) {
      case 'code':
        return compareCodes(a.code, b.code);
      case 'severity':
        return sevRank(b.severity) - sevRank(a.severity) || compareCodes(a.code, b.code);
      case 'status':
        return (
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          compareCodes(a.code, b.code)
        );
      case 'updated':
        return b.updatedAt.localeCompare(a.updatedAt) || compareCodes(a.code, b.code);
      case 'class':
        return a.classId.localeCompare(b.classId) || compareCodes(a.code, b.code);
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return issues.slice().sort((a, b) => sign * cmp(a, b));
}

export function severityCounts(issues: readonly Issue[]): Map<Severity, number> {
  const m = new Map<Severity, number>();
  for (const i of issues) m.set(i.severity, (m.get(i.severity) ?? 0) + 1);
  return m;
}

/** Distinct dataset kinds an issue is seen in, in first-seen order. */
export function issueDatasets(issue: Issue): DatasetKind[] {
  return [...new Set(issue.sightings.map((s) => s.on))];
}
