import {
  CHANGE_SCHEMA,
  ChangeVerdict,
  type ChangeItem,
  type ChangeKind,
  type ChangeReview,
  type ChangeSet,
  type ChangeSetSummary,
} from '@aio/schema';

/**
 * The change register: change sets merged across recomputes (reviews carried over by item id),
 * their totals, and the rows the Changes panel lists with filters and sort.
 */

export type ReviewStatus = ChangeReview['status'];

/** Totals of a set: every item, the open ones, and one count per verdict. */
export function changeStats(items: readonly ChangeItem[]): Record<string, number> {
  const out: Record<string, number> = { items: items.length, open: 0 };
  for (const i of items) {
    out[i.verdict] = (out[i.verdict] ?? 0) + 1;
    if ((i.review?.status ?? 'open') === 'open') out.open = (out.open ?? 0) + 1;
  }
  return out;
}

/** A fresh change set of computed items (no reviews yet). */
export function buildChangeSet(o: {
  id: string;
  from: string;
  to: string;
  producer: string;
  items: ChangeItem[];
  createdAt: string;
  run?: ChangeSet['run'];
  layers?: string[];
  stats?: Record<string, number>;
}): ChangeSet {
  return {
    schema: CHANGE_SCHEMA,
    id: o.id,
    from: o.from,
    to: o.to,
    producer: o.producer,
    ...(o.run ? { run: o.run } : {}),
    createdAt: o.createdAt,
    items: o.items,
    layers: o.layers ?? [],
    stats: { ...o.stats, ...changeStats(o.items) },
  };
}

/**
 * A recomputed set with the person's reviews of the previous one: each `review` is copied as it
 * was onto the item with the same id. Items that are gone take their reviews with them.
 */
export function mergeReviews(previous: ChangeSet | null | undefined, next: ChangeSet): ChangeSet {
  if (!previous) return next;
  const reviews = new Map<string, ChangeReview>();
  for (const i of previous.items) if (i.review) reviews.set(i.id, i.review);
  const items = next.items.map((i) => {
    const r = reviews.get(i.id);
    return r ? { ...i, review: r } : i;
  });
  return { ...next, items, stats: { ...next.stats, ...changeStats(items) } };
}

/** Set (or clear, with null) the review of one item. */
export function reviewItem(set: ChangeSet, itemId: string, review: ChangeReview | null): ChangeSet {
  if (!set.items.some((i) => i.id === itemId))
    throw new Error(`The change set ${set.id} has no item "${itemId}".`);
  const items = set.items.map((i) => {
    if (i.id !== itemId) return i;
    if (review) return { ...i, review };
    const rest: ChangeItem = { ...i };
    delete rest.review;
    return rest;
  });
  return { ...set, items, stats: { ...set.stats, ...changeStats(items) } };
}

/** One line of `change:list` for a set. */
export function summarize(set: ChangeSet): ChangeSetSummary {
  const stats = changeStats(set.items);
  return {
    id: set.id,
    from: set.from,
    to: set.to,
    producer: set.producer,
    createdAt: set.createdAt,
    items: set.items.length,
    open: stats.open ?? 0,
  };
}

/* ----------------------------------------------------------------------- register rows */

export interface RegisterRow {
  setId: string;
  producer: string;
  item: ChangeItem;
  status: ReviewStatus;
}

export interface RegisterFilter {
  kinds?: readonly ChangeKind[];
  verdicts?: readonly ChangeVerdict[];
  status?: readonly ReviewStatus[];
  /** Hide `unchanged` items (default false). */
  hideUnchanged?: boolean;
  /** Words in the label, id or class. */
  text?: string;
}

export type RegisterSort = 'verdict' | 'kind' | 'score' | 'label';

/** Verdicts in the order a person reads them: what appeared or got worse first. */
const VERDICT_ORDER: readonly ChangeVerdict[] = [
  'new',
  'added',
  'grown',
  'worsened',
  'fill',
  'cut',
  'changed',
  'moved',
  'reshaped',
  'attributes',
  'resolved',
  'removed',
  'shrunk',
  'improved',
  'not-seen',
  'unchanged',
];
const KIND_ORDER: readonly ChangeKind[] = [
  'issue',
  'detection',
  'vector',
  'region',
  'component',
  'frame',
];
const rank = <T>(list: readonly T[], v: T) => {
  const i = list.indexOf(v);
  return i < 0 ? list.length : i;
};

/** Every item of the pair's sets that passes the filter, sorted. */
export function registerRows(
  sets: readonly ChangeSet[],
  filter: RegisterFilter = {},
  sort: RegisterSort = 'verdict',
): RegisterRow[] {
  const words = (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows: RegisterRow[] = [];
  for (const s of sets) {
    for (const item of s.items) {
      const status = item.review?.status ?? 'open';
      if (filter.kinds?.length && !filter.kinds.includes(item.kind)) continue;
      if (filter.verdicts?.length && !filter.verdicts.includes(item.verdict)) continue;
      if (filter.status?.length && !filter.status.includes(status)) continue;
      if (filter.hideUnchanged && item.verdict === 'unchanged') continue;
      if (words.length) {
        const hay = [item.label, item.id, 'classId' in item ? item.classId : undefined]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      rows.push({ setId: s.id, producer: s.producer, item, status });
    }
  }
  const byLabel = (a: RegisterRow, b: RegisterRow) =>
    (a.item.label ?? a.item.id).localeCompare(b.item.label ?? b.item.id, undefined, {
      numeric: true,
    });
  const cmp: Record<RegisterSort, (a: RegisterRow, b: RegisterRow) => number> = {
    verdict: (a, b) =>
      rank(VERDICT_ORDER, a.item.verdict) - rank(VERDICT_ORDER, b.item.verdict) ||
      rank(KIND_ORDER, a.item.kind) - rank(KIND_ORDER, b.item.kind) ||
      byLabel(a, b),
    kind: (a, b) =>
      rank(KIND_ORDER, a.item.kind) - rank(KIND_ORDER, b.item.kind) ||
      rank(VERDICT_ORDER, a.item.verdict) - rank(VERDICT_ORDER, b.item.verdict) ||
      byLabel(a, b),
    score: (a, b) => (b.item.score ?? -1) - (a.item.score ?? -1) || byLabel(a, b),
    label: byLabel,
  };
  return rows.sort(cmp[sort]);
}

/** Counts per verdict of rows (the panel's summary line). */
export function verdictCounts(
  rows: readonly RegisterRow[],
): Partial<Record<ChangeVerdict, number>> {
  const out: Partial<Record<ChangeVerdict, number>> = {};
  for (const r of rows) out[r.item.verdict] = (out[r.item.verdict] ?? 0) + 1;
  return out;
}

export const VERDICTS: readonly ChangeVerdict[] = ChangeVerdict.options;
