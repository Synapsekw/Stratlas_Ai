/**
 * What each tool puts in the shared card's slots (volumetric parity W2, the chart slot and the
 * chips-by-type tables of the spec):
 *
 * | Tools                                     | Chips                         | Chart                       | Detail                     |
 * | ----------------------------------------- | ----------------------------- | --------------------------- | -------------------------- |
 * | distance, grade                           | surveys, designs and the base | `ProfileChart`              | terrain length per surface |
 * | vertex-table                              | the same                      | `ProfileChart`              | vertex table               |
 * | berm-check                                | the same                      | profile with berm marks     | side table                 |
 * | section                                   | the same                      | `ProfileChart`              | "Open in section view"     |
 * | elevation, elevation-difference, annot.   | one design or date ("vs")     | `TimeChart` elevation       | none                       |
 * | elevation-history                         | the same                      | `TimeChart` elevation       | none                       |
 * | volume                                    | from/to and base (inside)     | volume over time (inside)   | `VolumeDetail`             |
 * | area                                      | terrain area per date         | none                        | "+ Compare", calculators   |
 * | azimuth, antenna-tilt, clearance, freehand| none                          | none                        | none                       |
 *
 * A point's "vs" surface puts its difference in the card's secondary line (`usePointVs`) and, for
 * a design, a dashed level across the elevation chart. An elevation difference charts the ground
 * under the point on every date with the point's own level as a dotted line: the gap between the
 * two is the difference. A line's "base" is the line as drawn (its own vertex heights). The
 * cross-section's pins stay in the section view (Task 12); its card offers "Open in section view".
 *
 * Heights come from each date's or design's prepared surface (`pointHistory.ts`). The slots are
 * the detail card's: the live card shows no chips or chart, and the report draws its own charts.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { formatQuantity, localeOf } from '@aio/geo';
import {
  DEFAULT_ANGLES,
  type HeightTiles,
  type MeasurementTool,
  type SitePoint,
  type SurveyMeasurement,
} from '@aio/schema';
import {
  bermCheck,
  defaultItem,
  effectiveUnits,
  formatBearingAs,
  horizontalDistance,
  polygonAreas,
  profileLength,
  sampleProfile,
  slopeDistance,
  vertexTable,
  type BermCheck,
  type ChartSeries,
  type Pin,
} from '@aio/survey';
import { Button, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { autoExaggeration } from '../../charts/exaggeration';
import { ProfileChart } from '../../charts/ProfileChart';
import { ShadeVs } from '../../charts/ShadeVs';
import { SurfaceChips, type ChipOption } from '../../charts/SurfaceChips';
import { TimeChart, type TimeReference } from '../../charts/TimeChart';
import { Calculators } from '../Calculators';
import { Comparisons } from '../Comparison';
import { drawnPoints } from '../measureDates';
import { measureStore, updateMeasurement, useMeasure } from '../measureStore';
import { useFocusCapture } from '../qaHelpers';
import { surfaceOfCapture, useQa } from '../qaStore';
import { openSection, setWindow } from '../sectionStore';
import { measurementHasChart } from './chartRule';
import type { CardSlots, CardVariant } from './MeasureCard';
import {
  heightAt,
  pointHistory,
  surfaceTiles,
  withSurface,
  type DatedSurface,
  type PointHistoryRow,
} from './pointHistory';
import '../../charts/charts.css';

export type ChipsKind = 'surfaces' | 'vs' | 'area-dates' | null;
/** `volume` is drawn inside `VolumeDetail`, beside its table. */
export type ChartKind = 'profile' | 'elevation' | 'volume' | null;
export type DetailKind =
  'terrain-lengths' | 'vertex-table' | 'berm' | 'section' | 'volume' | 'area' | null;

export interface SlotKinds {
  chips: ChipsKind;
  chart: ChartKind;
  detail: DetailKind;
}

const LINE_DETAIL: Partial<Record<MeasurementTool, DetailKind>> = {
  distance: 'terrain-lengths',
  grade: 'terrain-lengths',
  'vertex-table': 'vertex-table',
  'berm-check': 'berm',
  section: 'section',
};
const POINT_TOOLS: ReadonlySet<MeasurementTool> = new Set([
  'elevation',
  'elevation-difference',
  'annotation',
  'elevation-history',
]);

/** The spec's tables: what each tool's card holds. Agrees with `measurementHasChart`. */
export function slotKinds(tool: MeasurementTool): SlotKinds {
  const line = LINE_DETAIL[tool];
  if (line) return { chips: 'surfaces', chart: 'profile', detail: line };
  if (POINT_TOOLS.has(tool)) return { chips: 'vs', chart: 'elevation', detail: null };
  if (tool === 'volume') return { chips: null, chart: 'volume', detail: 'volume' };
  if (tool === 'area') return { chips: 'area-dates', chart: null, detail: 'area' };
  return { chips: null, chart: null, detail: null };
}

/** The tool's chips, chart and detail for the card (`CardSlots`); none outside the detail card. */
export function slotsFor(m: SurveyMeasurement, variant: CardVariant): CardSlots {
  if (variant !== 'detail') return {};
  const k = slotKinds(m.tool);
  const slots: CardSlots = {};
  if (k.chips === 'surfaces') slots.chips = <LineChips m={m} />;
  else if (k.chips === 'vs') slots.chips = <PointChips m={m} />;
  else if (k.chips === 'area-dates') slots.chips = <AreaDates m={m} />;
  if (k.chart === 'profile') slots.chart = <LineProfile m={m} />;
  else if (k.chart === 'elevation') slots.chart = <ElevationOverTime m={m} />;
  switch (k.detail) {
    case 'terrain-lengths':
      slots.detail = <TerrainLengths m={m} />;
      break;
    case 'vertex-table':
      slots.detail = <VertexTable m={m} />;
      break;
    case 'berm':
      slots.detail = <BermTable m={m} />;
      break;
    case 'section':
      slots.detail = <OpenSection m={m} />;
      break;
    case 'volume':
      slots.detail = (
        <>
          <Comparisons m={m} />
          <Calculators m={m} />
        </>
      );
      break;
    case 'area':
      slots.detail = (
        <>
          {/* an area compared to a date or a design keeps its comparisons; else "+ Compare" */}
          {m.items.length > 0 ? <Comparisons m={m} /> : <CompareArea m={m} />}
          <Calculators m={m} />
        </>
      );
      break;
    default:
      break;
  }
  return slots;
}

/** Whether the slot table and the one chart rule agree (`chartRule.ts`). */
export const chartAgrees = (tool: MeasurementTool): boolean =>
  (slotKinds(tool).chart !== null) === measurementHasChart({ tool });

// ---------------------------------------------------------------- what each card shows

interface CardView {
  /** A line's surfaces on the chart (chips; absent: the default), and those switched off. */
  shown?: string[];
  off: string[];
  shadeVs: string | null;
  /** A point's "vs" surface. */
  vs: string | null;
}
const EMPTY_VIEW: CardView = { off: [], shadeVs: null, vs: null };

/** Each card's chosen surfaces, shared by its chips, chart, detail and secondary line. */
export const cardViews = createStore<Record<string, CardView>>()(() => ({}));

let pruning = false;
/** Forget the choices of a measurement once it is deleted. */
function prune(): void {
  if (pruning) return;
  pruning = true;
  measureStore.subscribe((s, prev) => {
    if (s.file === prev.file) return;
    const ids = new Set(s.file.measurements.map((m) => m.id));
    const views = cardViews.getState();
    if (Object.keys(views).some((id) => !ids.has(id)))
      cardViews.setState(
        Object.fromEntries(Object.entries(views).filter(([id]) => ids.has(id))),
        true,
      );
  });
}

function patchView(id: string, patch: Partial<CardView>): void {
  prune();
  cardViews.setState((s) => ({ ...s, [id]: { ...(s[id] ?? EMPTY_VIEW), ...patch } }));
}

/** Choose the surface a point is compared with (a design `design:<id>` or a date); null: none. */
export function chooseVs(id: string, key: string | null): void {
  patchView(id, { vs: key });
}

// ---------------------------------------------------------------- loading

/** What a load gives: nothing to load, still loading, failed, or its value. */
export type Loaded<T> =
  { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

/** Loads in flight or done, by key, so a card's chips, chart and detail read a surface once. */
const loads = new Map<string, Promise<unknown>>();
const MAX_LOADS = 64;
function loadOnce<T>(key: string, load: () => Promise<T>): Promise<T> {
  const had = loads.get(key) as Promise<T> | undefined;
  if (had) return had;
  const p = load();
  p.catch(() => loads.delete(key));
  loads.set(key, p);
  while (loads.size > MAX_LOADS) {
    const first = loads.keys().next();
    if (first.done) break;
    loads.delete(first.value);
  }
  return p;
}

/**
 * What `load` gives for the inputs `key` names (null: nothing to load). A value loaded for other
 * inputs is never shown, and a failure is an error, never "loading" for ever.
 */
export function useLoaded<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [got, setGot] = useState<{ key: string; ok: boolean; value?: T } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    loadOnce(key, load).then(
      (value) => {
        if (live) setGot({ key, ok: true, value });
      },
      () => {
        if (live) setGot({ key, ok: false });
      },
    );
    return () => {
      live = false;
    };
    // `key` names every input `load` reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (key === null) return { status: 'idle' };
  if (got?.key !== key) return { status: 'loading' };
  return got.ok ? { status: 'ready', value: got.value as T } : { status: 'error' };
}

// ---------------------------------------------------------------- shared reads

/** A surface a card can read: a survey date's prepared surface, a design's, or the base. */
export interface SurfaceOption {
  key: string;
  label: string;
  group: 'survey' | 'design' | 'base';
  capture?: string;
  date?: string;
  tiles?: HeightTiles;
}

/** Every survey date with a prepared surface, oldest first. */
function useDatedSurfaces(): DatedSurface[] {
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  const surfaces = useQa((s) => s.surfaces);
  return useMemo(() => {
    const out: DatedSurface[] = [];
    for (const c of captures ?? []) {
      const tiles = surfaceOfCapture(surfaces, c.id);
      if (tiles) out.push({ capture: c.id, label: c.label, date: c.date, tiles });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }, [captures, surfaces]);
}

/** The prepared design surfaces, by name. */
function useDesignSurfaces(): SurfaceOption[] {
  const surfaces = useQa((s) => s.surfaces);
  return useMemo(
    () =>
      surfaces
        .filter((s) => s.source.kind === 'design')
        .map((s) => ({ key: `design:${s.id}`, label: s.name, group: 'design' as const, tiles: s }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [surfaces],
  );
}

const fromDated = (d: DatedSurface): SurfaceOption => ({
  key: d.capture,
  label: d.label,
  group: 'survey',
  capture: d.capture,
  date: d.date,
  tiles: d.tiles,
});

/** Where the measurement is drawn (its date's line-up added), as the panel reads it. */
function useDrawn(m: SurveyMeasurement): SitePoint[] {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  return useMemo(() => drawnPoints(m, manifest), [m, manifest]);
}

function useFormat(m: SurveyMeasurement) {
  const settings = useMeasure((s) => s.settings);
  const units = effectiveUnits(settings.units, m.units);
  const locale = settings.locale ?? localeOf(units.distance);
  return { settings, units, locale, angles: settings.angles ?? DEFAULT_ANGLES };
}

/** A key naming surfaces (a re-prepared surface changes its fingerprint). */
const surfacesKey = (opts: readonly { key: string; tiles?: HeightTiles | undefined }[]) =>
  opts.map((o) => `${o.key}:${o.tiles?.fingerprint ?? ''}`).join(',');

/** A note in place of a chart, chips or table: still reading, nothing to read, or a failure. */
function Note({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="small faint" data-testid={testId}>
      {text}
    </p>
  );
}

/** The note for a load that has no value to show, or null when it has one. */
function useLoadNote(l: Loaded<unknown>, testId: string): ReactElement | null {
  const t = useT();
  if (l.status === 'loading') return <Note text={t('mcard.computing')} testId={`${testId}-busy`} />;
  if (l.status === 'error') return <Note text={t('mcard.loadFailed')} testId={`${testId}-error`} />;
  if (l.status === 'idle') return <Note text={t('mcard.noData')} testId={`${testId}-none`} />;
  return null;
}

// ---------------------------------------------------------------- points: vs and over time

/** A point's chosen surface and its height there (`vs` absent: none chosen). */
export function usePointVs(m: SurveyMeasurement): {
  option: SurfaceOption | null;
  surfaceZ: Loaded<number | null>;
  /** The point's own height (where it is drawn). */
  z: number | null;
} {
  const project = useWorkspace((s) => s.project?.id ?? null);
  const dated = useDatedSurfaces();
  const designs = useDesignSurfaces();
  const vs = useStore(cardViews, (s) => s[m.id]?.vs ?? null);
  const point = useDrawn(m)[0];
  const option =
    (vs === null ? null : [...dated.map(fromDated), ...designs].find((o) => o.key === vs)) ?? null;
  const tiles = option?.tiles;
  const surfaceZ = useLoaded<number | null>(
    project && point && tiles
      ? `vs|${project}|${String(point[0])},${String(point[1])}|${surfacesKey([option])}`
      : null,
    () =>
      project && point && tiles
        ? heightAt(tiles, point[0], point[1], surfaceTiles(project, tiles))
        : Promise.resolve(null),
  );
  return { option, surfaceZ, z: point ? point[2] : null };
}

/** A signed distance in the measurement's units: "+0.120 m", "-0.038 m". */
function useSigned(m: SurveyMeasurement): (v: number) => string {
  const { settings, units, locale } = useFormat(m);
  return (v) => {
    const text = formatQuantity(v, 'distance', units, settings.precision, locale);
    return v > 0 && /[1-9]/.test(text) ? `+${text}` : text;
  };
}

/** The card's secondary line part for a point's "vs" surface ("vs Design pad FG -0.038 m"). */
export function usePointVsText(m: SurveyMeasurement): string | null {
  const t = useT();
  const { option, surfaceZ, z } = usePointVs(m);
  const signed = useSigned(m);
  if (!option || z === null) return null;
  if (surfaceZ.status === 'error')
    return t('mcard.vs', { name: option.label, value: t('mcard.loadFailed') });
  if (surfaceZ.status !== 'ready') return null;
  const value = surfaceZ.value === null ? t('mcard.noData') : signed(z - surfaceZ.value);
  return t('mcard.vs', { name: option.label, value });
}

/** The surface a point is compared with, as one chip: the dates and the designs to choose from. */
function PointChips({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const dated = useDatedSurfaces();
  const designs = useDesignSurfaces();
  const { option } = usePointVs(m);
  const all = [...dated.map(fromDated), ...designs];
  if (all.length === 0) return null;
  const chip = (o: SurfaceOption): ChipOption => ({
    key: o.key,
    label: o.label,
    kind: o.group === 'design' ? 'design' : 'earlier',
    group: o.group,
    ...(o.date ? { date: o.date } : {}),
  });
  return (
    <SurfaceChips
      shown={option ? [chip(option)] : []}
      off={new Set()}
      addable={all.filter((o) => o.key !== option?.key).map(chip)}
      // one surface at a time: adding another replaces it, pressing it or × clears it
      onToggle={() => {
        chooseVs(m.id, null);
      }}
      onAdd={(key) => {
        chooseVs(m.id, key);
      }}
      onRemove={() => {
        chooseVs(m.id, null);
      }}
      testId="point-chips"
    />
  );
}

/** A point's elevation on every survey date, as a time chart (elevation history folded in). */
function ElevationOverTime({ m }: { m: SurveyMeasurement }): ReactElement {
  const t = useT();
  const project = useWorkspace((s) => s.project?.id ?? null);
  const dated = useDatedSurfaces();
  const point = useDrawn(m)[0];
  const { settings, units } = useFormat(m);
  const { option, surfaceZ } = usePointVs(m);
  const e = point?.[0];
  const n = point?.[1];
  const rows = useLoaded<PointHistoryRow[]>(
    project && e !== undefined && n !== undefined && dated.length > 0
      ? `history|${project}|${String(e)},${String(n)}|${surfacesKey(dated.map(fromDated))}`
      : null,
    () => pointHistory(dated, e ?? 0, n ?? 0, (s) => surfaceTiles(project ?? '', s)),
  );
  const note = useLoadNote(rows, 'elevation-time');
  if (note) return note;
  if (rows.status !== 'ready' || !rows.value.some((r) => r.z !== null))
    return <Note text={t('mcard.noData')} testId="elevation-time-none" />;
  const references: TimeReference[] = [];
  if (option?.group === 'design' && surfaceZ.status === 'ready' && surfaceZ.value !== null)
    references.push({ key: option.key, label: option.label, z: surfaceZ.value, kind: 'design' });
  if (m.tool === 'elevation-difference' && point)
    references.push({ key: 'point', label: t('mcard.pointLevel'), z: point[2], kind: 'base' });
  return (
    <TimeChart
      data={{ kind: 'elevation', rows: rows.value }}
      references={references}
      units={units}
      precision={settings.precision}
      testId="elevation-time"
    />
  );
}

// ---------------------------------------------------------------- lines: the profile per surface

/** The base of a line: the line as drawn, through its own vertex heights. */
export const BASE_KEY = 'base';

/** The chips a line offers: every survey date, every design and the base. */
export function lineOptions(
  dated: readonly DatedSurface[],
  designs: readonly SurfaceOption[],
  current: string | null,
  baseLabel: string,
): ChipOption[] {
  return [
    ...dated.map((d): ChipOption => ({
      key: d.capture,
      label: d.label,
      kind: d.capture === current ? 'current' : 'earlier',
      group: 'survey',
      date: d.date,
    })),
    ...designs.map((d): ChipOption => ({
      key: d.key,
      label: d.label,
      kind: 'design',
      group: 'design',
    })),
    { key: BASE_KEY, label: baseLabel, kind: 'base', group: 'base' },
  ];
}

/** The line as drawn, by horizontal chainage. */
function baseSeries(pts: readonly SitePoint[]): { chainage: number[]; z: number[] } {
  const chainage: number[] = [];
  const z: number[] = [];
  let c = 0;
  pts.forEach((p, i) => {
    if (i > 0) c += horizontalDistance(pts[i - 1] ?? p, p);
    chainage.push(c);
    z.push(p[2]);
  });
  return { chainage, z };
}

/**
 * A line's surfaces: those chosen, else the date in focus (or the latest) and the one before; the
 * sampled profile of each one chosen, read once for the card's chips, chart and detail.
 */
function useLine(m: SurveyMeasurement) {
  const t = useT();
  const project = useWorkspace((s) => s.project?.id ?? null);
  const pts = useDrawn(m);
  const dated = useDatedSurfaces();
  const designs = useDesignSurfaces();
  const focus = useFocusCapture();
  const view = useStore(cardViews, (s) => s[m.id]) ?? EMPTY_VIEW;
  const current = dated.find((d) => d.capture === focus)?.capture ?? dated.at(-1)?.capture ?? null;
  const options = lineOptions(dated, designs, current, t('mcard.lineAsDrawn'));
  const at = dated.findIndex((d) => d.capture === current);
  const fallback = [current, at > 0 ? dated[at - 1]?.capture : undefined].filter(
    (x): x is string => !!x,
  );
  const known = new Set(options.map((o) => o.key));
  const shown = (view.shown ?? fallback).filter((k) => known.has(k));
  const tilesOf = (key: string): HeightTiles | undefined =>
    dated.find((d) => d.capture === key)?.tiles ?? designs.find((d) => d.key === key)?.tiles;
  const picked = options.filter((o) => shown.includes(o.key));
  const series = useLoaded<ChartSeries[]>(
    project && pts.length >= 2 && picked.length > 0
      ? `line|${project}|${JSON.stringify(pts)}|${surfacesKey(picked.map((o) => ({ key: `${o.key}/${o.kind}`, tiles: tilesOf(o.key) })))}`
      : null,
    () => {
      const len = pts.reduce(
        (s, p, i) => s + (i > 0 ? horizontalDistance(pts[i - 1] ?? p, p) : 0),
        0,
      );
      const step = Math.max(0.25, len / 400);
      return Promise.all(
        picked.map(async (o): Promise<ChartSeries> => {
          const tiles = tilesOf(o.key);
          const p = tiles
            ? await withSurface(
                (h) => sampleProfile(pts, h, step),
                tiles,
                surfaceTiles(project ?? '', tiles),
              )
            : baseSeries(pts);
          return {
            key: o.key,
            label: o.label,
            kind: o.kind,
            ...(o.date ? { date: o.date } : {}),
            chainage: p.chainage,
            z: p.z,
          };
        }),
      );
    },
  );
  const off = new Set(view.off);
  const visible = series.status === 'ready' ? series.value.filter((s) => !off.has(s.key)) : [];
  return {
    pts,
    options,
    shown,
    off,
    view,
    series,
    visible,
    any: dated.length + designs.length > 0,
  };
}

/** The surfaces on the line's profile, as the chart's chips (surveys, designs, the base). */
function LineChips({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const { options, shown, off, view, any } = useLine(m);
  if (!any) return null;
  return (
    <SurfaceChips
      shown={shown.flatMap((k) => options.filter((o) => o.key === k))}
      off={off}
      addable={options.filter((o) => !shown.includes(o.key))}
      onToggle={(key) => {
        patchView(m.id, {
          shown,
          off: off.has(key) ? view.off.filter((k) => k !== key) : [...view.off, key],
        });
      }}
      onAdd={(key) => {
        patchView(m.id, { shown: [...shown, key] });
      }}
      onRemove={(key) => {
        patchView(m.id, {
          shown: shown.filter((k) => k !== key),
          off: view.off.filter((k) => k !== key),
          shadeVs: view.shadeVs === key ? null : view.shadeVs,
        });
      }}
      testId="line-chips"
    />
  );
}

/** The exaggeration that fills the chart (one rule for the card, the pile section and the report). */
export { autoExaggeration };

/** The series a berm is found on: the current survey, else the first survey shown. */
const bermSeries = (visible: readonly ChartSeries[]) =>
  visible.find((s) => s.kind === 'current') ?? visible.find((s) => s.kind === 'earlier') ?? null;

/** The berm on a line's profile, or null. */
function bermOf(visible: readonly ChartSeries[]): { series: ChartSeries; berm: BermCheck } | null {
  const s = bermSeries(visible);
  const berm = s ? bermCheck(s) : null;
  return s && berm ? { series: s, berm } : null;
}

/** Where along the line (E, N) a chainage is. */
function atChainage(pts: readonly SitePoint[], c: number): [number, number] {
  let base = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    const len = horizontalDistance(a, b);
    if (c <= base + len || i === pts.length - 1) {
      const f = len > 0 ? Math.min(1, Math.max(0, (c - base) / len)) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    base += len;
  }
  return [pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0];
}

/** The berm's toes and crest edges as marks on the profile. */
export function bermPins(pts: readonly SitePoint[], series: ChartSeries, berm: BermCheck): Pin[] {
  const marks: [number, number][] = [
    [berm.left.toeChainageM, berm.left.toeZ],
    [berm.left.crestEdgeChainageM, berm.crestZ],
    [berm.right.crestEdgeChainageM, berm.crestZ],
    [berm.right.toeChainageM, berm.right.toeZ],
  ];
  return marks.map(([c, z]) => {
    const [e, n] = atChainage(pts, c);
    return {
      chainage: c,
      e,
      n,
      reference: 0,
      values: [{ key: series.key, label: series.label, z, delta: null, grade: null }],
    };
  });
}

/** The line's profile on each chosen surface (`ProfileChart`); a berm check marks its berm. */
function LineProfile({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const t = useT();
  const { pts, series, visible, view, shown, any } = useLine(m);
  const { settings, units, angles } = useFormat(m);
  const note = useLoadNote(series, 'line-profile');
  if (!any) return <Note text={t('mcard.noData')} testId="line-profile-none" />;
  if (note) return note;
  if (!visible.some((s) => s.z.some((z) => z !== null)))
    return <Note text={t('mcard.noData')} testId="line-profile-none" />;
  const targets = visible
    .filter((s) => s.kind !== 'current')
    .map((s) => ({ key: s.key, label: s.label }));
  const shadeVs = targets.some((x) => x.key === view.shadeVs) ? view.shadeVs : null;
  const berm = m.tool === 'berm-check' ? bermOf(visible) : null;
  return (
    <>
      <ShadeVs
        targets={visible.some((s) => s.kind === 'current') ? targets : []}
        value={shadeVs}
        onChange={(key) => {
          patchView(m.id, { shown, shadeVs: key });
        }}
      />
      <ProfileChart
        series={visible}
        shadeVs={shadeVs}
        exaggeration={autoExaggeration(visible)}
        ends={{ a: t('mcard.endA'), b: t('mcard.endB') }}
        units={units}
        precision={settings.precision}
        angles={angles}
        {...(berm ? { pins: bermPins(pts, berm.series, berm.berm) } : {})}
        testId="line-profile"
      />
    </>
  );
}

/** Each shown surface's terrain length along the line (distance and grade). */
function TerrainLengths({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const t = useT();
  const { pts, series, visible } = useLine(m);
  const { settings, units, locale } = useFormat(m);
  if (series.status !== 'ready' || visible.length === 0) return null;
  const d = (v: number) => formatQuantity(v, 'distance', units, settings.precision, locale);
  return (
    <table className="sv-verts" data-testid="terrain-lengths">
      <caption>{t('mcard.terrainLength')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('mcard.surface')}</th>
          <th scope="col">{t('mcard.terrainLength')}</th>
        </tr>
      </thead>
      <tbody>
        {visible.map((s) => {
          // the base is the line itself: its length is the slope length through its vertices
          const len =
            s.kind === 'base'
              ? pts.reduce((sum, p, i) => sum + (i > 0 ? slopeDistance(pts[i - 1] ?? p, p) : 0), 0)
              : (() => {
                  const l = profileLength({ chainage: [...s.chainage], e: [], n: [], z: [...s.z] });
                  return l.coveredM > 0 ? l.lengthM : null;
                })();
          return (
            <tr key={s.key} data-surface={s.key}>
              <th scope="row">{s.label}</th>
              <td className="mono">{len === null ? t('mcard.noData') : d(len)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The berm check's sides: toe, height and slope each side, and the crest and base widths. */
function BermTable({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const t = useT();
  const { series, visible } = useLine(m);
  const { settings, units, locale } = useFormat(m);
  if (series.status !== 'ready') return null;
  const found = bermOf(visible);
  if (!found) return <Note text={t('mcard.berm.none')} testId="berm-none" />;
  const { berm } = found;
  const d = (v: number) => formatQuantity(v, 'distance', units, settings.precision, locale);
  const g = (v: number) => formatQuantity(v, 'grade', units, settings.precision, locale);
  return (
    <table className="sv-verts" data-testid="berm-table">
      <caption>{t('mcard.berm.title')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('mcard.berm.side')}</th>
          <th scope="col">{t('mcard.berm.toe')}</th>
          <th scope="col">{t('mcard.berm.height')}</th>
          <th scope="col">{t('mcard.berm.slope')}</th>
        </tr>
      </thead>
      <tbody>
        {(
          [
            ['left', t('mcard.berm.left'), berm.left],
            ['right', t('mcard.berm.right'), berm.right],
          ] as const
        ).map(([key, label, side]) => (
          <tr key={key} data-side={key}>
            <th scope="row">{label}</th>
            <td className="mono">{d(side.toeChainageM)}</td>
            <td className="mono">{d(side.heightM)}</td>
            <td className="mono">{g(side.slope)}</td>
          </tr>
        ))}
        <tr data-side="crest">
          <th scope="row">{t('mcard.berm.crestWidth')}</th>
          <td className="mono" colSpan={3}>
            {d(berm.crestWidthM)}
          </td>
        </tr>
        <tr data-side="base">
          <th scope="row">{t('mcard.berm.baseWidth')}</th>
          <td className="mono" colSpan={3}>
            {d(berm.baseWidthM)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** A cross-section's card: its pins and exports stay in the section view, opened from here. */
function OpenSection({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const t = useT();
  const pts = useDrawn(m);
  if (pts.length < 2) return null;
  return (
    <Button
      variant="quiet"
      icon="section"
      data-testid="card-open-section"
      onClick={() => {
        openSection(
          pts.map((p) => [p[0], p[1]] as [number, number]),
          {
            kind: 'measurement',
            id: m.id,
            label: m.label,
            ...(m.scope.kind === 'survey' ? { capture: m.scope.capture } : {}),
          },
        );
        setWindow(true);
      }}
    >
      {t('mcard.openSection')}
    </Button>
  );
}

// ---------------------------------------------------------------- area: terrain area per date

/** The polygon's terrain area on each survey date, as chips; the date in focus is on. */
function AreaDates({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const t = useT();
  const project = useWorkspace((s) => s.project?.id ?? null);
  const ring = useDrawn(m);
  const dated = useDatedSurfaces();
  const focus = useFocusCapture();
  const { settings, units, locale } = useFormat(m);
  const areas = useLoaded<Record<string, number | null>>(
    project && ring.length >= 3 && dated.length > 0
      ? `area|${project}|${JSON.stringify(ring)}|${surfacesKey(dated.map(fromDated))}`
      : null,
    async () => {
      let span = 0;
      for (const p of ring)
        for (const q of ring) span = Math.max(span, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
      const step = Math.max(0.5, span / 120);
      const r = await Promise.all(
        dated.map(async (d) => {
          const a = await withSurface(
            (h) => polygonAreas(ring, h, step),
            d.tiles,
            surfaceTiles(project ?? '', d.tiles),
          );
          return [d.capture, a.terrainM2] as const;
        }),
      );
      return Object.fromEntries(r);
    },
  );
  if (dated.length === 0) return null;
  return (
    <ul className="pc-chips mc-dates" data-testid="area-dates" aria-label={t('chart.date')}>
      {dated.map((d) => {
        const a = areas.status === 'ready' ? areas.value[d.capture] : undefined;
        const text =
          areas.status === 'error'
            ? t('mcard.loadFailed')
            : areas.status !== 'ready'
              ? t('mcard.computing')
              : a === null || a === undefined
                ? t('mcard.noData')
                : formatQuantity(a, 'area', units, settings.precision, locale);
        return (
          <li
            key={d.capture}
            className="pc-chip mc-date"
            data-on={d.capture === focus ? '' : undefined}
            data-capture={d.capture}
          >
            <span className="pc-chip-label">{d.label}</span>
            <span className="mc-date-value">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** "+ Compare date" on an area with no comparison yet: the volume card's own entry. */
function CompareArea({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const t = useT();
  const readOnly = useMeasure((s) => s.readOnly);
  const lookOnly = useAnnotateReadOnly();
  if (readOnly || lookOnly) return null;
  return (
    <div className="pc-chips">
      <button
        type="button"
        className="pc-chip-add"
        data-testid="survey-add-comparison"
        onClick={() => {
          updateMeasurement(m.id, (x) => ({ ...x, items: [...x.items, defaultItem(x.items)] }));
        }}
      >
        {t('vol.card.compareDate')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the vertex table

/** The differences between consecutive vertices, in the site's units and bearing style. */
export function VertexTable({ m }: { m: SurveyMeasurement }): ReactElement {
  const t = useT();
  const pts = useDrawn(m);
  const { settings, units, locale, angles } = useFormat(m);
  const rows = vertexTable(pts);
  const d = (v: number) => formatQuantity(v, 'distance', units, settings.precision, locale);
  return (
    <table className="sv-verts" data-testid="survey-vertex-table">
      <caption>{t('mcard.vt.caption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('mcard.vt.from')}</th>
          <th scope="col">{t('mcard.vt.dE')}</th>
          <th scope="col">{t('mcard.vt.dN')}</th>
          <th scope="col">{t('mcard.vt.dZ')}</th>
          <th scope="col">{t('mcard.vt.horizontal')}</th>
          <th scope="col">{t('mcard.vt.bearing')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.from}>
            <td className="mono">
              {t('mcard.vt.span', { a: String(r.from + 1), b: String(r.to + 1) })}
            </td>
            <td className="mono">{d(r.dE)}</td>
            <td className="mono">{d(r.dN)}</td>
            <td className="mono">{d(r.dZ)}</td>
            <td className="mono">{d(r.horizontalM)}</td>
            <td className="mono">{formatBearingAs(r.bearingDeg, angles, locale)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
