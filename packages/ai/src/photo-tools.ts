/**
 * Executors of the photo tools (M10 integration follow-up): `process_photos` starts a run the way
 * Create maps from photos does, through `AppHooks.processPhotos`; `accuracy_summary` reads a run
 * and its accuracy report through `AppHooks.photoRuns`.
 */
import type {
  AccuracyReport,
  GcpFile,
  PhotoPreset,
  PhotoProduct,
  PhotoRunSummary,
} from '@aio/schema';
import { photoToolInputs, type PhotoToolName } from './photo-tool-specs';
import {
  plural,
  project,
  registerRendererTool,
  ToolError,
  type RendererToolContext,
  type ToolRunResult,
} from './tool-kit';

/** The dialog's products for a quality (`defaultProducts` in the desktop's estimate.ts). */
export function defaultPhotoProducts(preset: PhotoPreset): PhotoProduct[] {
  return preset === 'fast' ? ['ortho', 'dsm'] : ['ortho', 'dsm', 'dtm', 'cloud', 'mesh'];
}

function define<N extends PhotoToolName>(
  name: N,
  run: (
    input: ReturnType<(typeof photoToolInputs)[N]['parse']>,
    ctx: RendererToolContext,
  ) => Promise<ToolRunResult>,
): void {
  registerRendererTool(name, (input, ctx) =>
    run(
      photoToolInputs[name].parse(input) as ReturnType<(typeof photoToolInputs)[N]['parse']>,
      ctx,
    ),
  );
}

const mm = (n: number) => Math.round(n * 1000) / 1000;
const named = (l: { id: string; name: string }) => `${l.id} (${l.name})`;

define('process_photos', async (input, ctx) => {
  const layers = project(ctx).manifest.layers.filter((l) => l.kind === 'photos');
  if (!layers.length)
    throw new ToolError(
      'This project has no photos layer. Import photos first, or use Create maps from photos in the Builder to read a folder.',
    );
  let layer = layers.length === 1 ? layers[0] : undefined;
  if (input.layer) {
    const want = input.layer.trim().toLowerCase();
    layer =
      layers.find((l) => l.id.toLowerCase() === want) ??
      layers.find((l) => l.name.toLowerCase() === want);
    if (!layer)
      throw new ToolError(
        `No photos layer "${input.layer}". The photos layers: ${layers.map(named).join(', ')}.`,
      );
  }
  if (!layer)
    throw new ToolError(
      `This project has ${String(layers.length)} photos layers. Say which one: ${layers.map(named).join(', ')}.`,
    );
  const start = ctx.app?.processPhotos;
  if (!start) throw new ToolError('Processing photos is only in the desktop app.');
  const products = input.products ?? defaultPhotoProducts(input.preset);
  const s = await start({
    layerId: layer.id,
    preset: input.preset,
    gnss: input.gnss,
    products,
    groundControlFirst: input.groundControlFirst,
  });
  return {
    result: {
      run: s.run,
      layer: layer.id,
      preset: input.preset,
      gnss: input.gnss,
      products,
      groundControlFirst: input.groundControlFirst,
      estimate: s.estimate,
      surveyDate: s.surveyDate,
      note: input.groundControlFirst
        ? 'The photos are being aligned. The maps wait until a person marks the ground control points in the run (Create maps from photos). Progress shows in Jobs. Use accuracy_summary afterwards.'
        : 'The photos are being aligned; the maps start by themselves when that finishes and come in as layers. Progress shows in Jobs and under Create maps from photos. Use accuracy_summary afterwards.',
    },
    summary: `Run ${s.run} started`,
  };
});

const rmse = (r: { n: number; horizontalM: number; verticalM: number } | undefined) =>
  r ? { n: r.n, horizontalM: mm(r.horizontalM), verticalM: mm(r.verticalM) } : null;

function gcpTable(gcp: GcpFile | null, report: AccuracyReport | null) {
  if (!gcp) return null;
  const active = gcp.points.filter((p) => !p.disabled);
  const rows = (report?.points ?? []).map((p) => ({
    id: p.id,
    role: p.role,
    dxM: mm(p.dxM),
    dyM: mm(p.dyM),
    dzM: mm(p.dzM),
    horizontalM: mm(Math.hypot(p.dxM, p.dyM)),
    marks: p.marks,
    used: p.usedInAdjustment ?? null,
  }));
  rows.sort((a, b) => b.horizontalM - a.horizontalM);
  return {
    control: gcp.points.filter((p) => p.role === 'control').length,
    check: gcp.points.filter((p) => p.role === 'check').length,
    disabled: gcp.points.length - active.length,
    marked: active.filter((p) => p.marks.length > 0).length,
    points: rows.slice(0, 30),
  };
}

function pickRun(runs: readonly PhotoRunSummary[], asked: string | undefined): PhotoRunSummary {
  const newest = runs[0];
  if (!newest)
    throw new ToolError('No photo runs in this project yet. Use process_photos to start one.');
  if (asked) {
    const hit = runs.find((r) => r.id === asked);
    if (!hit)
      throw new ToolError(
        `No photo run "${asked}". The runs: ${runs
          .slice(0, 20)
          .map((r) => r.id)
          .join(', ')}.`,
      );
    return hit;
  }
  return runs.find((r) => r.accuracy) ?? newest;
}

define('accuracy_summary', async (input, ctx) => {
  project(ctx);
  const runs = ctx.app?.photoRuns;
  if (!runs) throw new ToolError('Photo runs are only read in the desktop app.');
  const all = await runs.list();
  const chosen = pickRun(all, input.run);
  const { run, accuracy, gcp } = await runs.read(chosen.id);
  const otherRuns = all
    .filter((r) => r.id !== chosen.id)
    .slice(0, 5)
    .map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt }));
  const base = {
    run: run.id,
    status: run.status,
    preset: run.preset,
    createdAt: run.createdAt,
    photos: { count: run.photos.count, registered: run.photos.registered ?? null },
  };
  if (!accuracy)
    return {
      result: {
        ...base,
        accuracy: null,
        gcp: gcpTable(gcp, null),
        warnings: [],
        otherRuns,
        note: `Run ${run.id} is ${run.status}: it has no accuracy report yet.`,
      },
      summary: `${run.id}: ${run.status}, no accuracy report yet`,
    };
  const check = rmse(accuracy.rmse.check);
  const control = rmse(accuracy.rmse.control);
  const basis = control && control.n > 0 ? 'ground control' : 'GNSS only';
  return {
    result: {
      ...base,
      accuracy: {
        basis,
        check,
        control,
        meanReprojPx: Math.round(accuracy.meanReprojPx * 100) / 100,
        gsdCm: accuracy.gsdCm ?? null,
        cameraResiduals: accuracy.cameraResiduals ?? null,
      },
      gcp: gcpTable(gcp, accuracy),
      warnings: accuracy.warnings.slice(0, 10).map((w) => ({ code: w.code, message: w.message })),
      otherRuns,
    },
    summary:
      check && check.n > 0
        ? `Check RMSE ${check.horizontalM.toFixed(3)} m horizontal, ${check.verticalM.toFixed(3)} m vertical (${plural(check.n, 'point')})`
        : basis,
  };
});
