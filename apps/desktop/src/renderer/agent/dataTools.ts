/**
 * Executors of the A2 read tools that read the app's own stores (specs in `@aio/ai`
 * survey-tool-specs.ts): survey dates (the timeline), detections (the review store, whose undo a
 * review step takes back), jobs, the thermal file and walks. Also the `agentFacts` hook, so the
 * agent is offered these tools only in a project that has the data.
 */
import {
  ToolError,
  captureRef,
  capturesOf,
  registerRendererTool,
  surveyToolInputs,
  type AppHooks,
  type RendererToolContext,
  type RendererToolRun,
  type SurveyToolInput,
  type SurveyToolName,
  type ToolRunResult,
} from '@aio/ai';
import type { Detection } from '@aio/annotate/detections';
import { ThermalFile, type JobRecord, type Layer } from '@aio/schema';
import { assetUrl, captureIndex, workspace } from '@aio/workspace';
import { acceptByIds, detections, rejectAll, dispatch, undoReview } from '../detections/store';
import { isActive, sameFolder } from '../jobs';
import { jobs } from '../shell';
import { thermalPhotosOf } from '../shell/actions/thermalActions';
import { measureStore } from '../survey/measureStore';
import { timeline } from '../workspace/timeline';

const executors: [SurveyToolName, RendererToolRun][] = [];

/** Keep an executor for `registerDataTools`, its input checked against the spec. */
function define<N extends SurveyToolName>(
  name: N,
  run: (
    input: SurveyToolInput<N>,
    ctx: RendererToolContext,
  ) => Promise<ToolRunResult> | ToolRunResult,
): void {
  executors.push([
    name,
    (input, ctx) =>
      Promise.resolve(run(surveyToolInputs[name].parse(input) as SurveyToolInput<N>, ctx)),
  ]);
}

const plural = (n: number, w: string) => `${String(n)} ${w}${n === 1 ? '' : 's'}`;
const round1 = (n: number) => Math.round(n * 10) / 10;

function openProject(ctx: RendererToolContext) {
  const p = ctx.workspace.getState().project;
  if (!p) throw new ToolError('No project is open.');
  return p;
}

// survey dates -------------------------------------------------------------------------------

/** The focused survey date of the open project, or null. */
function focusOf(projectId: string): string | null {
  const tl = timeline.getState();
  return tl.projectId === projectId ? tl.focus : null;
}

define('list_surveys', (_input, ctx) => {
  const p = openProject(ctx);
  const index = captureIndex(p.manifest);
  const focus = focusOf(p.id);
  const dates = capturesOf(ctx).map((c) => {
    const full = p.manifest.captures.find((x) => x.id === c.id);
    return {
      id: c.id,
      date: c.date,
      ...(c.label !== c.date ? { name: c.label } : {}),
      layers: index.layers[c.id]?.length ?? 0,
      ...(c.id === focus ? { inView: true } : {}),
      ...(full?.lineUp ? { linedUp: true } : {}),
    };
  });
  const common = p.manifest.layers.filter((l) => index.of[l.id] === undefined).length;
  return {
    result: { total: dates.length, commonLayers: common, dates },
    summary: plural(dates.length, 'survey date'),
  };
});

define('set_survey_date', (input, ctx) => {
  const p = openProject(ctx);
  const c = captureRef(ctx, input.date);
  const before = focusOf(p.id);
  const tl = timeline.getState();
  if (tl.projectId !== p.id || !tl.index) {
    throw new ToolError('The survey dates are not ready yet. Ask again in a moment.');
  }
  tl.focusSurvey(c.id);
  const now = focusOf(p.id);
  if (now !== c.id && before !== c.id) {
    throw new ToolError(`The app did not switch to ${c.date}: a volume edit may be open.`);
  }
  return {
    result: { inView: { id: c.id, date: c.date, name: c.label } },
    summary: c.date,
    ...(before && before !== c.id
      ? {
          undo: () => {
            timeline.getState().focusSurvey(before);
          },
        }
      : {}),
  };
});

// detections ---------------------------------------------------------------------------------

/** The review detections of the open project; an error while they are not read. */
function reviewOf(ctx: RendererToolContext): readonly Detection[] {
  const p = openProject(ctx);
  const s = detections.getState();
  if (s.projectId !== p.id || s.loading) {
    throw new ToolError(
      'The detections of this project are still being read. Ask again in a moment.',
    );
  }
  return s.review.detections;
}

const countBy = <T>(list: readonly T[], key: (t: T) => string) =>
  list.reduce<Record<string, number>>((a, x) => {
    const k = key(x);
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {});

define('list_detections', (input, ctx) => {
  const all = reviewOf(ctx);
  const hits = all.filter(
    (d) =>
      (input.status === 'all' || d.status === input.status) &&
      (!input.classId || d.classId === input.classId) &&
      (input.minConfidence === undefined || (d.confidence ?? 0) >= input.minConfidence),
  );
  const rows = [...hits]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, input.limit)
    .map((d) => ({
      id: d.id,
      status: d.status,
      classId: d.classId || null,
      ...(d.label ? { label: d.label } : {}),
      severity: d.severity,
      ...(d.confidence !== undefined ? { confidence: round1(d.confidence * 100) / 100 } : {}),
      ...(d.source.kind === 'photo'
        ? { layer: d.source.layer, photo: d.source.photo }
        : { layer: d.source.layer, atSeconds: d.source.t }),
      ...(d.issueId ? { issueId: d.issueId } : {}),
    }));
  return {
    result: {
      total: all.length,
      byStatus: countBy(all, (d) => d.status),
      matching: hits.length,
      byClass: countBy(hits, (d) => d.classId || 'unclassified'),
      detections: rows,
    },
    summary: plural(hits.length, 'detection'),
  };
});

define('review_detections', (input, ctx) => {
  const all = reviewOf(ctx);
  if (detections.getState().readOnly) {
    throw new ToolError('The detections of this project are read-only (a package).');
  }
  const want = new Set(input.ids);
  const list = all.filter((d) => want.has(d.id));
  const missing = input.ids.filter((id) => !all.some((d) => d.id === id));
  const undo = () => {
    undoReview();
  };
  if (input.decision === 'accept') {
    const r = acceptByIds(input.ids);
    if ('error' in r) throw new ToolError(r.error);
    return {
      result: { accepted: r.accepted, skipped: r.skipped },
      summary: `${plural(r.accepted.length, 'draft issue')} from detections`,
      ...(r.accepted.length > 0 ? { undo } : {}),
    };
  }
  if (input.decision === 'reject') {
    const n = rejectAll(list);
    return {
      result: {
        rejected: n,
        notWaiting: list.filter((d) => d.status !== 'draft').map((d) => d.id),
        ...(missing.length ? { notFound: missing } : {}),
      },
      summary: `${plural(n, 'detection')} rejected`,
      ...(n > 0 ? { undo } : {}),
    };
  }
  const now = new Date().toISOString();
  const issues = new Set(ctx.workspace.getState().issues.map((i) => i.id));
  const reopened: string[] = [];
  const kept: { id: string; why: string }[] = [];
  for (const d of list) {
    if (d.status === 'draft') kept.push({ id: d.id, why: 'already waiting' });
    else if (d.status === 'accepted' && d.issueId && issues.has(d.issueId))
      kept.push({ id: d.id, why: `its issue ${d.issueId} exists; delete that first` });
    else {
      dispatch({ type: 'reopen', id: d.id, now, issueGone: d.status === 'accepted' });
      reopened.push(d.id);
    }
  }
  return {
    result: { reopened, kept, ...(missing.length ? { notFound: missing } : {}) },
    summary: `${plural(reopened.length, 'detection')} reopened`,
    ...(reopened.length > 0 ? { undo } : {}),
  };
});

// jobs ---------------------------------------------------------------------------------------

const jobRow = (j: JobRecord) => ({
  id: j.id,
  pipeline: j.pipeline,
  status: j.status,
  progressPct: Math.round(j.progress * 100),
  ...(j.message ? { message: j.message } : {}),
  ...(j.error ? { error: j.error } : {}),
  ...(j.live?.etaSeconds !== undefined ? { etaSeconds: Math.round(j.live.etaSeconds) } : {}),
  createdAt: j.createdAt,
  ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
});

define('list_jobs', (input, ctx) => {
  const p = openProject(ctx);
  const mine = jobs.getState().jobs.filter((j) => !j.quiet && sameFolder(j.project, p.root));
  const hits = input.active ? mine.filter(isActive) : mine;
  return {
    result: {
      total: mine.length,
      running: mine.filter(isActive).length,
      jobs: hits.slice(0, input.limit).map(jobRow),
    },
    summary: plural(hits.length, 'job'),
  };
});

// thermal ------------------------------------------------------------------------------------

/** Photos layers of the project with thermal photos, as last probed. */
function thermalLayers(projectId: string, layers: readonly Layer[]) {
  return layers.filter((l) => l.kind === 'photos' && thermalPhotosOf(projectId, l.id).length > 0);
}

define('thermal_summary', async (input, ctx) => {
  const p = openProject(ctx);
  let layers = thermalLayers(p.id, p.manifest.layers);
  if (input.layer !== undefined) {
    const q = input.layer.toLowerCase();
    const l = p.manifest.layers.find((x) => x.id === input.layer || x.name.toLowerCase() === q);
    if (!l) throw new ToolError(`No layer "${input.layer}".`);
    layers = [l];
  }
  const raw: unknown = await ctx
    .fetchJson(assetUrl(p.id, { path: 'thermal/thermal.json' }))
    .catch(() => null);
  const parsed = ThermalFile.safeParse(raw);
  const file = parsed.success ? parsed.data : null;
  if (layers.length === 0 && !file)
    throw new ToolError('There are no thermal photos in this project.');
  const ids = new Set(layers.map((l) => l.id));
  const on = (layer: string) => ids.size === 0 || ids.has(layer);
  const spots = (file?.hotspots ?? []).filter(
    (h) => !h.leaveOut && h.sightings.some((s) => on(s.layer)),
  );
  const readings = (file?.readings ?? []).filter((r) => on(r.layer));
  const out = layers.map((l) => {
    const mineSpots = spots.filter((h) => h.sightings.some((s) => s.layer === l.id));
    return {
      layer: l.id,
      name: l.name,
      thermalPhotos: thermalPhotosOf(p.id, l.id).length,
      readings: readings.filter((r) => r.layer === l.id).length,
      hotSpots: countBy(mineSpots, (h) => h.state),
    };
  });
  const hottest = [...spots]
    .filter((h) => h.state !== 'dismissed')
    .sort((a, b) => b.deltaC - a.deltaC)
    .slice(0, input.limit)
    .map((h) => ({
      id: h.id,
      state: h.state,
      peakC: round1(h.peakC),
      deltaC: round1(h.deltaC),
      reference: `${h.reference.kind} ${String(round1(h.reference.valueC))} °C`,
      severity: h.reviewedSeverity ?? h.severity,
      photos: h.sightings.map((s) => `${s.layer}/${s.photo}`).slice(0, 5),
      ...(h.issueId ? { issueId: h.issueId } : {}),
    }));
  const peak = readings.reduce<number | null>(
    (m, r) => Math.max(m ?? -Infinity, r.stats.maxC),
    null,
  );
  return {
    result: {
      layers: out,
      ...(peak !== null ? { hottestReadingC: round1(peak) } : {}),
      hotSpots: hottest,
      ...(file ? {} : { note: 'No thermal analysis is saved yet: open a thermal photo to start.' }),
    },
    summary: plural(spots.length, 'hot spot'),
  };
});

// walks --------------------------------------------------------------------------------------

define('list_walks', (_input, ctx) => {
  const p = openProject(ctx);
  const dates = new Map(p.manifest.captures.map((c) => [c.id, c.date]));
  const index = captureIndex(p.manifest);
  const rows = p.manifest.layers.flatMap((l) => {
    if (l.kind !== 'walk') return [];
    const capture = l.capture ?? index.of[l.id];
    return [
      {
        id: l.id,
        name: l.name,
        date: capture ? (dates.get(capture) ?? capture) : null,
        lengthS: Math.round(l.durationS),
        processed: l.path !== undefined,
        placed: l.place !== undefined || l.flight !== undefined,
        ...(l.place ? { placement: l.place.quality } : {}),
      },
    ];
  });
  return {
    result: { total: rows.length, walks: rows },
    summary: plural(rows.length, 'walk'),
  };
});

// facts --------------------------------------------------------------------------------------

/** What the project has beyond its manifest; a key left out is unknown (the tool stays). */
export const agentFacts: NonNullable<AppHooks['agentFacts']> = () => {
  const p = workspace.getState().project;
  if (!p) return {};
  const out: ReturnType<NonNullable<AppHooks['agentFacts']>> = {
    walks: p.manifest.layers.some((l) => l.kind === 'walk'),
  };
  const m = measureStore.getState();
  if (m.projectId === p.id && m.status === 'ready') {
    out.measurements = m.file.measurements.length > 0;
    out.volumes = m.file.measurements.some((x) => x.tool === 'volume' && x.family === 'polygon');
  }
  const d = detections.getState();
  if (d.projectId === p.id && !d.loading && !d.loadError) {
    out.detections = d.review.detections.length > 0;
  }
  const photos = p.manifest.layers.filter((l) => l.kind === 'photos');
  if (photos.length === 0) out.thermal = false;
  else if (thermalLayers(p.id, photos).length > 0) out.thermal = true;
  return out;
};

let registered = false;

/** Register the executors, once (the specs come with `@aio/ai`). */
export function registerDataTools(): void {
  if (registered) return;
  registered = true;
  for (const [name, run] of executors) registerRendererTool(name, run);
}
