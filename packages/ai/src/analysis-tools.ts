/**
 * Analysis and output tools: compare captures, measure, find issues near a place, summaries by
 * zone and class, export issues and open the original review. Read tools only look at the
 * workspace and project files; export_issues writes a file (approval first).
 */
import type { GlobeSite, Issue } from '@aio/schema';
import { assetUrl } from '@aio/workspace';
import { z } from 'zod';
import { changeSetsOf, changeSummary, verdictLine } from './change-tools';
import { issuesCsv } from './exporting';
import { targetPoint } from './places';
import {
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

const VolumeNet = z.object({ net: z.number() }).loose();
const Volumes = z
  .object({
    schema: z.literal('aio.volumes/1'),
    defaultBase: z.string(),
    captures: z.array(
      z.object({ epoch: z.string(), captureId: z.string(), date: z.string() }).loose(),
    ),
    piles: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          epochs: z.record(
            z.string(),
            z.object({ volumes: z.record(z.string(), VolumeNet) }).loose(),
          ),
          change: z.object({ fill: z.number(), cut: z.number(), net: z.number() }).optional(),
        })
        .loose(),
    ),
    totals: z.record(z.string(), z.record(z.string(), z.number())),
    siteChange: z.object({ fill: z.number(), cut: z.number(), net: z.number() }).loose().optional(),
  })
  .loose();
type Volumes = z.infer<typeof Volumes>;

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

async function loadVolumes(ctx: RendererToolContext): Promise<Volumes | null> {
  let json: unknown;
  try {
    json = await ctx.fetchJson(assetUrl(project(ctx).id, { path: 'volumes.json' }));
  } catch {
    return null;
  }
  const r = Volumes.safeParse(json);
  return r.success ? r.data : null;
}

function compareVolumes(v: Volumes, from: CaptureRef, to: CaptureRef, baseIn: string | undefined) {
  const e1 = v.captures.find((c) => c.captureId === from.id)?.epoch;
  const e2 = v.captures.find((c) => c.captureId === to.id)?.epoch;
  if (!e1 || !e2) {
    throw new ToolError('The survey volumes do not cover both of these captures.');
  }
  const base = baseIn ?? v.defaultBase;
  const piles = v.piles.map((p) => {
    const a = p.epochs[e1]?.volumes[base]?.net;
    const b = p.epochs[e2]?.volumes[base]?.net;
    return {
      id: p.id,
      name: p.name,
      ...(a !== undefined ? { from: round1(a) } : {}),
      ...(b !== undefined ? { to: round1(b) } : {}),
      ...(a !== undefined && b !== undefined
        ? { change: round1(b - a), changePct: a > 0 ? round1(((b - a) / a) * 100) : null }
        : { change: null }),
      ...(p.change ? { surfaceChange: p.change } : {}),
    };
  });
  const tFrom = v.totals[e1]?.[base];
  const tTo = v.totals[e2]?.[base];
  const total =
    tFrom !== undefined && tTo !== undefined
      ? { from: round1(tFrom), to: round1(tTo), change: round1(tTo - tFrom) }
      : null;
  // The site cut and fill is between the survey's first and last epoch only.
  const firstLast = v.captures[0]?.epoch === e1 && v.captures.at(-1)?.epoch === e2;
  return {
    kind: 'volumes' as const,
    unit: 'm3',
    base,
    from: { captureId: from.id, date: from.date },
    to: { captureId: to.id, date: to.date },
    total,
    ...(firstLast && v.siteChange ? { siteChange: v.siteChange } : {}),
    piles,
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
  const volumes = await loadVolumes(ctx);
  // v2 (M8): the saved change sets of the pair, any kind, when there are any
  const [early, late] = from.date <= to.date ? [from, to] : [to, from];
  const sets = await changeSetsOf(ctx, early.id, late.id);
  if (sets.length > 0) {
    const r = {
      kind: 'changes' as const,
      from: { captureId: early.id, date: early.date },
      to: { captureId: late.id, date: late.date },
      ...changeSummary(sets),
      ...(volumes ? { volumes: compareVolumes(volumes, early, late, input.base) } : {}),
    };
    return { result: r, summary: verdictLine(sets) };
  }
  if (volumes) {
    const r = compareVolumes(volumes, from, to, input.base);
    const change = r.total?.change;
    return {
      result: r,
      summary:
        change === undefined
          ? 'Volumes compared'
          : `${change > 0 ? '+' : ''}${change} m³ (${r.base})`,
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
  for (const issue of ctx.workspace.getState().issues) {
    const q = issuePoint(issue);
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

// export_issues and open_original_review -----------------------------------------------------

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
      issuesCsv(issues, classLabels(ctx)),
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

define('open_original_review', ({ layerId }, ctx) => {
  const legacy = project(ctx).manifest.layers.filter((l) => l.kind === 'legacy');
  const layer = layerId ? legacy.find((l) => l.id === layerId || l.name === layerId) : legacy[0];
  if (!layer) {
    throw new ToolError(
      legacy.length === 0
        ? 'This project has no original review.'
        : `No original review "${layerId ?? ''}". Choose one of: ${legacy.map((l) => l.id).join(', ')}.`,
    );
  }
  const open = ctx.app?.openReview;
  if (!open) throw new ToolError('The original review can only be opened in the desktop app.');
  open(layer.id);
  return { result: { opened: layer.id, name: layer.name }, summary: layer.name };
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
