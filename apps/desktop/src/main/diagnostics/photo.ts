/**
 * `photo.json` of the diagnostics bundle (M10, D5): this computer's processing check and the
 * latest photo processing runs of the open projects, read from their `run.json`.
 *
 * An allow-list, never a copy: every field is picked by name, so a field a later pack adds to a
 * run stays out until it is named here. Never copied: the photo source (folders and files), the
 * job settings, the region (lon/lat), the CRS (it can carry the project origin), the cameras, the
 * outputs (project paths), stage messages and warning texts (free text that can name a file),
 * rejected photo names and an old run's GPU add-on `accelerator` (not copied at all).
 */
import type { HardwareProbe, PhotoRun } from '@aio/schema';

export interface PhotoRunIn {
  project: string;
  run: PhotoRun;
}

export interface PhotoDiagnostics {
  probe: Record<string, unknown> | null;
  runs: Record<string, unknown>[];
}

type Out = Record<string, unknown>;

/** Copies `keys` of `src` that are defined. */
function pick(src: object, keys: readonly string[]): Out {
  const out: Out = {};
  for (const k of keys) {
    const v = (src as Out)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function probeSummary(p: HardwareProbe): Out {
  return {
    platform: p.platform,
    arch: p.arch,
    cpu: pick(p.cpu, ['model', 'cores', 'threads']),
    memoryBytes: p.memoryBytes,
    freeDiskBytes: p.freeDiskBytes,
    gpus: p.gpus.map((g) => pick(g, ['name', 'vendor', 'vramBytes'])),
    cuda: p.cuda,
    processing: p.processing,
  };
}

function rmse(r: unknown): Out | undefined {
  return r && typeof r === 'object' ? pick(r, ['n', 'horizontalM', 'verticalM']) : undefined;
}

export function runSummary(project: string, run: PhotoRun): Out {
  const stages = run.stages.map((s) =>
    pick(s, ['name', 'state', 'seconds', 'memoryPeakBytes', 'device', 'fallbacks']),
  );
  const seconds = run.stages.flatMap((s) => (s.seconds === undefined ? [] : [s.seconds]));
  const peaks = run.stages.flatMap((s) =>
    s.memoryPeakBytes === undefined ? [] : [s.memoryPeakBytes],
  );
  const out: Out = {
    project,
    ...pick(run, ['id', 'createdAt', 'updatedAt', 'status', 'preset']),
    photos: {
      count: run.photos.count,
      ...pick(run.photos, ['registered']),
      rejected: run.photos.rejected?.length ?? 0,
    },
    versions: versionsOf(run.versions),
    stages,
  };
  if (seconds.length > 0) {
    out.totalSeconds = Math.round(seconds.reduce((a, b) => a + b, 0) * 10) / 10;
  }
  if (peaks.length > 0) out.memoryPeakBytes = Math.max(...peaks);
  if (run.accuracy) {
    const a = run.accuracy;
    out.accuracy = {
      ...(a.control ? { control: rmse(a.control) } : {}),
      ...(a.check ? { check: rmse(a.check) } : {}),
      ...pick(a, ['meanReprojPx', 'gsdCm', 'warnings']),
    };
  }
  out.warnings = run.warnings?.length ?? 0;
  if (run.hardware) out.hardware = probeSummary(run.hardware);
  return out;
}

/** Tool versions look like `3.12.0` or `2.10.2+cuda`; anything else (a path, free text) stays out. */
const VERSION = /^[\w.+-]{1,40}$/;
function versionsOf(v: Record<string, string>): Out {
  const out: Out = {};
  for (const [k, x] of Object.entries(v)) if (VERSION.test(k) && VERSION.test(x)) out[k] = x;
  return out;
}

const runTime = (r: PhotoRun): string => r.updatedAt ?? r.createdAt;

/** Newest `max` runs (by updatedAt ?? createdAt, then id), allow-listed. */
export function photoDiagnostics(
  probe: HardwareProbe | null,
  runs: readonly PhotoRunIn[],
  max = 3,
): PhotoDiagnostics {
  const newest = [...runs]
    .sort(
      (a, b) =>
        Date.parse(runTime(b.run)) - Date.parse(runTime(a.run)) || b.run.id.localeCompare(a.run.id),
    )
    .slice(0, max);
  return {
    probe: probe ? probeSummary(probe) : null,
    runs: newest.map((r) => runSummary(r.project, r.run)),
  };
}
