/**
 * The site digest's rules (study items 5.2 and 5.8), pure: `siteInsights` reads a snapshot of the
 * project (survey dates, QA files, measurements, change sets) and returns what is worth a look,
 * each insight with its evidence and the actions that answer it. Rules, never AI; insights
 * propose and never change data (the change verdicts stay proposals too).
 *
 * The rules, one fixture test each (`rules.test.ts`):
 *
 * | rule               | severity          | when                                                        |
 * | ------------------ | ----------------- | ----------------------------------------------------------- |
 * | `survey-held`      | critical          | a date is held by a failed QA check nobody released          |
 * | `rmse-over`        | warning           | a date's checkpoint RMSE is over the site limit (not held)   |
 * | `survey-unchecked` | info              | the latest date has no QA file, or no verdict (level Off)    |
 * | `no-checkpoints`   | info              | the latest date passed QA without checkpoints               |
 * | `change-stale`     | warning           | a change set is out of date after a line-up                  |
 * | `change-review`    | info              | the latest pair has change items nobody reviewed            |
 * | `pile-departs`     | warning           | a figure's last rate departs from its trend (robust z)       |
 * | `pile-moved`       | info              | a figure moved over 20 % and 5 m³ since the date before      |
 * | `pile-empties`     | warning or info   | a falling figure reaches 0 within 60 days (14: warning)      |
 *
 * Figure rules look only at measurements whose last figure is on the latest survey date, so the
 * digest speaks about now. Sorted by severity, then rule order, then subject.
 */
import type { ChangeSetSummary, QaLevel, SurveyMeasurement, SurveyQa } from '@aio/schema';
import { qaFlagsFor, resultCapture, type QaFlagContext } from './qaFlags';
import { volumeTrend, type TrendPoint } from './trend';

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
  | 'rmse-over'
  | 'survey-unchecked'
  | 'no-checkpoints'
  | 'change-stale'
  | 'change-review'
  | 'pile-departs'
  | 'pile-moved'
  | 'pile-empties';

/** The insight's words: an `insights.*` key and its values (dates as ISO dates). */
export interface InsightText {
  key: InsightTextKey;
  params: Record<string, string | number>;
}

export type InsightTextKey =
  | 'insights.held'
  | 'insights.rmseOver'
  | 'insights.unchecked'
  | 'insights.noVerdict'
  | 'insights.noCheckpoints'
  | 'insights.changeStale'
  | 'insights.changeReview'
  | 'insights.pileDeparts'
  | 'insights.pileGrew'
  | 'insights.pileShrank'
  | 'insights.pileEmpties';

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

export interface SiteSnapshot {
  captures: readonly { id: string; date: string; label: string }[];
  /** QA files by capture id. */
  qa: Readonly<Record<string, SurveyQa>>;
  qaLevel: QaLevel;
  /** The site's checkpoint RMSE limit (`rmseLimit`), null at level Off. */
  rmseLimitM: number | null;
  measurements: readonly SurveyMeasurement[];
  /** Change set summaries of the project. */
  changes: readonly ChangeSetSummary[];
  /** Ids of change sets out of date after a line-up (`changeSetStale`, of the loaded sets). */
  staleChangeSets: readonly string[];
}

/** A figure moved this share or more since the date before... */
export const MOVED_SHARE = 0.2;
/** ...and at least this many m³. */
export const MOVED_MIN_M3 = 5;
/** A last rate this many robust standard deviations off the earlier ones. */
export const DEPARTS_Z = 3.5;
/** A falling figure that reaches 0 within this many days. */
export const EMPTIES_DAYS = 60;
export const EMPTIES_SOON_DAYS = 14;

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'warning', 'info'];
const RULE_ORDER: readonly InsightRule[] = [
  'survey-held',
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

/** A measurement's usable figures per date: its series rows that are not refused or stale. */
export function figuresOf(
  m: SurveyMeasurement,
  captures: readonly { id: string; date: string }[],
): TrendPoint[] {
  const dates = new Map(captures.map((c) => [c.id, c.date]));
  const seen = new Set<string>();
  const out: TrendPoint[] = [];
  for (const r of m.series ?? []) {
    if (r.status === 'refused' || r.status === 'stale') continue;
    const capture = resultCapture(r);
    const date = dates.get(capture);
    if (!date || seen.has(capture)) continue;
    seen.add(capture);
    out.push({ capture, date, valueM3: r.netM3 });
  }
  return out;
}

const qaAction = (capture: string): InsightAction => ({ id: 'insights.openQa', capture });

function qaRules(s: SiteSnapshot, ctx: QaFlagContext, latest: string | null): Insight[] {
  const out: Insight[] = [];
  for (const c of byDate(s.captures)) {
    const flags = qaFlagsFor(c.id, ctx);
    const qa = s.qa[c.id];
    if (flags.includes('qa-hold')) {
      const figures = s.measurements.filter((m) =>
        (m.series ?? []).some((r) => resultCapture(r) === c.id),
      );
      out.push({
        id: `survey-held:${c.id}`,
        rule: 'survey-held',
        severity: 'critical',
        text: { key: 'insights.held', params: { date: c.date, count: figures.length } },
        evidence: [
          { kind: 'qa', capture: c.id },
          ...figures.map((m): EvidenceRef => ({ kind: 'measurement', id: m.id })),
        ],
        actions: [qaAction(c.id)],
      });
    } else if (flags.includes('rmse-over-limit') && qa?.checkpoints && ctx.rmseLimitM !== null) {
      out.push({
        id: `rmse-over:${c.id}`,
        rule: 'rmse-over',
        severity: 'warning',
        text: {
          key: 'insights.rmseOver',
          params: {
            date: c.date,
            rmse: Math.round(qa.checkpoints.rmseM * 1000) / 10,
            limit: Math.round(ctx.rmseLimitM * 1000) / 10,
          },
        },
        evidence: [{ kind: 'qa', capture: c.id }],
        actions: [qaAction(c.id)],
      });
    }
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
  for (const m of s.measurements) {
    const points = figuresOf(m, s.captures);
    const tr = volumeTrend(points);
    if (tr.lastCapture !== latest || tr.lastM3 === null || tr.lastDate === null) continue;
    const before = byDate(points.map((p) => ({ ...p, id: p.capture }))).at(-2);
    const evidence: EvidenceRef[] = [
      { kind: 'measurement', id: m.id },
      { kind: 'capture', id: latest },
      ...(before ? [{ kind: 'capture', id: before.capture } as EvidenceRef] : []),
    ];
    const fly: InsightAction = { id: 'measure.flyTo', measurement: m.id };
    const compare: InsightAction[] = before
      ? [{ id: 'date.compare', pair: { from: before.capture, to: latest } }]
      : [];
    const departs = tr.lastRateZ !== null && Math.abs(tr.lastRateZ) >= DEPARTS_Z;
    if (departs)
      out.push({
        id: `pile-departs:${m.id}`,
        rule: 'pile-departs',
        severity: 'warning',
        text: {
          key: 'insights.pileDeparts',
          params: { name: m.label, date: tr.lastDate, change: Math.round(tr.lastChangeM3 ?? 0) },
        },
        evidence,
        actions: [fly, ...compare],
      });
    else if (before && tr.lastChangeM3 !== null && before.valueM3 !== 0) {
      // a figure that starts from nothing has no share to speak of
      const change = tr.lastChangeM3;
      const share = Math.abs(change / before.valueM3);
      if (Math.abs(change) >= MOVED_MIN_M3 && share >= MOVED_SHARE)
        out.push({
          id: `pile-moved:${m.id}`,
          rule: 'pile-moved',
          severity: 'info',
          text: {
            key: change > 0 ? 'insights.pileGrew' : 'insights.pileShrank',
            params: {
              name: m.label,
              change: Math.round(Math.abs(change)),
              pct: Math.round(share * 100),
              from: before.date,
              date: tr.lastDate,
            },
          },
          evidence,
          actions: [fly, ...compare],
        });
    }
    if (tr.daysToEmpty !== null && tr.emptyOn !== null && tr.daysToEmpty <= EMPTIES_DAYS)
      out.push({
        id: `pile-empties:${m.id}`,
        rule: 'pile-empties',
        severity: tr.daysToEmpty <= EMPTIES_SOON_DAYS ? 'warning' : 'info',
        text: {
          key: 'insights.pileEmpties',
          params: {
            name: m.label,
            count: Math.max(1, Math.ceil(tr.daysToEmpty)),
            date: tr.emptyOn,
            rate: Math.round(-(tr.rateM3PerDay ?? 0) * 10) / 10,
          },
        },
        evidence,
        actions: [fly],
      });
  }
  return out;
}

/** What is worth a look on the site now, most pressing first. Pure; never writes. */
export function siteInsights(s: SiteSnapshot): Insight[] {
  const dated = byDate(s.captures);
  const latestCapture = dated.length >= 2 ? dated[dated.length - 1] : undefined;
  const latest = latestCapture?.id ?? null;
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
