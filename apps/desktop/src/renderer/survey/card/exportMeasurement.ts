/**
 * Export one measurement (volumetric parity W2, the card's and the menu's Export): its figures as
 * CSV, its geometry as DXF, and its chart as PNG where its tool draws one.
 *
 * - CSV: the house report's measurements CSV (`measurementsCsv`) for this measurement alone, made
 *   the way the report makes it, so the two agree; saved through `dialog:saveFile`.
 * - DXF: the `survey.export` pipeline with this one measurement id, to the place main asked for.
 * - PNG: the chart the measurement's card draws on screen (`chartPng`), saved through `savePng`.
 *
 * Each answers the path written, or null when the person cancels, and throws a sentence when the
 * file could not be made.
 */
import { measurementsCsv } from '@aio/project/export';
import { CALIBRATION_FILE, SiteCalibration, type SurveyMeasurement } from '@aio/schema';
import { t } from '@aio/ui';
import { assetUrl, workspace } from '@aio/workspace';
import { chartPng, savePng } from '../../charts/exportChart';
import { bridge } from '../../shell';
import { compareStore } from '../compareStore';
import { defaultUnits, exportParams, fileBase } from '../exportHelpers';
import { measureStore } from '../measureStore';
import { waitForJob } from '../sectionStore';
import { measurementHasChart } from './chartRule';

export type MeasurementExportFormat = 'csv' | 'dxf' | 'png';

function measurement(id: string): SurveyMeasurement {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (!m) throw new Error(t('actions.measure.notFound'));
  return m;
}

/** One format a measurement exports as, and why it cannot be picked now (false: it can). */
export interface ExportChoice {
  format: MeasurementExportFormat;
  disabled: string | false;
}

/**
 * The formats a measurement exports as: CSV, DXF, and PNG when its tool draws a chart. In a
 * package (`pkg`) the DXF is greyed: the pipeline job writes it from the project folder. The PNG
 * is greyed until the measurement's chart is on screen, the picture it saves.
 */
export function exportChoices(id: string, opts: { pkg: boolean }): ExportChoice[] {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  const out: ExportChoice[] = [
    { format: 'csv', disabled: false },
    { format: 'dxf', disabled: opts.pkg ? t('actions.reason.package') : false },
  ];
  if (m && measurementHasChart(m))
    out.push({ format: 'png', disabled: chartOf(id) ? false : t('mcard.chartNotShown') });
  return out;
}

function projectOpen() {
  const project = workspace.getState().project;
  if (!project) throw new Error(t('report.noProject'));
  return project;
}

/** The measurement's rows of the measurements CSV, as the house report computes them. */
async function csvOf(m: SurveyMeasurement): Promise<string> {
  const project = projectOpen();
  const ms = measureStore.getState();
  const cs = compareStore.getState();
  const bytes = async (path: string): Promise<Uint8Array | null> => {
    try {
      const r = await fetch(assetUrl(project.id, { path }));
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
  const calibration = await bytes(CALIBRATION_FILE).then((b) => {
    if (!b) return null;
    try {
      const r = SiteCalibration.safeParse(JSON.parse(new TextDecoder().decode(b)));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  });
  // loaded with the export: the report's survey code stays out of the app's first load
  const { buildSurveyData, surveyTemplateList } = await import('../../reportPage/house/surveyData');
  const data = await buildSurveyData(
    {
      manifest: project.manifest,
      settings: ms.settings,
      calibration,
      measurements: [m],
      designs: cs.designs,
      surfaces: cs.surfaces,
      templates: surveyTemplateList(ms.templates.project, ms.settings),
      weighbridge: [],
      // a kit pile weighs by the kit's density, as on its card (`pileMaterial`)
      kit: ms.kitDensity,
    },
    bytes,
    { need: 'measurements-csv' },
  );
  // the reference it has among all the project's measurements, as in the report
  const at = ms.file.measurements.findIndex((x) => x.id === m.id);
  for (const r of data.measurements) r.ref = `M${String(at + 1)}`;
  return measurementsCsv(data);
}

async function saveCsv(m: SurveyMeasurement): Promise<string | null> {
  const csv = await csvOf(m);
  const r = await bridge.call('dialog:saveFile', {
    defaultName: `${fileBase(m.label)}.csv`,
    data: csv,
  });
  if (!r.ok) throw new Error(r.error);
  if (r.value.error) throw new Error(r.value.error);
  return r.value.path;
}

async function saveDxf(m: SurveyMeasurement): Promise<string | null> {
  const project = projectOpen();
  const settings = measureStore.getState().settings;
  const asked = await bridge.call('dialog:savePath', {
    defaultName: `${fileBase(m.label)}.dxf`,
    filters: [{ name: t('chart.dxf'), extensions: ['dxf'] }],
  });
  if (!asked.ok) throw new Error(asked.error);
  if (asked.value.error) throw new Error(asked.value.error);
  const out = asked.value.path;
  if (!out) return null;
  const params = exportParams(
    {
      what: 'measurements',
      format: 'dxf',
      crs: 'site',
      units: defaultUnits(settings),
      detail: 1,
      source: null,
      measurements: [m.id],
      surface: null,
    },
    out,
  );
  const r = await bridge.call('jobs:start', {
    pipeline: 'survey.export',
    project: project.root,
    params,
  });
  if (!r.ok) throw new Error(r.error);
  if (!r.value.ok) throw new Error(r.value.error);
  const done = await waitForJob(r.value.job.id);
  if (!done.ok) throw new Error(done.error);
  return out;
}

/** The chart the card of this measurement draws on screen (the card carries its id), or null. */
export function chartOf(id: string): SVGSVGElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-measure-id]')) {
    if (el.dataset.measureId !== id) continue;
    const svg = el.querySelector<SVGSVGElement>('svg.pc-svg');
    if (svg) return svg;
  }
  return null;
}

async function savePicture(m: SurveyMeasurement): Promise<string | null> {
  if (!measurementHasChart(m)) throw new Error(t('chart.exportFailed'));
  const svg = chartOf(m.id);
  if (!svg) throw new Error(t('mcard.chartNotShown'));
  return savePng(await chartPng(svg), `${fileBase(m.label)}.png`);
}

/** Export one measurement; the path written, or null when the person cancels. */
export async function exportMeasurement(
  id: string,
  format: MeasurementExportFormat,
): Promise<string | null> {
  const m = measurement(id);
  if (format === 'csv') return saveCsv(m);
  if (format === 'dxf') return saveDxf(m);
  return savePicture(m);
}
