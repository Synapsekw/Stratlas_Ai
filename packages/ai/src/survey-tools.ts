/**
 * Executors of the A2 read tools that need nothing beyond this package: measurements, volumes
 * (the compare_captures path: the cards' figures, stale as the app judges it) and where findings
 * gather. The rest run in the desktop renderer (agent/dataTools.ts). Specs in survey-tool-specs.ts.
 */
import type { ComparisonResult, Issue, SurveyMeasurement, Vec3 } from '@aio/schema';
import { densityOn, pileSeries, seriesDate } from '@aio/survey';
import {
  bySeverity,
  loadPiles,
  pickCapture,
  round2,
  worstCodes,
  zoneOf,
  type CaptureRef,
} from './analysis-tools';
import { findingsOn } from './show-tools';
import {
  appHooks,
  issuePoint,
  plural,
  project,
  registerRendererTool,
  round1,
  severityRank,
  ToolError,
  type RendererToolContext,
  type ToolRunResult,
} from './tool-kit';
import { surveyToolInputs, type SurveyToolInput, type SurveyToolName } from './survey-tool-specs';

function define<N extends SurveyToolName>(
  name: N,
  run: (
    input: SurveyToolInput<N>,
    ctx: RendererToolContext,
  ) => Promise<ToolRunResult> | ToolRunResult,
): void {
  registerRendererTool(name, (input, ctx) =>
    Promise.resolve(run(surveyToolInputs[name].parse(input) as SurveyToolInput<N>, ctx)),
  );
}

/** The project's survey dates, oldest first. */
export function capturesOf(ctx: RendererToolContext): CaptureRef[] {
  return [...project(ctx).manifest.captures].sort((a, b) => a.date.localeCompare(b.date));
}

/** A survey date by id, date or name; an error that lists the dates when none matches. */
export function captureRef(ctx: RendererToolContext, ref: string): CaptureRef {
  const all = capturesOf(ctx);
  const first = all[0];
  const last = all.at(-1);
  if (!first || !last) throw new ToolError('This project has no survey dates.');
  const q = ref.toLowerCase();
  if (q === 'earliest' || q === 'first' || q === 'oldest') return first;
  if (q === 'latest' || q === 'last' || q === 'newest') return last;
  return pickCapture(all, ref, first);
}

/** The measurements the app shows: its store when it has the project open, else none read yet. */
function measurementsOf(ctx: RendererToolContext): SurveyMeasurement[] | null {
  return appHooks.surveyMeasurements?.(project(ctx).id)?.measurements ?? null;
}

const KINDS: Record<string, readonly string[]> = {
  volume: ['volume'],
  distance: ['distance', 'path', 'height'],
  area: ['area'],
  elevation: ['elevation', 'point'],
  section: ['section', 'profile'],
};
const kindOf = (m: SurveyMeasurement): string =>
  Object.entries(KINDS).find(([, tools]) => tools.includes(m.tool))?.[0] ?? 'other';

/** Length along the points (metres) and plan area of a closed outline (m², local X and Z). */
function geometry(m: SurveyMeasurement): { lengthM?: number; areaM2?: number } {
  const p = m.points;
  if (p.length < 2) return {};
  let len = 0;
  let twice = 0;
  p.forEach((a, i) => {
    const next = p[i + 1];
    if (next) len += Math.hypot(next[0] - a[0], next[1] - a[1], next[2] - a[2]);
    const b = next ?? p[0] ?? a;
    twice += a[0] * b[2] - b[0] * a[2];
  });
  if (m.family !== 'polygon') return { lengthM: round2(len) };
  return { areaM2: round1(Math.abs(twice) / 2) };
}

define('list_measurements', (input, ctx) => {
  const all = measurementsOf(ctx);
  if (all === null) {
    throw new ToolError(
      'The measurements of this project are not open yet. Open Scene, wait a moment and ask again.',
    );
  }
  const date = input.date !== undefined ? captureRef(ctx, input.date) : null;
  const text = input.text?.toLowerCase();
  const dates = new Map(capturesOf(ctx).map((c) => [c.id, c.date]));
  const hits = all.filter(
    (m) =>
      (!input.tool || kindOf(m) === input.tool) &&
      (!text || m.label.toLowerCase().includes(text)) &&
      (!date || (m.scope.kind === 'survey' && m.scope.capture === date.id)),
  );
  const rows = hits.slice(0, input.limit).map((m) => {
    const capture = m.scope.kind === 'survey' ? m.scope.capture : null;
    const stored = m.tool === 'volume' ? pileSeries(m).stored : undefined;
    return {
      id: m.id,
      name: m.label,
      kind: kindOf(m),
      tool: m.tool,
      date: capture ? (dates.get(capture) ?? capture) : null,
      ...(m.folder ? { folder: m.folder } : {}),
      ...geometry(m),
      ...(stored && stored.status !== 'refused' ? { netM3: round1(stored.netM3) } : {}),
    };
  });
  return {
    result: {
      total: hits.length,
      shown: rows.length,
      ...(hits.some((m) => m.tool === 'volume')
        ? { note: 'Volumes per survey date: get_volume.' }
        : {}),
      measurements: rows,
    },
    summary: plural(hits.length, 'measurement'),
  };
});

define('get_volume', async (input, ctx) => {
  const loaded = await loadPiles(ctx, undefined);
  if (!loaded) throw new ToolError('This project has no volume measurements.');
  const captures = capturesOf(ctx);
  const date = input.date !== undefined ? captureRef(ctx, input.date) : null;
  let piles = loaded.piles;
  if (input.measurement !== undefined) {
    const q = input.measurement.toLowerCase();
    const named = (m: SurveyMeasurement) => m.label.toLowerCase();
    const exact = piles.filter((m) => m.id === input.measurement || named(m) === q);
    const words = piles.filter((m) =>
      named(m)
        .split(/[^a-z0-9]+/)
        .includes(q),
    );
    const part = piles.filter((m) => named(m).includes(q));
    piles = exact.length ? exact : words.length ? words : part;
    if (piles.length === 0) {
      const names = loaded.piles.map((m) => m.label).join(', ');
      throw new ToolError(`No volume measurement "${input.measurement}". The piles: ${names}.`);
    }
  }
  const dateMs = new Map(captures.map((c) => [c.id, Date.parse(c.date)]));
  const dateOf = (id: string) => dateMs.get(id) ?? null;
  const dayOf = new Map(captures.map((c) => [c.id, c.date]));
  const stale = appHooks.volumeStale;
  const out = piles.map((m) => {
    const material = m.material
      ? loaded.settings.materials.find((x) => x.id === m.material)
      : undefined;
    const { series, stored } = pileSeries(m);
    const rows = series
      .filter((r) => r.status !== 'refused')
      .filter((r) => !date || seriesDate(r) === date.id)
      .map((r: ComparisonResult) => {
        const capture = seriesDate(r);
        const density = material && capture ? densityOn(material, capture, dateOf) : null;
        const isStale =
          r.status === 'stale' || (!r.carried && (stale?.(m, r, r === stored) ?? false));
        return {
          captureId: capture,
          date: capture ? (dayOf.get(capture) ?? capture) : null,
          netM3: round1(r.netM3),
          cutM3: round1(r.cutM3),
          fillM3: round1(r.fillM3),
          areaM2: round1(r.areaM2),
          ...(r.peakM !== undefined ? { peakM: round2(r.peakM) } : {}),
          ...(density !== null ? { tonnes: round1(r.netM3 * density) } : {}),
          ...(isStale ? { stale: true } : {}),
          ...(r.status === 'partial' ? { partial: r.reason ?? true } : {}),
        };
      })
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    return {
      id: m.id,
      name: m.label,
      base: m.items[0]?.from.kind ?? null,
      ...(material ? { material: material.name } : {}),
      dates: rows,
    };
  });
  return {
    result: {
      unit: 'm3',
      note: 'Net volume as each card shows it; stale figures are flagged and need a recompute.',
      piles: out,
    },
    summary: plural(out.length, 'pile'),
  };
});

const rankScore = (list: readonly Issue[]) =>
  list.reduce((s, i) => s + 1 + Math.max(0, severityRank(i.severity)) ** 2, 0);

define('rank_locations', (input, ctx) => {
  const { there, whole } = findingsOn(ctx, input.where);
  const ids = there ? new Set(there.ids) : null;
  const issues = ctx.workspace
    .getState()
    .issues.filter(
      (i) => (input.status === 'all' || i.status !== 'closed') && (!ids || ids.has(i.id)),
    );
  const layerNames = new Map(project(ctx).manifest.layers.map((l) => [l.id, l.name]));
  const groups = new Map<string, { label: string; list: Issue[]; points: Vec3[] }>();
  let unplaced = 0;
  for (const i of issues) {
    const p = issuePoint(i);
    let key: string;
    let label: string;
    if (input.by === 'zone') {
      key = label = zoneOf(i, 1, layerNames).zone;
    } else {
      if (!p) {
        unplaced += 1;
        continue;
      }
      const cx = Math.floor(p[0] / input.cellM);
      const cz = Math.floor(p[2] / input.cellM);
      key = `${String(cx)},${String(cz)}`;
      label = '';
    }
    const g = groups.get(key) ?? { label, list: [], points: [] };
    g.list.push(i);
    if (p) g.points.push(p);
    groups.set(key, g);
  }
  const ranked = [...groups.values()]
    .map((g) => {
      const n = g.points.length;
      const at =
        n > 0
          ? (g.points
              .reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0])
              .map((v) => round2(v / n)) as Vec3)
          : null;
      const worst = g.list.reduce((w, i) => Math.max(w, severityRank(i.severity)), -1);
      return {
        ...(g.label ? { zone: g.label } : {}),
        score: rankScore(g.list),
        findings: g.list.length,
        worstSeverity: worst < 0 ? 'uncertain' : worst,
        bySeverity: bySeverity(g.list),
        worst: worstCodes(g.list),
        ...(at ? { target: { kind: 'point' as const, p: at } } : {}),
      };
    })
    .sort((a, b) => b.score - a.score || b.findings - a.findings);
  return {
    result: {
      by: input.by,
      ...(input.by === 'position' ? { cellM: input.cellM } : {}),
      ...(there ? { on: there.label } : {}),
      ...(whole ? { note: 'No tagged asset is selected, so this covers the whole project.' } : {}),
      findings: issues.length,
      ...(unplaced > 0 ? { withoutPosition: unplaced } : {}),
      score: 'Each finding counts 1 plus its severity squared.',
      locations: ranked.slice(0, input.limit),
    },
    summary: plural(ranked.length, 'location'),
  };
});
