/**
 * The site digest's rules (study items 5.2 and 5.8), pure: `siteInsights` reads a snapshot of the
 * project (survey dates, QA files, the volume figures per date, change sets, today) and returns
 * what is worth a look, each insight with its evidence and the actions that answer it. Rules,
 * never AI; insights propose and never change data (the change verdicts stay proposals too).
 *
 * The rules, one fixture test each (`rules.test.ts`):
 *
 * | rule                | severity        | when                                                       |
 * | ------------------- | --------------- | ---------------------------------------------------------- |
 * | `survey-held`       | critical        | the latest held date (a failed QA check nobody released)    |
 * | `survey-held-older` | info            | earlier dates still on hold, in one line                    |
 * | `rmse-over`         | warning         | a date's checkpoint RMSE is over the site limit (not held)  |
 * | `survey-unchecked`  | info            | the latest date has no QA file, or no verdict (level Off)   |
 * | `no-checkpoints`    | info            | the latest date passed QA without checkpoints              |
 * | `change-stale`      | warning         | a change set is out of date after a line-up                 |
 * | `change-review`     | info            | the latest pair has change items nobody reviewed           |
 * | `pile-departs`      | warning         | a figure's last rate departs from its trend (robust z)      |
 * | `pile-moved`        | info            | a figure moved over 20 % and 5 m³ since the date before     |
 * | `pile-empties`      | warning or info | at its rate a falling figure is empty within 60 days of     |
 * |                     |                 | today (14: warning), or would already be empty (warning)    |
 *
 * The figures are the app's counted figures per date (`figuresFromRows` over the inventory rows,
 * the volume card's own rule), so the digest's numbers are the card's. Figure rules look only at
 * figures whose last date is the latest survey date, so the digest speaks about now. Sorted by
 * severity, then rule order, then subject.
 */
import type { ChangeSetSummary, QaLevel, SurveyQa } from '@aio/schema';
import { qaFlagsFor, type QaFlagContext } from './qaFlags';
import { dayOf, volumeTrend, type TrendPoint } from './trend';

export type Severity = 'critical' | 'warning' | 'info';

/** What an insight rests on, so a click can show it. */
export type EvidenceRef =
  | { kind: 'measurement'; id: string }
  | { kind: 'capture'; id: string }
  | { kind: 'qa'; capture: string }
  | { kind: 'changeSet'; id: string };

/**
 * A suggested action: a right-click registry id (`measure.flyTo` on `measurement`,
 * `date.compare` from `pair.from` to `pair.to`), or the digest's own `insights.openQa` (the
 * Survey QA tab on `capture`) and `insights.openChanges` (the Changes tab on `pair`).
 */
export interface InsightAction {
  id: InsightActionId;
  measurement?: string;
  capture?: string;
  pair?: { from: string; to: string };
}

export type InsightActionId =
  'measure.flyTo' | 'date.compare' | 'insights.openQa' | 'insights.openChanges';

export type InsightRule =
  | 'survey-held'
  | 'survey-held-older'
  | 'rmse-over'
  | 'survey-unchecked'
  | 'no-checkpoints'
  | 'change-stale'
  | 'change-review'
  | 'pile-departs'
  | 'pile-moved'
  | 'pile-empties';

/**
 * A value in an insight's words: text, a plain number (a count, a whole percent), or a quantity
 * in SI units that the reader formats in the site's units (`volume` m³, `distance` m). Dates are
 * ISO dates in the `date`, `from` and `to` values.
 */
export type InsightParam = string | number | { volume: number } | { distance: number };

/** The insight's words: an `insights.*` key and its values. */
export interface InsightText {
  key: InsightTextKey;
  params: Record<string, InsightParam>;
}

export type InsightTextKey =
  | 'insights.held'
  | 'insights.heldEarlier'
  | 'insights.rmseOver'
  | 'insights.unchecked'
  | 'insights.noVerdict'
  | 'insights.noCheckpoints'
  | 'insights.changeStale'
  | 'insights.changeReview'
  | 'insights.pileDeparts'
  | 'insights.pileGrew'
  | 'insights.pileShrank'
  | 'insights.pileEmpties'
  | 'insights.pileEmptyPast';

export interface Insight {
  /** Stable for the same rule and subject: `<rule>:<subject>`. */
  id: string;
  rule: InsightRule;
  severity: Severity;
  text: InsightText;
  evidence: EvidenceRef[];
  /** The first is the main one. */
  actions: InsightAction[];
}

/** One volume measurement's counted figure per survey date (m³). */
export interface SiteFigure {
  id: string;
  label: string;
  points: TrendPoint[];
}

export interface SiteSnapshot {
  captures: readonly { id: string; date: string; label: string }[];
  /** QA files by capture id. */
  qa: Readonly<Record<string, SurveyQa>>;
  qaLevel: QaLevel;
  /** The site's checkpoint RMSE limit (`rmseLimit`), null at level Off. */
  rmseLimitM: number | null;
  /** The volume measurements' counted figures (`figuresFromRows`). */
  figures: readonly SiteFigure[];
  /** Change set summaries of the project. */
  changes: readonly ChangeSetSummary[];
  /** Ids of change sets out of date after a line-up (`changeSetStale`, of the loaded sets). */
  staleChangeSets: readonly string[];
  /** Today, an ISO date: forecasts are read against it. */
  today: string;
}

/** A figure moved this share or more since the date before... */
export const MOVED_SHARE = 0.2;
/** ...and at least this many m³. */
export const MOVED_MIN_M3 = 5;
/** A last rate this many robust standard deviations off the earlier ones. */
export const DEPARTS_Z = 3.5;
/** A falling figure empty within this many days of today... */
export const EMPTIES_DAYS = 60;
/** ...and a warning within this many. */
export const EMPTIES_SOON_DAYS = 14;

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'warning', 'info'];
const RULE_ORDER: readonly InsightRule[] = [
  'survey-held',
  'survey-held-older',
  'rmse-over',
  'survey-unchecked',
  'no-checkpoints',
  'change-stale',
  'change-review',
  'pile-departs',
  'pile-moved',
  'pile-empties',
];

const byDate = <T extends { id: string; date: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

/**
 * Each pile's counted figure per date from the inventory rows (`inventorySeries` in
 * `@aio/survey`, run with the app's own staleness checks): the figures the volume card and the
 * totals show, never a stale, refused or missing one.
 */
export function figuresFromRows(
  rows: readonly {
    capture: string;
    date: string;
    parts: readonly { id: string; valueM3: number }[];
  }[],
  piles: readonly { id: string; label: string }[],
): SiteFigure[] {
  return piles.map((m) => ({
    id: m.id,
    label: m.label,
    points: rows.flatMap((r) => {
      const part = r.parts.find((p) => p.id === m.id);
      return part ? [{ capture: r.capture, date: r.date, valueM3: part.valueM3 }] : [];
    }),
  }));
}

const qaAction = (capture: string): InsightAction => ({ id: 'insights.openQa', capture });

function qaRules(s: SiteSnapshot, ctx: QaFlagContext, latest: string | null): Insight[] {
  const out: Insight[] = [];
  const dated = byDate(s.captures);
  const held = dated.filter((c) => qaFlagsFor(c.id, ctx).includes('qa-hold'));
  const newest = held[held.length - 1];
  if (newest) {
    const figures = s.figures.filter((f) => f.points.some((p) => p.capture === newest.id));
    out.push({
      id: `survey-held:${newest.id}`,
      rule: 'survey-held',
      severity: 'critical',
      text: { key: 'insights.held', params: { date: newest.date, count: figures.length } },
      evidence: [
        { kind: 'qa', capture: newest.id },
        ...figures.map((f): EvidenceRef => ({ kind: 'measurement', id: f.id })),
      ],
      actions: [qaAction(newest.id)],
    });
    const older = held.slice(0, -1);
    const last = older[older.length - 1];
    if (last)
      out.push({
        id: `survey-held-older:${last.id}`,
        rule: 'survey-held-older',
        severity: 'info',
        text: { key: 'insights.heldEarlier', params: { count: older.length } },
        evidence: older.map((c): EvidenceRef => ({ kind: 'qa', capture: c.id })),
        actions: [qaAction(last.id)],
      });
  }
  for (const c of dated) {
    const flags = qaFlagsFor(c.id, ctx);
    const qa = s.qa[c.id];
    if (
      !flags.includes('qa-hold') &&
      flags.includes('rmse-over-limit') &&
      qa?.checkpoints &&
      ctx.rmseLimitM !== null
    )
      out.push({
        id: `rmse-over:${c.id}`,
        rule: 'rmse-over',
        severity: 'warning',
        text: {
          key: 'insights.rmseOver',
          params: {
            date: c.date,
            rmse: { distance: qa.checkpoints.rmseM },
            limit: { distance: ctx.rmseLimitM },
          },
        },
        evidence: [{ kind: 'qa', capture: c.id }],
        actions: [qaAction(c.id)],
      });
  }
  if (latest !== null) {
    const date = s.captures.find((c) => c.id === latest)?.date ?? '';
    const qa = s.qa[latest];
    const flags = qaFlagsFor(latest, ctx);
    if (flags.includes('qa-unchecked'))
      out.push({
        id: `survey-unchecked:${latest}`,
        rule: 'survey-unchecked',
        severity: 'info',
        text: { key: qa ? 'insights.noVerdict' : 'insights.unchecked', params: { date } },
        evidence: [qa ? { kind: 'qa', capture: latest } : { kind: 'capture', id: latest }],
        actions: [qaAction(latest)],
      });
    else if (
      qa &&
      (qa.status === 'pass' || qa.status === 'released') &&
      flags.includes('no-checkpoints')
    )
      out.push({
        id: `no-checkpoints:${latest}`,
        rule: 'no-checkpoints',
        severity: 'info',
        text: { key: 'insights.noCheckpoints', params: { date } },
        evidence: [{ kind: 'qa', capture: latest }],
        actions: [qaAction(latest)],
      });
  }
  return out;
}

function changeRules(s: SiteSnapshot, latestPair: { from: string; to: string } | null): Insight[] {
  const out: Insight[] = [];
  const dateOf = new Map(s.captures.map((c) => [c.id, c.date]));
  const stale = new Set(s.staleChangeSets);
  const stalePairs = new Map<string, ChangeSetSummary[]>();
  for (const sum of s.changes) {
    if (!stale.has(sum.id)) continue;
    const key = `${sum.from}>${sum.to}`;
    stalePairs.set(key, [...(stalePairs.get(key) ?? []), sum]);
  }
  for (const [key, sets] of [...stalePairs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = sets[0];
    if (!first) continue;
    const pair = { from: first.from, to: first.to };
    out.push({
      id: `change-stale:${key}`,
      rule: 'change-stale',
      severity: 'warning',
      text: {
        key: 'insights.changeStale',
        params: { from: dateOf.get(pair.from) ?? '', to: dateOf.get(pair.to) ?? '' },
      },
      evidence: sets.map((x): EvidenceRef => ({ kind: 'changeSet', id: x.id })),
      actions: [{ id: 'insights.openChanges', pair }],
    });
  }
  if (latestPair) {
    const sets = s.changes.filter(
      (x) => x.from === latestPair.from && x.to === latestPair.to && x.open > 0 && !stale.has(x.id),
    );
    const open = sets.reduce((n, x) => n + x.open, 0);
    if (open > 0)
      out.push({
        id: `change-review:${latestPair.from}>${latestPair.to}`,
        rule: 'change-review',
        severity: 'info',
        text: {
          key: 'insights.changeReview',
          params: {
            count: open,
            from: dateOf.get(latestPair.from) ?? '',
            to: dateOf.get(latestPair.to) ?? '',
          },
        },
        evidence: sets.map((x): EvidenceRef => ({ kind: 'changeSet', id: x.id })),
        actions: [
          { id: 'insights.openChanges', pair: latestPair },
          { id: 'date.compare', pair: latestPair },
        ],
      });
  }
  return out;
}

function figureRules(s: SiteSnapshot, latest: string | null): Insight[] {
  if (latest === null) return [];
  const out: Insight[] = [];
  const today = dayOf(s.today);
  for (const f of s.figures) {
    const tr = volumeTrend(f.points);
    if (tr.lastCapture !== latest || tr.lastM3 === null || tr.lastDate === null) continue;
    const before = byDate(f.points.map((p) => ({ ...p, id: p.capture }))).at(-2);
    const evidence: EvidenceRef[] = [
      { kind: 'measurement', id: f.id },
      { kind: 'capture', id: latest },
      ...(before ? [{ kind: 'capture', id: before.capture } as EvidenceRef] : []),
    ];
    const fly: InsightAction = { id: 'measure.flyTo', measurement: f.id };
    const compare: InsightAction[] = before
      ? [{ id: 'date.compare', pair: { from: before.capture, to: latest } }]
      : [];
    const departs = tr.lastRateZ !== null && Math.abs(tr.lastRateZ) >= DEPARTS_Z;
    if (departs)
      out.push({
        id: `pile-departs:${f.id}`,
        rule: 'pile-departs',
        severity: 'warning',
        text: { key: 'insights.pileDeparts', params: { name: f.label, date: tr.lastDate } },
        evidence,
        actions: [fly, ...compare],
      });
    else if (before && tr.lastChangeM3 !== null && before.valueM3 !== 0) {
      // a figure that starts from nothing has no share to speak of
      const change = tr.lastChangeM3;
      const share = Math.abs(change / before.valueM3);
      if (Math.abs(change) >= MOVED_MIN_M3 && share >= MOVED_SHARE)
        out.push({
          id: `pile-moved:${f.id}`,
          rule: 'pile-moved',
          severity: 'info',
          text: {
            key: change > 0 ? 'insights.pileGrew' : 'insights.pileShrank',
            params: {
              name: f.label,
              change: { volume: Math.abs(change) },
              pct: Math.round(share * 100),
              from: before.date,
              date: tr.lastDate,
            },
          },
          evidence,
          actions: [fly, ...compare],
        });
    }
    if (tr.emptyOn !== null && !Number.isNaN(today)) {
      const left = dayOf(tr.emptyOn) - today;
      if (left < 0)
        out.push({
          id: `pile-empties:${f.id}`,
          rule: 'pile-empties',
          severity: 'warning',
          text: { key: 'insights.pileEmptyPast', params: { name: f.label, date: tr.lastDate } },
          evidence,
          actions: [fly],
        });
      else if (left <= EMPTIES_DAYS)
        out.push({
          id: `pile-empties:${f.id}`,
          rule: 'pile-empties',
          severity: left <= EMPTIES_SOON_DAYS ? 'warning' : 'info',
          text: { key: 'insights.pileEmpties', params: { name: f.label, date: tr.emptyOn } },
          evidence,
          actions: [fly],
        });
    }
  }
  return out;
}

/** What is worth a look on the site now, most pressing first. Pure; never writes. */
export function siteInsights(s: SiteSnapshot): Insight[] {
  const dated = byDate(s.captures);
  const latest = dated.length >= 2 ? (dated[dated.length - 1]?.id ?? null) : null;
  const before = dated.length >= 2 ? dated[dated.length - 2] : undefined;
  const latestPair = latest !== null && before ? { from: before.id, to: latest } : null;
  const ctx: QaFlagContext = { qa: s.qa, captures: s.captures, rmseLimitM: s.rmseLimitM };
  const all = [
    ...qaRules(s, ctx, latest),
    ...changeRules(s, latestPair),
    ...figureRules(s, latest),
  ];
  const rank = (i: Insight) =>
    SEVERITY_ORDER.indexOf(i.severity) * 100 + RULE_ORDER.indexOf(i.rule);
  return all.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
