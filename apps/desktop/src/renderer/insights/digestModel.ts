/**
 * The site digest's inputs and words (intelligence review I2): the snapshot `siteInsights` reads,
 * built from the stores the app already keeps for the open project, and an insight's line in the
 * person's language. Pure: no store is read here.
 */
import {
  rmseLimit,
  type EvidenceRef,
  type Insight,
  type InsightActionId,
  type InsightTextKey,
  type SiteSnapshot,
} from '@aio/insights';
import type {
  ChangeSet,
  ChangeSetSummary,
  ProjectManifest,
  SurveyMeasurement,
  SurveyQa,
  SurveySettings,
} from '@aio/schema';
import { formatDate, type MessageKey } from '@aio/ui';

export interface DigestSources {
  manifest: Pick<ProjectManifest, 'captures' | 'origin'>;
  qa: Readonly<Record<string, SurveyQa>>;
  settings: Pick<SurveySettings, 'qa'>;
  measurements: readonly SurveyMeasurement[];
  summaries: readonly ChangeSetSummary[];
  /** The loaded change sets, by id (the stale check needs a whole set). */
  sets: Readonly<Record<string, ChangeSet>>;
  /** `changeSetStale` (passed in so this stays free of the workspace). */
  isStale: (set: ChangeSet) => boolean;
}

export function digestSnapshot(x: DigestSources): SiteSnapshot {
  return {
    captures: x.manifest.captures,
    qa: x.qa,
    qaLevel: x.settings.qa.level,
    rmseLimitM: rmseLimit(x.settings.qa.level, x.settings.qa.rmseM),
    measurements: x.measurements,
    changes: x.summaries,
    staleChangeSets: Object.values(x.sets)
      .filter((s) => x.isStale(s))
      .map((s) => s.id),
  };
}

/** Every key a rule writes, each a catalogue key: a key missing from `en/insights.ts` fails here. */
const TEXT_KEYS: Record<InsightTextKey, MessageKey> = {
  'insights.held': 'insights.held',
  'insights.rmseOver': 'insights.rmseOver',
  'insights.unchecked': 'insights.unchecked',
  'insights.noVerdict': 'insights.noVerdict',
  'insights.noCheckpoints': 'insights.noCheckpoints',
  'insights.changeStale': 'insights.changeStale',
  'insights.changeReview': 'insights.changeReview',
  'insights.pileDeparts': 'insights.pileDeparts',
  'insights.pileGrew': 'insights.pileGrew',
  'insights.pileShrank': 'insights.pileShrank',
  'insights.pileEmpties': 'insights.pileEmpties',
};

/** Parameters that hold an ISO date, shown as the app shows dates. */
const DATE_PARAMS = new Set(['date', 'from', 'to']);

/** An insight's line: its key with dates formatted. */
export function insightLine(
  i: Insight,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(i.text.params))
    params[k] = DATE_PARAMS.has(k) && typeof v === 'string' && v ? formatDate(v) : v;
  return t(TEXT_KEYS[i.text.key], params);
}

/** The figures an insight rests on (the measurements in its evidence). */
export const figureCount = (i: Insight): number =>
  i.evidence.filter((e: EvidenceRef) => e.kind === 'measurement').length;

/** The label of an action button. */
export const ACTION_LABEL: Record<InsightActionId, MessageKey> = {
  'insights.openQa': 'insights.action.openQa',
  'insights.openChanges': 'insights.action.openChanges',
  'measure.flyTo': 'insights.action.flyTo',
  'date.compare': 'insights.action.compare',
};

/** The rows shown while folded. */
export const FOLDED_ROWS = 4;
