/**
 * Analysis and output tools: compare captures, measure, find issues near a place, summaries by
 * zone and class, export issues and show sites on the Globe. Read tools only look at the
 * workspace and project files; export_issues writes a file (approval first).
 */
import { formatQuantity, localeOf } from '@aio/geo';
import {
  BoundaryEditsFile,
  defaultSurveySettings,
  MEASUREMENTS_FILE,
  MeasurementsFile,
  SURVEY_SETTINGS_FILE,
  SurveySettings,
  VolumesFile,
  type ComparisonResult,
  type GlobeSite,
  type Issue,
  type SurveyMeasurement,
  type VolumeBaseId,
} from '@aio/schema';
import { inventoryPiles, inventorySeries, openWithKitPiles, pileSeries } from '@aio/survey';
import { assetUrl, dateShiftOf } from '@aio/workspace';
import { changeSetsOf, changeSummary, verdictLine } from './change-tools';
import { issuesCsv } from './exporting';
import { targetPoint } from './places';
import {
  appHooks,
  define,
  issuePoint,
  issueRow,
  plural,
  project,
  severityRank,
  ToolError,
  type RendererToolContext,
} from './tool-kit';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

const bySeverity = (issues: readonly Issue[]) => countBy(issues, (i) => String(i.severity));

/** Codes of the most severe issues first. */
function worstCodes(issues: readonly Issue[], n = 3): string[] {
  return [...issues]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, n)
    .map((i) => i.code);
}

function filterIssues(
  ctx: RendererToolContext,
  f: {
    status?: string | undefined;
    classId?: string | undefined;
    severityMin?: number | undefined;
  },
): Issue[] {
  return ctx.workspace
    .getState()
    .issues.filter(
      (i) =>
        (!f.status || i.status === f.status) &&
        (!f.classId || i.classId === f.classId) &&
        (f.severityMin === undefined || severityRank(i.severity) >= f.severityMin),
    );
}

function classLabels(ctx: RendererToolContext): Map<string, string> {
  return new Map(
    project(ctx).manifest.classCatalogues.flatMap((c) => c.classes.map((k) => [k.id, k.label])),
  );
}

// compare_captures ---------------------------------------------------------------------------

interface CaptureRef {
  id: string;
  label: string;
  date: string;
}

function pickCapture(all: readonly CaptureRef[], ref: string | undefined, fallback: CaptureRef) {
  if (ref === undefined) return fallback;
  const q = ref.toLowerCase();
  const found =
    all.find((c) => c.id.toLowerCase() === q || c.label.toLowerCase() === q) ??
    all.find((c) => c.date === ref || c.date.startsWith(ref)) ??
    all.find((c) => c.label.toLowerCase().includes(q));
  if (!found) {
    const list = all.map((c) => `${c.id} (${c.date})`).join(', ');
    throw new ToolError(`No capture "${ref}" in this project. Captures: ${list}.`);
  }
  return found;
}

async function projectJson(ctx: RendererToolContext, path: string): Promise<unknown> {
  try {
    return await ctx.fetchJson(assetUrl(project(ctx).id, { path }));
  } catch {
    return null;
  }
}

/**
 * The project's volume measurements as the app opens them (`openWithKitPiles`, the measure
 * store's rule), in memory: an old project's kit piles carried over with their kit figures when
 * the measurements file was never converted. `base` picks the kit base the carried figures are
 * on. Null without any.
 */
async function loadPiles(
  ctx: RendererToolContext,
  base: VolumeBaseId | undefined,
): Promise<{ piles: SurveyMeasurement[]; settings: SurveySettings } | null> {
  const [fileRaw, kitRaw, editsRaw, settingsRaw] = await Promise.all([
    projectJson(ctx, MEASUREMENTS_FILE),
    projectJson(ctx, 'volumes.json'),
    projectJson(ctx, 'edits/boundaries.json'),
    projectJson(ctx, SURVEY_SETTINGS_FILE),
  ]);
  const f = MeasurementsFile.safeParse(fileRaw);
  const s = SurveySettings.safeParse(settingsRaw);
  const settings = s.success ? s.data : defaultSurveySettings();
  const kit = VolumesFile.safeParse(kitRaw);
  const edits = BoundaryEditsFile.safeParse(editsRaw);
  let n = 0;
  const file = openWithKitPiles(
    f.success ? f.data : { schema: 'aio.measurements/1', measurements: [] },
    {
      volumes: kit.success ? (base ? { ...kit.data, defaultBase: base } : kit.data) : null,
      edits: edits.success ? edits.data : null,
    },
    {
      origin: project(ctx).manifest.origin,
      materials: settings.materials,
      now: ctx.now().toISOString(),
      newId: () => `kit-${String(++n)}`,
      // the assistant reads only: nothing is written or marked
      readOnly: true,
    },
  );
  const piles = inventoryPiles(file.measurements);
  return piles.length > 0 ? { piles, settings } : null;
}

/**
 * Each volume measurement's figure on the two dates, the one its card shows (`pileSeries`: its
 * stored result for its own date, its per-date results for the others), and the site totals by
 * the Volumes view's rule (`inventorySeries`: current figures added, the rest named).
 */
function compareVolumes(
  loaded: { piles: SurveyMeasurement[]; settings: SurveySettings },
  captures: readonly CaptureRef[],
  from: CaptureRef,
  to: CaptureRef,
) {
  const { piles, settings } = loaded;
  const units = settings.units;
  const fmt = (m3: number) =>
    formatQuantity(
      m3,
      'volume',
      units,
      settings.precision,
      settings.locale ?? localeOf(units.distance),
    );
  // stale as the app judges it (its fingerprints now), when the app is there to say
  const stale = appHooks.volumeStale;
  const isStale = (m: SurveyMeasurement, r: ComparisonResult, stored: boolean) =>
    r.status === 'stale' || (stale?.(m, r, stored) ?? false);
  const rows = inventorySeries(piles, captures, { isStale });
  const rowFrom = rows.find((r) => r.capture === from.id);
  const rowTo = rows.find((r) => r.capture === to.id);
  /** A row's date (R16): `toCapture`, else `fromCapture`. */
  const dateOf = (r: ComparisonResult) => r.toCapture ?? r.fromCapture;
  const figure = (series: ComparisonResult[], c: CaptureRef) => {
    const r = series.find((x) => dateOf(x) === c.id);
    return r && r.status !== 'refused' ? r : undefined;
  };
  const out = piles.map((m) => {
    const { series, stored } = pileSeries(m);
    const a = figure(series, from);
    const b = figure(series, to);
    const staleAt = (r: ComparisonResult | undefined) =>
      r !== undefined && !r.carried && isStale(m, r, r === stored);
    const carried = series.find((r) => r.carried)?.carried;
    const item = m.items[0];
    return {
      id: m.id,
      name: m.label,
      base: carried ? `kit ${carried.base}` : (item?.from.kind ?? null),
      ...(carried ? { carried: true } : {}),
      ...(a !== undefined ? { from: round1(a.netM3) } : {}),
      ...(b !== undefined ? { to: round1(b.netM3) } : {}),
      ...(staleAt(a) || staleAt(b) ? { stale: true } : {}),
      ...(a !== undefined && b !== undefined
        ? {
            change: round1(b.netM3 - a.netM3),
            changePct: a.netM3 > 0 ? round1(((b.netM3 - a.netM3) / a.netM3) * 100) : null,
          }
        : { change: null }),
    };
  });
  // the total on each date of the piles counted on both (current figures only)
  const at = (r: typeof rowFrom) => new Map((r?.parts ?? []).map((x) => [x.id, x.valueM3]));
  const pa = at(rowFrom);
  const pb = at(rowTo);
  const common = [...pa.keys()].filter((id) => pb.has(id));
  const sum = (m: Map<string, number>, ids: readonly string[]) =>
    ids.reduce((s, id) => s + (m.get(id) ?? 0), 0);
  const notCounted = (r: typeof rowFrom) =>
    (r?.notCounted ?? []).map((x) => ({ id: x.id, reason: x.reason }));
  const total =
    common.length > 0
      ? {
          from: round1(sum(pa, common)),
          to: round1(sum(pb, common)),
          change: round1(sum(pb, common) - sum(pa, common)),
          piles: common.length,
          of: piles.length,
          changeText: fmt(sum(pb, common) - sum(pa, common)),
        }
      : null;
  return {
    kind: 'volumes' as const,
    unit: 'm3',
    note: 'Net volume of each volume measurement as its card shows it. Totals add current figures only, over the piles counted on both dates.',
    from: {
      captureId: from.id,
      date: from.date,
      total: rowFrom && rowFrom.parts.length > 0 ? round1(rowFrom.totalM3) : null,
      notCounted: notCounted(rowFrom),
    },
    to: {
      captureId: to.id,
      date: to.date,
      total: rowTo && rowTo.parts.length > 0 ? round1(rowTo.totalM3) : null,
      notCounted: notCounted(rowTo),
    },
    total,
    piles: out,
  };
}

function compareIssues(issues: readonly Issue[], from: CaptureRef, to: CaptureRef) {
  const until = (date: string) => issues.filter((i) => i.createdAt.slice(0, 10) <= date);
  const a = until(from.date);
  const b = until(to.date);
  const added = b.filter((i) => i.createdAt.slice(0, 10) > from.date);
  return {
    kind: 'issues' as const,
    note: 'Issues counted by the date they were recorded.',
    from: { captureId: from.id, date: from.date, total: a.length, bySeverity: bySeverity(a) },
    to: { captureId: to.id, date: to.date, total: b.length, bySeverity: bySeverity(b) },
    addedBetween: { total: added.length, bySeverity: bySeverity(added), worst: worstCodes(added) },
  };
}

define('compare_captures', async (input, ctx) => {
  const captures = [...project(ctx).manifest.captures].sort((a, b) => a.date.localeCompare(b.date));
  const first = captures[0];
  const last = captures.at(-1);
  if (!first || !last || captures.length < 2) {
    throw new ToolError(
      'This project has fewer than two capture dates, so there is nothing to compare. Try summarize_issues.',
    );
  }
  const from = pickCapture(captures, input.from, first);
  const to = pickCapture(captures, input.to, last);
  const volumes = await loadPiles(ctx, input.base);
  // the kit base applies to figures carried over from an earlier version only
  if (
    input.base !== undefined &&
    !volumes?.piles.some(
      (m) => m.results.some((r) => r.carried) || m.series?.some((r) => r.carried),
    )
  )
    throw new ToolError(
      'The base applies only to stockpile figures carried over from an earlier version (the kit). This project has none: each volume measurement has its own base, as its card shows. Ask again without a base.',
    );
  // v2 (M8): the saved change sets of the pair, any kind, when there are any
  const [early, late] = from.date <= to.date ? [from, to] : [to, from];
  const sets = await changeSetsOf(ctx, early.id, late.id);
  if (sets.length > 0) {
    const r = {
      kind: 'changes' as const,
      from: { captureId: early.id, date: early.date },
      to: { captureId: late.id, date: late.date },
      ...changeSummary(sets),
      ...(volumes ? { volumes: compareVolumes(volumes, captures, early, late) } : {}),
    };
    return { result: r, summary: verdictLine(sets) };
  }
  if (volumes) {
    const r = compareVolumes(volumes, captures, from, to);
    const t = r.total;
    return {
      result: r,
      summary: t ? `${t.change > 0 ? '+' : ''}${t.changeText}` : 'Volumes compared',
    };
  }
  const r = compareIssues(ctx.workspace.getState().issues, from, to);
  return { result: r, summary: `${r.addedBetween.total} added` };
});

// measure_distance and find_issues_near -------------------------------------------------------

define('measure_distance', async ({ from, to }, ctx) => {
  const a = await targetPoint(ctx, from);
  const b = await targetPoint(ctx, to);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return {
    result: {
      from: a.map(round2),
      to: b.map(round2),
      distanceM: round2(distance),
      horizontalM: round2(Math.sqrt(dx * dx + dz * dz)),
      heightDifferenceM: round2(dy),
    },
    summary: `${distance.toFixed(2)} m`,
  };
});

define('find_issues_near', async ({ target, radiusM, limit }, ctx) => {
  const p = await targetPoint(ctx, target);
  let withoutLocation = 0;
  const hits: { issue: Issue; d: number }[] = [];
  // the target is where the view draws it: so are the pins, with their date's line-up
  const m = project(ctx).manifest;
  for (const issue of ctx.workspace.getState().issues) {
    const q = issuePoint(issue, (id) => dateShiftOf(m, id));
    if (!q) {
      withoutLocation += 1;
      continue;
    }
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d <= radiusM) hits.push({ issue, d });
  }
  hits.sort((a, b) => a.d - b.d);
  return {
    result: {
      point: p.map(round2),
      radiusM,
      total: hits.length,
      withoutLocation,
      issues: hits.slice(0, limit).map((h) => ({ ...issueRow(h.issue), distanceM: round2(h.d) })),
    },
    summary: plural(hits.length, 'issue'),
  };
});

// summaries ----------------------------------------------------------------------------------

/** "Location: 77.0 m above datum, NE side, Flare head." (kit imports) to "Flare head". */
const LOCATION = /Location:[^\n]*,\s*([^,\n]+?)\.?\s*(?:\n|$)/;
/** "Area: Bottom plate." */
const AREA = /\bArea:\s*([^.\n]+)/;
const KM = /\bkm\s*(\d+(?:\.\d+)?)/i;

function zoneOf(issue: Issue, kmBin: number, layerNames: ReadonlyMap<string, string>) {
  const loc = LOCATION.exec(issue.note)?.[1] ?? AREA.exec(issue.note)?.[1];
  if (loc) return { zone: loc.trim(), by: 'location' as const };
  const km = KM.exec(issue.title)?.[1];
  if (km !== undefined) {
    const lo = Math.floor(Number(km) / kmBin) * kmBin;
    const fmt = (n: number) => String(round2(n));
    return { zone: `km ${fmt(lo)} to ${fmt(lo + kmBin)}`, by: 'chainage' as const };
  }
  const layer = issue.sightings[0]?.layer;
  return { zone: (layer && layerNames.get(layer)) ?? layer ?? 'No zone', by: 'layer' as const };
}

define('summarize_by_zone', ({ status, kmBin }, ctx) => {
  const layerNames = new Map(project(ctx).manifest.layers.map((l) => [l.id, l.name]));
  const issues = filterIssues(ctx, status ? { status } : {});
  const groups = new Map<string, Issue[]>();
  const method: Record<string, number> = {};
  for (const i of issues) {
    const { zone, by } = zoneOf(i, kmBin, layerNames);
    groups.set(zone, [...(groups.get(zone) ?? []), i]);
    method[by] = (method[by] ?? 0) + 1;
  }
  const zones = [...groups.entries()]
    .map(([zone, list]) => ({
      zone,
      total: list.length,
      open: list.filter((i) => i.status !== 'closed').length,
      bySeverity: bySeverity(list),
      worst: worstCodes(list),
    }))
    .sort((a, b) => b.total - a.total || a.zone.localeCompare(b.zone));
  return {
    result: {
      total: issues.length,
      zoneCount: zones.length,
      zonedBy: method,
      zones: zones.slice(0, 40),
    },
    summary: plural(zones.length, 'zone'),
  };
});

define('summarize_by_class', ({ status }, ctx) => {
  const labels = classLabels(ctx);
  const issues = filterIssues(ctx, status ? { status } : {});
  const groups = new Map<string, Issue[]>();
  for (const i of issues) groups.set(i.classId, [...(groups.get(i.classId) ?? []), i]);
  const classes = [...groups.entries()]
    .map(([classId, list]) => ({
      classId,
      label: labels.get(classId) ?? classId,
      total: list.length,
      bySeverity: bySeverity(list),
      byStatus: countBy(list, (i) => i.status),
      worst: worstCodes(list),
    }))
    .sort((a, b) => b.total - a.total);
  return { result: { total: issues.length, classes }, summary: plural(classes.length, 'class') };
});

// export_issues -------------------------------------------------------------------------------

define('export_issues', async (filters, ctx) => {
  const p = project(ctx);
  const issues = filterIssues(ctx, filters);
  if (issues.length === 0)
    throw new ToolError('No issues match these filters, so there is nothing to export.');
  const exporter = ctx.app?.exportIssues;
  let saved: { path: string | null; error?: string };
  if (exporter) {
    saved = await exporter(issues, 'csv');
  } else {
    if (!ctx.saveFile) throw new ToolError('Exporting files works in the desktop app only.');
    saved = await ctx.saveFile(
      `${p.manifest.name} issues.csv`,
      issuesCsv(issues, classLabels(ctx), (id) => dateShiftOf(p.manifest, id)),
    );
  }
  if (saved.error) throw new ToolError(saved.error);
  if (saved.path === null) {
    return {
      result: { path: null, rows: issues.length, format: 'csv', cancelled: true },
      summary: 'Cancelled',
    };
  }
  return {
    result: { path: saved.path, rows: issues.length, format: 'csv' },
    summary: plural(issues.length, 'row'),
  };
});

// list_sites and show_on_globe (M10 Globe): the library on the Earth, no open project needed

async function librarySites(ctx: RendererToolContext): Promise<GlobeSite[]> {
  const list = ctx.app?.listSites;
  if (!list) throw new ToolError('The Globe is only in the desktop app.');
  return list();
}

define('list_sites', async (_input, ctx) => {
  const sites = await librarySites(ctx);
  const open = ctx.workspace.getState().project?.id ?? null;
  return {
    result: {
      sites: sites.map((s) => ({
        projectId: s.projectId,
        name: s.name,
        lon: Math.round(s.lonLat[0] * 1e6) / 1e6,
        lat: Math.round(s.lonLat[1] * 1e6) / 1e6,
        surveys: s.captures.map((c) => c.date),
        openIssues: s.issues.open,
        bySeverity: s.issues.bySeverity,
        tilesets: s.tilesets.map((t) => t.name),
        ...(s.projectId === open ? { open: true } : {}),
      })),
    },
    summary: plural(sites.length, 'site'),
  };
});

define('show_on_globe', async ({ site }, ctx) => {
  const show = ctx.app?.showOnGlobe;
  if (!show) throw new ToolError('The Globe is only in the desktop app.');
  const sites = await librarySites(ctx);
  let target: GlobeSite | undefined;
  if (site) {
    const want = site.trim().toLowerCase();
    target =
      sites.find((s) => s.projectId.toLowerCase() === want) ??
      sites.find((s) => s.name.toLowerCase() === want);
    if (!target)
      throw new ToolError(
        `No site "${site}" on the Globe. Choose a project id from list_sites: ${sites
          .slice(0, 20)
          .map((s) => s.projectId)
          .join(', ')}.`,
      );
  } else {
    const open = ctx.workspace.getState().project?.id;
    target = sites.find((s) => s.projectId === open);
  }
  show(target?.projectId ?? null);
  return {
    result: target
      ? { shown: target.projectId, name: target.name, lonLat: target.lonLat }
      : { shown: 'library', sites: sites.length },
    summary: target ? target.name : 'Globe',
  };
});
