/**
 * The pile panel (volumetrics redesign, spec section 3, boards 2 and 3): what opens in the Volumes
 * tab when a pile is picked. "‹ Inventory" and "Pile 2 of 19" on top, the pile's name, material
 * and density, three figures (volume, tonnes, the change since the date before), its footprint,
 * height and base, the status of a figure that is not current, then Overview, Profile and History.
 *
 * Every figure is the volume card's own (`pileSeries` and `volumeRows`, the inventory's rule), so
 * the panel, the cards, the inventory and the CSV never differ; nothing is estimated between dates.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { localeOf, type NumberLocale } from '@aio/geo';
import type {
  ComparisonResult,
  SiteMaterial,
  SurveyMeasurement,
  SurveySettings,
  SurveyUnits,
} from '@aio/schema';
import {
  effectiveUnits,
  inventoryPiles,
  pileMaterial,
  pileSeries,
  volumeRows,
  type TimeRow,
} from '@aio/survey';
import { Tabs, useT } from '@aio/ui';
import { useId, useMemo, type KeyboardEvent, type ReactElement } from 'react';
import { volumeStatusLine, type StatusLine } from '../card/VolumeDetail';
import { useSurveyDates } from '../card/slots';
import { isStale, seriesStale, useCompare } from '../compareStore';
import { select, useMeasure } from '../measureStore';
import { pickInVolumesView } from '../volumesPick';
import { PileHeader } from './PileHeader';
import { PileHistory } from './PileHistory';
import { PileOverview } from './PileOverview';
import { PileProfile } from './PileProfile';
import { pileFigures, usePileView, type PileFigures, type PileTab } from './pileView';
import './pile.css';

/** What every part of the panel reads about the pile, worked out once. */
export interface PileData {
  m: SurveyMeasurement;
  settings: SurveySettings;
  units: SurveyUnits;
  locale: NumberLocale;
  readOnly: boolean;
  material: SiteMaterial | null;
  /** One row per survey date, oldest first (`volumeRows`). */
  rows: TimeRow[];
  figures: PileFigures;
  /** The first comparison's stored figure. */
  stored: ComparisonResult | undefined;
  /** Its one status line (the volume card's). */
  line: StatusLine;
}

/** The pile's figures, as the volume card and the inventory work them out. */
function usePileData(m: SurveyMeasurement | null): PileData | null {
  const settings = useMeasure((s) => s.settings);
  const kit = useMeasure((s) => s.kitDensity);
  const fileReadOnly = useMeasure((s) => s.readOnly);
  const lookOnly = useAnnotateReadOnly();
  const captures = useCompare((s) => s.captures);
  const current = useCompare((s) => s.current);
  const running = useCompare((s) => (m ? s.running[m.id] === true : false));
  return useMemo(() => {
    if (!m) return null;
    const units = effectiveUnits(settings.units, m.units);
    const locale = settings.locale ?? localeOf(units.distance);
    const material = pileMaterial(m, settings.materials, kit);
    const first = m.items[0];
    const over = pileSeries(m, first?.id);
    const storedRow = over.stored;
    const storedStale =
      storedRow !== undefined &&
      (storedRow.status === 'stale' || isStale({ current }, m, storedRow));
    const rows = first
      ? volumeRows(over.series, captures, {
          ...(material?.densityTPerM3 !== undefined
            ? { densityTPerM3: material.densityTPerM3 }
            : {}),
          isStale: (r) => (r === storedRow ? storedStale : seriesStale(m, r)),
        })
      : [];
    const stored = first ? m.results.find((r) => r.item === first.id) : undefined;
    const carriedSeries = (m.series ?? []).some((r) => r.carried !== undefined);
    const line = volumeStatusLine(stored, {
      computing: running,
      live: false,
      stale: storedStale,
      absent: !stored && carriedSeries,
    });
    return {
      m,
      settings,
      units,
      locale,
      readOnly: fileReadOnly || lookOnly,
      material,
      rows,
      figures: pileFigures(rows),
      stored,
      line,
    };
  }, [m, settings, kit, fileReadOnly, lookOnly, captures, current, running]);
}

/** Open a pile from the panel: the view's own pick (the Measure tab does not follow it). */
function openHere(id: string): void {
  pickInVolumesView(id);
  select([id], id);
}

/** Back to the inventory: the pile is no longer selected. */
function back(): void {
  select([], null);
}

export function PilePanel({
  id,
  order,
}: {
  id: string;
  order?: readonly string[];
}): ReactElement | null {
  const t = useT();
  const prefix = `pile-${useId().replace(/[^\w-]/g, '')}`;
  const m = useMeasure((s) => s.file.measurements.find((x) => x.id === id) ?? null);
  const file = useMeasure((s) => s.file);
  // the inventory's order: the view's (its folder) when it says, else every pile
  const ids = useMemo(
    () => order ?? inventoryPiles(file.measurements).map((x) => x.id),
    [order, file],
  );
  const tab = usePileView((s) => s.tab);
  const setTab = usePileView((s) => s.setTab);
  const data = usePileData(m);
  const dates = useSurveyDates();
  if (!data) return null;

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    back();
  };
  const tabs: { id: PileTab; label: string; testId: string }[] = [
    { id: 'overview', label: t('pile.tab.overview'), testId: 'pile-tab-overview' },
    { id: 'profile', label: t('pile.tab.profile'), testId: 'pile-tab-profile' },
    { id: 'history', label: t('pile.tab.history'), testId: 'pile-tab-history' },
  ];
  return (
    <section
      className="pp"
      data-testid="pile-panel"
      data-id={data.m.id}
      aria-label={data.m.label}
      onKeyDown={onKey}
    >
      <PileHeader data={data} order={ids} dates={dates} onOpen={openHere} onBack={back} />
      <Tabs items={tabs} value={tab} onChange={setTab} label={data.m.label} idPrefix={prefix} />
      <div
        className="pp-body"
        role="tabpanel"
        id={`${prefix}-panel-${tab}`}
        aria-labelledby={`${prefix}-tab-${tab}`}
      >
        {tab === 'overview' && <PileOverview data={data} />}
        {tab === 'profile' && <PileProfile key={data.m.id} m={data.m} />}
        {tab === 'history' && <PileHistory data={data} />}
      </div>
    </section>
  );
}
