import type { Issue } from '@aio/schema';
import { STATUS_ORDER, type Severity } from './ops';

// Register at scale: zones, grouping, flattened rows, the virtual row window and an indexed
// search. All pure, so 2,000+ issues stay instant.

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Where on the asset an issue is, from what the importers write: the kit location line
 * ("Location: 74.4 m above datum, East elevation side, Roof and crown."), an uncertain photo's
 * "Zone podium.", an HCl "Area: Bottom plate." or a road chainage ("at km 7.452", banded per
 * kilometre). "No zone" otherwise.
 */
export function issueZone(issue: Issue): string {
  const loc = /Location: ([^\n]*?)\.?(?:\n|$)/.exec(issue.note)?.[1];
  if (loc) {
    const parts = loc
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && !p.endsWith('above datum'));
    const zone = parts.find((p) => !p.endsWith(' side')) ?? parts[0];
    if (zone) return cap(zone);
  }
  const zone = /(?:^|\n)Zone ([^.\n]+)\./.exec(issue.note)?.[1];
  if (zone) return cap(zone.trim());
  const area = /Area: ([^.\n]+)\./.exec(issue.note)?.[1];
  if (area) return cap(area.trim());
  const km = /\bat km (\d+)(?:\.\d+)?/.exec(issue.title)?.[1];
  if (km !== undefined) return `km ${Number(km)} to ${Number(km) + 1}`;
  return 'No zone';
}

export type IssueGroupKey = 'none' | 'class' | 'zone' | 'severity' | 'status';

export interface IssueGroup {
  key: string;
  label: string;
  issues: Issue[];
  /** Worst severity in the group (uncertain counts below every level). */
  top: Severity;
}

const rank = (s: Severity) => (s === 'uncertain' ? -1 : s);

/**
 * Split an already sorted and filtered list into groups; the list order is kept inside each
 * group. Severity groups run worst first (uncertain last), status groups in workflow order,
 * class and zone groups alphabetically.
 */
export function groupIssues(
  issues: readonly Issue[],
  by: IssueGroupKey,
  classLabel: (classId: string) => string,
): IssueGroup[] {
  const keyOf = (i: Issue): [string, string] => {
    switch (by) {
      case 'none':
        return ['all', 'All issues'];
      case 'class':
        return [`class:${i.classId}`, classLabel(i.classId)];
      case 'zone': {
        const z = issueZone(i);
        return [`zone:${z}`, z];
      }
      case 'severity':
        return i.severity === 'uncertain'
          ? ['sev:uncertain', 'Uncertain']
          : [`sev:${i.severity}`, `Severity ${i.severity}`];
      case 'status':
        return [`status:${i.status}`, i.status];
    }
  };
  const map = new Map<string, IssueGroup>();
  for (const i of issues) {
    const [key, label] = keyOf(i);
    const g = map.get(key);
    if (g) {
      g.issues.push(i);
      if (rank(i.severity) > rank(g.top)) g.top = i.severity;
    } else map.set(key, { key, label, issues: [i], top: i.severity });
  }
  const groups = [...map.values()];
  const first = (g: IssueGroup) => g.issues[0];
  switch (by) {
    case 'severity':
      return groups.sort((a, b) => rank(first(b)?.severity ?? -1) - rank(first(a)?.severity ?? -1));
    case 'status':
      return groups.sort(
        (a, b) =>
          STATUS_ORDER.indexOf(first(a)?.status ?? 'draft') -
          STATUS_ORDER.indexOf(first(b)?.status ?? 'draft'),
      );
    case 'class':
    case 'zone':
      return groups.sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
      );
    case 'none':
      return groups;
  }
}

export type RegisterRow =
  | { kind: 'group'; key: string; label: string; count: number; top: Severity }
  | { kind: 'issue'; issue: Issue };

/** Header and issue rows for the virtual list; one group means no header. */
export function flattenGroups(
  groups: readonly IssueGroup[],
  collapsed: ReadonlySet<string>,
): RegisterRow[] {
  const only = groups.length === 1 && groups[0]?.key === 'all';
  const rows: RegisterRow[] = [];
  for (const g of groups) {
    if (!only) {
      rows.push({ kind: 'group', key: g.key, label: g.label, count: g.issues.length, top: g.top });
      if (collapsed.has(g.key)) continue;
    }
    for (const issue of g.issues) rows.push({ kind: 'issue', issue });
  }
  return rows;
}

export interface RowMetrics {
  scrollTop: number;
  viewport: number;
  rowH: number;
  headH: number;
}

export interface RowWindow {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  total: number;
  /** Top of row `i` in the list. */
  offsetOf(i: number): number;
  heightOf(i: number): number;
}

/** The slice of rows to render for a scroll position, with spacer heights above and below. */
export function rowWindow(rows: readonly RegisterRow[], m: RowMetrics, overscan = 6): RowWindow {
  const n = rows.length;
  const top = new Float64Array(n + 1);
  for (let i = 0; i < n; i++)
    top[i + 1] = (top[i] ?? 0) + (rows[i]?.kind === 'group' ? m.headH : m.rowH);
  const total = top[n] ?? 0;
  // first row whose bottom is below the scroll top
  const find = (y: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((top[mid + 1] ?? 0) <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const first = find(m.scrollTop);
  const last = find(m.scrollTop + m.viewport - 0.5) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(n, last + overscan);
  return {
    start,
    end,
    padTop: top[start] ?? 0,
    padBottom: total - (top[end] ?? 0),
    total,
    offsetOf: (i) => top[i] ?? 0,
    heightOf: (i) => (top[i + 1] ?? 0) - (top[i] ?? 0),
  };
}

/**
 * Free-text search over code, title, note, author and class label. Haystacks are built once
 * per issue object (issues are immutable, so an edit gets a fresh entry).
 */
export function createSearch(
  classLabel: (classId: string) => string,
): (issues: readonly Issue[], text: string) => Issue[] {
  const hay = new WeakMap<Issue, string>();
  const of = (i: Issue) => {
    let h = hay.get(i);
    if (h === undefined) {
      h = [i.code, i.title, i.note, i.author, classLabel(i.classId)].join('\n').toLowerCase();
      hay.set(i, h);
    }
    return h;
  };
  return (issues, text) => {
    const q = text.trim().toLowerCase();
    if (!q) return issues.slice();
    return issues.filter((i) => of(i).includes(q));
  };
}
