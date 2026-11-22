// The volumetric report's one export flow (layout plan 2026-11-20, section 5): write pending text,
// take the pictures when there are none or they are stale, then write the file. The editor's
// Export PDF and Export HTML and the Exports menu's two volumetric actions all come through
// `exportVolumetric`, so no route ends with "the report has no pictures yet", except a package,
// which says so at once: it cannot save pictures, so it exports with the ones it carries and
// says when they may not match its data. The progress card
// (PictureProgress.tsx) reads `exportRun` (editorView.ts) for the phase and `pictureRun` for the
// count.
import type { VolumetricModel } from '@aio/project/export';
import type { SurveyMeasurement } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { actionAllowed, actionLabel } from '../../exports/exportModel';
import { exportIssues, toasts } from '../../exports/exports';
import { dateText } from '../../reportPage/volumetric/chrome';
import { bridge, shell } from '../../shell';
import { picturesStopped, type CaptureRequest } from './captureViews';
import {
  exportRun,
  picturesFingerprint,
  picturesTaken,
  type ExportRunPhase,
  type ExportRunState,
  type VolumetricFormat,
} from './editorView';
import { takeReportPictures } from './liveStage';
import { showPictureProgress } from './PictureProgress';

export { exportRun, type ExportRunPhase, type ExportRunState, type VolumetricFormat };

export interface ExportSource {
  /** The report's model and the project's measurements, when the caller has them (the editor). */
  model?: VolumetricModel;
  measurements?: readonly SurveyMeasurement[];
  /** Writes the editor's pending text; awaited before anything else. */
  flush?: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const running = () => {
  const p = exportRun.getState().phase;
  return p === 'pictures' || p === 'writing';
};
const runId = () => `volumetric-run-${globalThis.crypto.randomUUID().slice(0, 8)}`;

/**
 * What a capture of the report's pictures is asked, and whether the saved pictures already show
 * it: the piles in the report's order (largest first) with their names, every date with figures,
 * and the compared pair.
 */
export function captureRequest(
  projectId: string,
  model: VolumetricModel,
  measurements: readonly SurveyMeasurement[],
): { req: CaptureRequest; current: boolean } {
  const dates = model.dates.map((d) => d.id);
  const pair =
    model.latest && model.compared ? { from: model.compared.id, to: model.latest.id } : null;
  const fingerprint = picturesFingerprint(measurements, dates, pair);
  const byId = new Map(measurements.map((m) => [m.id, m]));
  const piles = model.piles.flatMap((p) => {
    const m = byId.get(p.id);
    return m
      ? [
          {
            id: m.id,
            points: m.points,
            label: p.label,
            ...(m.outlines ? { outlines: m.outlines } : {}),
          },
        ]
      : [];
  });
  return {
    req: {
      projectId,
      dates,
      pair,
      piles,
      dateLabels: Object.fromEntries(model.dates.map((d) => [d.id, dateText(d.date)])),
      fingerprint,
    },
    current: model.frame !== null && model.frame.fingerprint === fingerprint,
  };
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** The model and the measurements as the export will print them, read outside the editor. */
async function readSource(
  projectId: string,
): Promise<Read<{ model: VolumetricModel; measurements: readonly SurveyMeasurement[] }>> {
  const [text, read] = await Promise.all([
    bridge.call('report:readText', { projectId, report: 'volumetric' }),
    bridge.call('survey:readMeasurements', { projectId }),
  ]);
  if (!read.ok) return { ok: false, error: read.error };
  if (!read.value.ok) return { ok: false, error: read.value.error };
  // the compared date the editor saved; an unreadable text file falls back to the default pair
  const compareWith = text.ok && text.value.ok ? (text.value.file?.compareWith ?? null) : null;
  const m = await bridge.call('report:volumetricModel', {
    projectId,
    ...(compareWith !== null ? { compareWith } : {}),
  });
  if (!m.ok) return { ok: false, error: m.error };
  if (!m.value.ok) return { ok: false, error: m.value.error };
  return {
    ok: true,
    value: { model: m.value.model as VolumetricModel, measurements: read.value.file.measurements },
  };
}

async function sourceOf(
  projectId: string,
  src: ExportSource,
  title: string,
): Promise<Read<{ model: VolumetricModel; measurements: readonly SurveyMeasurement[] }>> {
  if (src.model && src.measurements)
    return { ok: true, value: { model: src.model, measurements: src.measurements } };
  // working out the figures takes a while on a large site: say so until the pictures start
  const id = runId();
  const toast = toasts.getState();
  toast.start(id, title);
  toast.progress(id, t('vreport.preview.loading'), 0, 0);
  try {
    return await readSource(projectId);
  } catch (e) {
    return { ok: false, error: message(e) };
  } finally {
    toast.dismiss(id);
  }
}

function end(phase: ExportRunPhase, error: string | null = null): ExportRunPhase {
  exportRun.setState({ phase, format: null, error });
  return phase;
}

/** A run that ended without its file: say why where every screen shows it. */
function say(title: string, text: string): void {
  const id = runId();
  const toast = toasts.getState();
  toast.start(id, title);
  toast.finish(id, 'error', text);
}

async function run(format: VolumetricFormat | null, src: ExportSource): Promise<ExportRunPhase> {
  const project = workspace.getState().project;
  if (!project || running()) return 'idle';
  const pkg = shell.getState().pkg;
  if (format !== null && !actionAllowed(format, pkg)) return 'idle';
  const title = format === null ? t('vreport.pictures.progressTitle') : actionLabel(format);
  // from here on the run is going: a second click waits for this one
  exportRun.setState({ phase: 'pictures', format, error: null });
  let hide: (() => void) | null = null;
  try {
    await src.flush?.();
    const source = await sourceOf(project.id, src, title);
    if (!source.ok) {
      say(title, source.error);
      return end('failed', source.error);
    }
    const plan = captureRequest(project.id, source.value.model, source.value.measurements);
    // a package cannot save new pictures (`report:saveViews` refuses it): without any it says so
    // at once, before a picture is taken; else it exports with the ones it carries
    if (pkg !== null && source.value.model.frame === null) {
      const none = t('vreport.pictures.nonePackage');
      say(title, none);
      return end('failed', none);
    }
    const carried = pkg !== null && !plan.current;
    if (format === null || (!plan.current && pkg === null)) {
      hide = showPictureProgress();
      const r = await takeReportPictures(plan.req);
      if (!r.ok) {
        const stopped = r.error === picturesStopped();
        say(title, stopped ? r.error : t('vreport.pictures.failed', { error: r.error }));
        return end(stopped ? 'stopped' : 'failed', stopped ? null : r.error);
      }
      picturesTaken(project.id);
    }
    if (format === null) return end('done');
    exportRun.setState({ phase: 'writing' });
    const outcome = await exportIssues(format);
    if (outcome === 'done' && carried) {
      // the file went out with pictures that may be older than its figures: say so, once
      const id = runId();
      const toast = toasts.getState();
      toast.start(id, title);
      toast.finish(id, 'done', t('vreport.pictures.stalePackage'));
    }
    return end(outcome === 'done' ? 'done' : outcome === 'cancelled' ? 'idle' : 'failed');
  } catch (e) {
    say(title, message(e));
    return end('failed', message(e));
  } finally {
    hide?.();
  }
}

/**
 * Export the open project's volumetric report: pending text, pictures when they are missing or
 * stale (under the progress card, with Stop), then the file. A stopped or failed capture exports
 * nothing and says why. Resolves with how the run ended.
 */
export function exportVolumetric(
  format: VolumetricFormat,
  src: ExportSource = {},
): Promise<ExportRunPhase> {
  return run(format, src);
}

/** The preview's "Take them now": the pictures alone, whether or not the saved ones are stale. */
export function takePicturesNow(src: ExportSource = {}): Promise<ExportRunPhase> {
  return run(null, src);
}
