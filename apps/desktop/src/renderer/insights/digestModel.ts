/**
 * The site digest's inputs and words (intelligence review I2): the snapshot `siteInsights` reads,
 * built from what the app already keeps for the open project, and an insight's line in the
 * person's language with quantities in the site's units. Pure: no store is read here.
 *
 * The figures are the inventory's counted figures per date (`inventorySeries` with the app's own
 * staleness checks, `useInventory`), the rule the volume card uses, so the digest's numbers are
 * the card's. QA flags are worked out when read, never stored.
 */
import { formatNumber, formatQuantity, localeOf } from '@aio/geo';
import {
  figuresFromRows,
  rmseLimit,
  type EvidenceRef,
  type Insight,
  type InsightActionId,
  type InsightParam,
  type InsightTextKey,
  type SiteSnapshot,
  type SiteTrack,
} from '@aio/insights';
import type {
  ChangeSet,
  ChangeSetSummary,
  ProjectManifest,
  SurveyQa,
  SurveySettings,
} from '@aio/schema';
import type { StackRow } from '@aio/survey';
import { formatDate, type MessageKey } from '@aio/ui';

export interface DigestSources {
  manifest: Pick<ProjectManifest, 'captures' | 'origin'>;
  qa: Readonly<Record<string, SurveyQa>>;
  settings: Pick<SurveySettings, 'qa'>;
  /** The volume measurements (`inventoryPiles`) and their inventory rows (`useInventory`). */
  piles: readonly { id: string; label: string }[];
  rows: readonly StackRow[];
  summaries: readonly ChangeSetSummary[];
  /** The loaded change sets, by id (the stale check needs a whole set). */
  sets: Readonly<Record<string, ChangeSet>>;
  /** `changeSetStale` (passed in so this stays free of the workspace). */
  isStale: (set: ChangeSet) => boolean;
  /** Today, an ISO date. */
  today: string;
  /** Tracks across dates (`siteTracks`, M2). */
  tracks?: readonly SiteTrack[];
}

export function digestSnapshot(x: DigestSources): SiteSnapshot {
  return {
    captures: x.manifest.captures,
    qa: x.qa,
    qaLevel: x.settings.qa.level,
    rmseLimitM: rmseLimit(x.settings.qa.level, x.settings.qa.rmseM),
    figures: figuresFromRows(x.rows, x.piles),
    changes: x.summaries,
    staleChangeSets: Object.values(x.sets)
      .filter((s) => x.isStale(s))
      .map((s) => s.id),
    today: x.today,
    ...(x.tracks ? { tracks: x.tracks } : {}),
  };
}

/** Today on this computer, an ISO date. */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Every key a rule writes, each a catalogue key: a key missing from `en/insights.ts` fails here. */
const TEXT_KEYS: Record<InsightTextKey, MessageKey> = {
  'insights.held': 'insights.held',
  'insights.heldEarlier': 'insights.heldEarlier',
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
  'insights.pileEmptyPast': 'insights.pileEmptyPast',
  'insights.antennaTurned': 'insights.antennaTurned',
  'insights.antennaTilted': 'insights.antennaTilted',
  'insights.antennaTurnedTilted': 'insights.antennaTurnedTilted',
  'insights.hotspotHotter': 'insights.hotspotHotter',
  'insights.regionGrew': 'insights.regionGrew',
};

/** Parameters that hold an ISO date, shown as the app shows dates. */
const DATE_PARAMS = new Set(['date', 'from', 'to']);

/** The site's units, precision and number style, as the cards format with them. */
export type DigestUnits = Pick<SurveySettings, 'units' | 'precision' | 'locale'>;

/** One value in the site's units: dates as the app shows them, quantities as the cards do. */
function formatParam(key: string, v: InsightParam, u: DigestUnits): string | number {
  const locale = u.locale ?? localeOf(u.units.distance);
  if (typeof v === 'object')
    return 'volume' in v
      ? formatQuantity(v.volume, 'volume', u.units, u.precision, locale)
      : formatQuantity(v.distance, 'distance', u.units, u.precision, locale);
  if (typeof v === 'string') return DATE_PARAMS.has(key) && v ? formatDate(v) : v;
  // a count picks the plural form and stays a number; a percent is grouped like the cards
  return key === 'count' ? v : formatNumber(v, 0, locale);
}

/** An insight's line: its key, dates formatted, quantities in the site's units. */
export function insightLine(
  i: Insight,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  units: DigestUnits,
): string {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(i.text.params)) params[k] = formatParam(k, v, units);
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
  'insights.openAntenna': 'insights.action.openAntenna',
  'insights.openHotspot': 'insights.action.openHotspot',
};

/** The rows shown while folded. */
export const FOLDED_ROWS = 4;
