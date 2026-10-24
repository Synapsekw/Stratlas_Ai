/**
 * The kit piles' 3D callouts read their volume measurements (volumetric parity W3): for each pile
 * converted to a measurement (`origin: { kind: 'kit-pile', pile }`), its figure on every survey of
 * the volumes, formatted as the card formats its primary value, with the tonnage of its material
 * at its density on that date (`densityOn`: a density edited from a later date leaves the earlier
 * dates' tonnes alone).
 * The kit's own stored figures are never shown from the kit layer; a carried figure reaches the
 * callout only as the measurement's carried result, and a recompute or an edit shows at once.
 */
import { formatQuantity, localeOf } from '@aio/geo';
import type {
  ComparisonResult,
  SurveyMeasurement,
  SurveySettings,
  SurveyTemplate,
  VolumesFile,
} from '@aio/schema';
import {
  densityOn,
  effectiveUnits,
  kitDensity,
  pileMaterial,
  pileSeries,
  primaryRow,
  seriesDate,
} from '@aio/survey';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { setKitDisplay, type PileFigure, type PileFigures, type Volumetric } from '@aio/volumetric';
import type { StoreApi } from 'zustand/vanilla';
import { rowText, templateItems } from '../survey/card/cardModel';
import { captureDateOf, type DatedCapture } from '../survey/volumes/surveyDates';

/** Whether a figure is stale: `stored` for the measurement's stored result (the card's rule). */
export type PileStale = (m: SurveyMeasurement, r: ComparisonResult, stored: boolean) => boolean;

/**
 * The measurement's figure per survey: the card's per-date rule (`pileSeries`: its stored result
 * stands for its own date), and a stored result that names no date on the latest survey only,
 * when no dated row is there.
 */
function resultsOn(
  m: SurveyMeasurement,
  captures: VolumesFile['captures'],
): Map<string, { r: ComparisonResult; stored: boolean }> {
  const { series, stored } = pileSeries(m);
  const out = new Map(series.map((r) => [r.toCapture ?? '', { r, stored: r === stored }]));
  const item = m.items[0]?.id;
  const undated = m.results.find((r) => r.item === item && seriesDate(r) === '');
  const latest = [...captures].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const last = latest[latest.length - 1];
  if (undated && last && !out.has(last.captureId))
    out.set(last.captureId, { r: undated, stored: true });
  return out;
}

/**
 * Every kit pile's figure per survey epoch, from its volume measurement. A stale figure (marked,
 * or by `opts.isStale`, the card's predicate) reads "…, stale", as the card marks it.
 */
export function pileFigures(
  volumes:
    (Pick<VolumesFile, 'captures'> & Partial<Pick<VolumesFile, 'densityTPerM3' | 'piles'>>) | null,
  measurements: readonly SurveyMeasurement[],
  settings: SurveySettings,
  templates: readonly SurveyTemplate[],
  opts: {
    isStale?: PileStale;
    /** The project's surveys (the manifest's captures): a density history dates by them. */
    captures?: readonly DatedCapture[];
  } = {},
): PileFigures {
  if (!volumes) return {};
  // a kit pile weighs by the kit's density unless the person picked a site material
  const kit =
    volumes.densityTPerM3 !== undefined
      ? kitDensity({ densityTPerM3: volumes.densityTPerM3, piles: volumes.piles ?? [] })
      : null;
  const out: Record<string, Record<string, PileFigure>> = {};
  // the project's survey dates (a density history names any survey, not only the kit's); the
  // kit's own dates stand in for a capture the manifest does not list
  const project = captureDateOf(opts.captures ?? []);
  const kitDates = captureDateOf(volumes.captures.map((c) => ({ id: c.captureId, date: c.date })));
  const dateOf = (capture: string): number | null => project(capture) ?? kitDates(capture);
  for (const m of measurements) {
    if (m.origin?.kind !== 'kit-pile') continue;
    const per: Record<string, PileFigure> = {};
    const items = templateItems(m, templates);
    const units = effectiveUnits(settings.units, m.units);
    const locale = settings.locale ?? localeOf(units.distance);
    const material = pileMaterial(m, settings.materials, kit);
    const on = resultsOn(m, volumes.captures);
    for (const c of volumes.captures) {
      const hit = on.get(c.captureId);
      if (!hit) continue;
      // the material's density on this date (a dated density keeps earlier dates' tonnes)
      const density = material
        ? (densityOn(material, c.captureId, dateOf) ?? undefined)
        : undefined;
      const { r, stored } = hit;
      const row = primaryRow({ ...m, results: [r] }, {}, items);
      if (row?.value == null) continue;
      const net = r.netM3;
      const value = rowText(row, m, settings);
      const stale = r.status === 'stale' || (opts.isStale?.(m, r, stored) ?? false);
      per[c.epoch] = {
        value: stale ? t('vol.callout.stale', { value }) : value,
        tonnes:
          density !== undefined
            ? // tonnes to kilograms, the SI mass the formatter takes
              formatQuantity(net * density * 1000, 'mass', units, settings.precision, locale)
            : null,
      };
    }
    out[m.origin.pile] = per;
  }
  return out;
}

export interface PileFigureDeps {
  measurements(): readonly SurveyMeasurement[];
  settings(): SurveySettings;
  templates(): readonly SurveyTemplate[];
  /** Whether a figure is stale (the card's predicate); without it only a marked one is. */
  isStale?: PileStale;
  /** The project's surveys; the open project's manifest captures by default. */
  captures?(): readonly DatedCapture[];
  /** Hear a change to the measurements, the settings, the templates or what is stale. */
  subscribe(listener: () => void): () => void;
}

/** Keep the volumetric store's pile figures in step with the measurements. */
export function connectPileFigures(store: StoreApi<Volumetric>, deps: PileFigureDeps): () => void {
  const own = deps.captures?.bind(deps);
  const captures = own ?? (() => workspace.getState().project?.manifest.captures ?? []);
  let last = '';
  let shownSettings: SurveySettings | null = null;
  const sync = () => {
    // the kit's 3D layer writes heights and the change colours in the site's units and heat map
    const site = deps.settings();
    if (site !== shownSettings) {
      shownSettings = site;
      setKitDisplay({
        units: site.units,
        precision: site.precision,
        ...(site.locale !== undefined ? { locale: site.locale } : {}),
        heatmap: {
          stops: site.heatmap.stops,
          stepped: site.heatmap.stepped,
          ...(site.heatmap.inverted !== undefined ? { inverted: site.heatmap.inverted } : {}),
        },
      });
    }
    const s = store.getState();
    const file = s.status === 'ready' ? s.file : null;
    const figures = pileFigures(file, deps.measurements(), deps.settings(), deps.templates(), {
      ...(deps.isStale ? { isStale: deps.isStale } : {}),
      captures: captures(),
    });
    const text = JSON.stringify(figures);
    if (text === last && text === JSON.stringify(s.pileFigures)) return;
    last = text;
    s.setPileFigures(figures);
  };
  sync();
  const offStore = store.subscribe((s, p) => {
    if (s.file !== p.file || s.status !== p.status) sync();
  });
  const offDeps = deps.subscribe(sync);
  // a survey's date, or the project, changed: the densities date again
  const offProject = own
    ? () => undefined
    : workspace.subscribe((s, p) => {
        if (s.project?.manifest.captures !== p.project?.manifest.captures) sync();
      });
  return () => {
    offStore();
    offDeps();
    offProject();
  };
}
