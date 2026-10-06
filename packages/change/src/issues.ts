import type {
  ChangeItem,
  ChangeThresholds,
  Issue,
  Layer,
  ProjectManifest,
  Vec3,
} from '@aio/schema';
import { cameraSees, dist3, mean3, polygonArea3, polylineLength3 } from './geometry';
import type { DateIndex } from './pairs';

/**
 * Issue change between two dates (FUS-12, ANN-8), in TypeScript so the app runs it anywhere.
 *
 * - Dates: `Issue.capture`, else the dates of the sightings' layers, else `createdAt` against the
 *   capture dates.
 * - Matching: a confirmed `track` first; else the same class within `max(0.5 m, 2% of the site
 *   height)` of the mesh or point cloud sighting, nearest first.
 * - Verdicts: `new`, `resolved` (gone where a posed photo of the later date looked), `not-seen`
 *   (gone, but nothing of the later date looked: never `resolved`), `grown` / `shrunk` (area beyond
 *   the threshold), `worsened` / `improved` (severity), `unchanged`.
 *
 * Every verdict is a proposal; nothing here changes an issue.
 */

type IssueItem = Extract<ChangeItem, { kind: 'issue' }>;

/** How far a camera of the later date may be from a place and still count as having seen it. */
const SEEN_RANGE_M = 300;
const MIN_MATCH_M = 0.5;
const MATCH_SHARE_OF_HEIGHT = 0.02;

/** The capture an issue belongs to. */
export function issueDate(
  issue: Issue,
  index: Pick<DateIndex, 'captures' | 'of'>,
): string | undefined {
  const known = (id: string | undefined) =>
    id !== undefined && index.captures.some((c) => c.id === id);
  if (known(issue.capture)) return issue.capture;
  const votes = new Map<string, number>();
  for (const s of issue.sightings) {
    const c = index.of[s.layer];
    if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
  }
  let best: string | undefined;
  let most = 0;
  for (const [c, n] of votes) {
    if (n > most) {
      best = c;
      most = n;
    }
  }
  if (best) return best;
  const day = issue.createdAt.slice(0, 10);
  const before = index.captures.filter((c) => c.date <= day);
  return (before.at(-1) ?? index.captures[0])?.id;
}

/** Where the issue is in 3D: its mesh or point cloud sighting (project local frame). */
export function issuePosition(
  issue: Pick<Issue, 'sightings'>,
): { p: Vec3; method: 'mesh' | 'pointcloud' } | null {
  for (const s of issue.sightings) {
    if (s.on === 'mesh') {
      const g = s.geom;
      const p =
        g.type === 'spoint'
          ? g.p
          : g.type === 'spatch'
            ? (g.center ?? null)
            : mean3(g.type === 'spolygon' ? g.points : g.points);
      if (p) return { p, method: 'mesh' };
    } else if (s.on === 'pointcloud') {
      const g = s.geom;
      const p =
        g.type === 'point3'
          ? g.p
          : g.type === 'box3'
            ? mean3([g.min, g.max])
            : g.type === 'polygon3'
              ? mean3(g.points)
              : null;
      if (p) return { p, method: 'pointcloud' };
    }
  }
  return null;
}

/** Size of an issue: a measured area, else the area or length of its 3D geometry. */
export function issueSize(
  issue: Pick<Issue, 'sightings' | 'measurements'>,
): { value: number; unit: 'm' | 'm2' } | null {
  const area = issue.measurements?.find((m) => m.kind === 'area' && m.unit === 'm2');
  if (area) return { value: area.value, unit: 'm2' };
  for (const s of issue.sightings) {
    if (s.on === 'mesh' && s.geom.type === 'spolygon')
      return { value: polygonArea3(s.geom.points), unit: 'm2' };
    if (s.on === 'pointcloud' && s.geom.type === 'polygon3')
      return { value: polygonArea3(s.geom.points), unit: 'm2' };
    if (s.on === 'pointcloud' && s.geom.type === 'box3') {
      const [a, b] = [s.geom.min, s.geom.max];
      return { value: Math.abs((b[0] - a[0]) * (b[2] - a[2])), unit: 'm2' };
    }
  }
  const length = issue.measurements?.find((m) => m.kind === 'distance' && m.unit === 'm');
  if (length) return { value: length.value, unit: 'm' };
  for (const s of issue.sightings)
    if (s.on === 'mesh' && s.geom.type === 'spolyline')
      return { value: polylineLength3(s.geom.points), unit: 'm' };
  return null;
}

/**
 * Whether a posed photo of the date looked at `p`. False is "no photo of the date saw it", not
 * "nobody looked": callers use it only to tell `resolved` from `not-seen`.
 */
export function seenOn(p: Vec3, layers: readonly Layer[]): boolean {
  for (const l of layers) {
    if (l.kind !== 'photos') continue;
    for (const ph of l.items) {
      if (!ph.pos || !ph.q || !ph.lens) continue;
      if (cameraSees({ pos: ph.pos, q: ph.q }, ph.lens, p, SEEN_RANGE_M)) return true;
    }
  }
  return false;
}

export interface IssueChangeInput {
  manifest: Pick<ProjectManifest, 'layers'>;
  index: Pick<DateIndex, 'captures' | 'of'>;
  issues: readonly Issue[];
  from: string;
  to: string;
  thresholds: Pick<ChangeThresholds, 'grown'>;
}

interface Placed {
  issue: Issue;
  at: { p: Vec3; method: 'mesh' | 'pointcloud' } | null;
}

/** Issue change items of a date pair, earlier-date issues first, then the new ones. */
export function issueChanges(input: IssueChangeInput): IssueItem[] {
  const { index, from, to, thresholds } = input;
  const place = (i: Issue): Placed => ({ issue: i, at: issuePosition(i) });
  const a = input.issues.filter((i) => issueDate(i, index) === from).map(place);
  const b = input.issues.filter((i) => issueDate(i, index) === to).map(place);
  const ys = [...a, ...b].flatMap((x) => (x.at ? [x.at.p[1]] : []));
  const height = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  const tolerance = Math.max(MIN_MATCH_M, MATCH_SHARE_OF_HEIGHT * height);

  const pairOf = new Map<Placed, { b: Placed; method: string }>();
  const taken = new Set<Placed>();
  // 1. a person's confirmed track
  for (const x of a) {
    if (!x.issue.track) continue;
    const y = b.find((c) => !taken.has(c) && c.issue.track === x.issue.track);
    if (y) {
      pairOf.set(x, { b: y, method: 'track' });
      taken.add(y);
    }
  }
  // 2. same class, nearest within the tolerance
  const candidates: { x: Placed; y: Placed; d: number }[] = [];
  for (const x of a) {
    if (pairOf.has(x) || !x.at) continue;
    for (const y of b) {
      if (taken.has(y) || !y.at || y.issue.classId !== x.issue.classId) continue;
      const d = dist3(x.at.p, y.at.p);
      if (d <= tolerance) candidates.push({ x, y, d });
    }
  }
  candidates.sort((p, q) => p.d - q.d);
  for (const { x, y } of candidates) {
    if (pairOf.has(x) || taken.has(y)) continue;
    pairOf.set(x, { b: y, method: x.at?.method ?? 'mesh' });
    taken.add(y);
  }

  const later = input.manifest.layers.filter((l) => index.of[l.id] === to);
  const items: IssueItem[] = [];
  for (const x of a) {
    const m = pairOf.get(x);
    if (m) {
      items.push(matched(x, m.b, m.method, thresholds));
      continue;
    }
    const seen = x.at ? seenOn(x.at.p, later) : false;
    items.push({
      kind: 'issue',
      id: `issue:${x.issue.code}`,
      verdict: seen ? 'resolved' : 'not-seen',
      label: `${x.issue.code} ${seen ? 'gone' : 'not looked at on the later date'}`,
      from: x.issue.id,
      classId: x.issue.classId,
      ...(x.at ? { at: x.at.p, method: seen ? 'photos' : x.at.method } : {}),
      ...severityOf(x.issue, undefined),
      ...sizeOf(x.issue, undefined),
    });
  }
  for (const y of b) {
    if (taken.has(y)) continue;
    items.push({
      kind: 'issue',
      id: `issue:${y.issue.code}`,
      verdict: 'new',
      label: `${y.issue.code} new`,
      to: y.issue.id,
      classId: y.issue.classId,
      ...(y.at ? { at: y.at.p, method: y.at.method } : {}),
      ...severityOf(undefined, y.issue),
      ...sizeOf(undefined, y.issue),
    });
  }
  return items;
}

function severityOf(
  a: Issue | undefined,
  b: Issue | undefined,
): Pick<IssueItem, 'severity'> | Record<string, never> {
  const v = (i: Issue | undefined) => (typeof i?.severity === 'number' ? i.severity : undefined);
  const s = { from: v(a), to: v(b) };
  if (s.from === undefined && s.to === undefined) return {};
  return {
    severity: {
      ...(s.from !== undefined ? { from: s.from } : {}),
      ...(s.to !== undefined ? { to: s.to } : {}),
    },
  };
}

function sizeOf(
  a: Issue | undefined,
  b: Issue | undefined,
): Pick<IssueItem, 'size'> | Record<string, never> {
  const sa = a ? issueSize(a) : null;
  const sb = b ? issueSize(b) : null;
  const unit = sa?.unit ?? sb?.unit;
  if (!unit || (sa && sb && sa.unit !== sb.unit)) return {};
  return {
    size: {
      ...(sa ? { from: round(sa.value) } : {}),
      ...(sb ? { to: round(sb.value) } : {}),
      unit,
    },
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function matched(
  x: Placed,
  y: Placed,
  method: string,
  thresholds: Pick<ChangeThresholds, 'grown'>,
): IssueItem {
  const sa = issueSize(x.issue);
  const sb = issueSize(y.issue);
  const pct = thresholds.grown.areaPct / 100;
  let verdict: IssueItem['verdict'] = 'unchanged';
  if (sa && sb?.unit === sa.unit && sa.value > 0) {
    const ratio = sb.value / sa.value;
    if (ratio >= 1 + pct) verdict = 'grown';
    else if (ratio <= 1 / (1 + pct)) verdict = 'shrunk';
  }
  if (verdict === 'unchanged') {
    const fa = x.issue.severity;
    const fb = y.issue.severity;
    if (typeof fa === 'number' && typeof fb === 'number') {
      if (fb - fa >= thresholds.grown.severityLevels) verdict = 'worsened';
      else if (fa - fb >= thresholds.grown.severityLevels) verdict = 'improved';
    }
  }
  const words: Record<string, string> = {
    grown: 'grown',
    shrunk: 'smaller',
    worsened: 'worse',
    improved: 'better',
    unchanged: 'unchanged',
  };
  const at = y.at?.p ?? x.at?.p;
  return {
    kind: 'issue',
    id: `issue:${x.issue.code}`,
    verdict,
    label: `${x.issue.code} ${words[verdict] ?? verdict} (${y.issue.code} on the later date)`,
    from: x.issue.id,
    to: y.issue.id,
    classId: y.issue.classId,
    ...(at ? { at } : {}),
    method,
    ...severityOf(x.issue, y.issue),
    ...sizeOf(x.issue, y.issue),
  };
}
