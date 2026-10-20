/**
 * The kit piles' 3D callouts read their volume measurements (volumetric parity W3): for each pile
 * converted to a measurement (`origin: { kind: 'kit-pile', pile }`), its figure on every survey of
 * the volumes, formatted as the card formats its primary value, with the tonnage of its material.
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
import { effectiveUnits, primaryRow } from '@aio/survey';
import type { PileFigure, PileFigures, Volumetric } from '@aio/volumetric';
import type { StoreApi } from 'zustand/vanilla';
import { rowText, templateItems } from '../survey/card/cardModel';

/**
 * The measurement's result on one survey date: its stored result for that date (it wins its own
 * date), else the per-date series row, else a stored result that names no date.
 */
function resultOn(m: SurveyMeasurement, capture: string): ComparisonResult | undefined {
  const item = m.items[0]?.id;
  const first = m.results.find((r) => r.item === item) ?? m.results[0];
  if (first?.toCapture === capture) return first;
  const row = m.series?.find((r) => r.toCapture === capture && (!item || r.item === item));
  if (row) return row;
  return first && first.toCapture === undefined ? first : undefined;
}

/** Every kit pile's figure per survey epoch, from its volume measurement. */
export function pileFigures(
  volumes: Pick<VolumesFile, 'captures'> | null,
  measurements: readonly SurveyMeasurement[],
  settings: SurveySettings,
  templates: readonly SurveyTemplate[],
): PileFigures {
  if (!volumes) return {};
  const out: Record<string, Record<string, PileFigure>> = {};
  for (const m of measurements) {
    if (m.origin?.kind !== 'kit-pile') continue;
    const per: Record<string, PileFigure> = {};
    const items = templateItems(m, templates);
    const units = effectiveUnits(settings.units, m.units);
    const locale = settings.locale ?? localeOf(units.distance);
    const density = m.material
      ? settings.materials.find((x) => x.id === m.material)?.densityTPerM3
      : undefined;
    for (const c of volumes.captures) {
      const r = resultOn(m, c.captureId);
      if (!r) continue;
      const row = primaryRow({ ...m, results: [r] }, {}, items);
      if (row?.value == null) continue;
      const net = r.netM3;
      per[c.epoch] = {
        value: rowText(row, m, settings),
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
  /** Hear a change to the measurements, the settings or the templates. */
  subscribe(listener: () => void): () => void;
}

/** Keep the volumetric store's pile figures in step with the measurements. */
export function connectPileFigures(store: StoreApi<Volumetric>, deps: PileFigureDeps): () => void {
  let last = '';
  const sync = () => {
    const s = store.getState();
    const file = s.status === 'ready' ? s.file : null;
    const figures = pileFigures(file, deps.measurements(), deps.settings(), deps.templates());
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
  return () => {
    offStore();
    offDeps();
  };
}
