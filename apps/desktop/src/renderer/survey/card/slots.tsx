/**
 * What each tool puts in the shared card's slots (volumetric parity W2, the chart slot and the
 * chips-by-type tables of the spec):
 *
 * | Tools                                                    | Chips                     | Chart                     | Detail                  |
 * | -------------------------------------------------------- | ------------------------- | ------------------------- | ----------------------- |
 * | distance, grade, vertex-table, berm-check, section       | surfaces on the profile   | `ProfileChart` per date   | vertex table (its tool) |
 * | elevation, elevation-difference, annotation, el. history | none                      | `TimeChart` elevation     | none                    |
 * | volume                                                   | from/to and base (inside) | volume over time (inside) | `VolumeDetail`          |
 * | area                                                     | terrain area per date     | none                      | calculators             |
 * | azimuth, antenna-tilt, clearance, freehand               | none                      | none                      | none                    |
 *
 * Heights come from each date's prepared surface (`pointHistory.ts`). The slots are the detail
 * card's: the live card shows no chips or chart, and the report draws its own static charts.
 */
import { formatQuantity, localeOf } from '@aio/geo';
import {
  DEFAULT_ANGLES,
  type MeasurementTool,
  type SitePoint,
  type SurveyMeasurement,
} from '@aio/schema';
import {
  effectiveUnits,
  formatBearingAs,
  horizontalDistance,
  polygonAreas,
  sampleProfile,
  vertexTable,
  type ChartSeries,
} from '@aio/survey';
import { useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { ProfileChart } from '../../charts/ProfileChart';
import { ShadeVs } from '../../charts/ShadeVs';
import { SurfaceChips, type ChipOption } from '../../charts/SurfaceChips';
import { TimeChart } from '../../charts/TimeChart';
import { Calculators } from '../Calculators';
import { Comparisons } from '../Comparison';
import { drawnPoints } from '../measureDates';
import { useMeasure } from '../measureStore';
import { useFocusCapture } from '../qaHelpers';
import { surfaceOfCapture, useQa } from '../qaStore';
import { measurementHasChart } from './chartRule';
import type { CardSlots, CardVariant } from './MeasureCard';
import {
  pointHistory,
  surfaceTiles,
  withSurface,
  type DatedSurface,
  type PointHistoryRow,
} from './pointHistory';
import '../../charts/charts.css';

export type ChipsKind = 'surfaces' | 'area-dates' | null;
/** `volume` is drawn inside `VolumeDetail`, beside its table. */
export type ChartKind = 'profile' | 'elevation' | 'volume' | null;
export type DetailKind = 'vertex-table' | 'volume' | 'area' | null;

export interface SlotKinds {
  chips: ChipsKind;
  chart: ChartKind;
  detail: DetailKind;
}

const LINE_TOOLS: ReadonlySet<MeasurementTool> = new Set([
  'distance',
  'grade',
  'vertex-table',
  'berm-check',
  'section',
]);
const POINT_TOOLS: ReadonlySet<MeasurementTool> = new Set([
  'elevation',
  'elevation-difference',
  'annotation',
  'elevation-history',
]);

/** The spec's table: what each tool's card holds. Agrees with `measurementHasChart`. */
export function slotKinds(tool: MeasurementTool): SlotKinds {
  if (LINE_TOOLS.has(tool))
    return {
      chips: 'surfaces',
      chart: 'profile',
      detail: tool === 'vertex-table' ? 'vertex-table' : null,
    };
  if (POINT_TOOLS.has(tool)) return { chips: null, chart: 'elevation', detail: null };
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
  else if (k.chips === 'area-dates') slots.chips = <AreaDates m={m} />;
  if (k.chart === 'profile') slots.chart = <LineProfile m={m} />;
  else if (k.chart === 'elevation') slots.chart = <ElevationOverTime m={m} />;
  if (k.detail === 'vertex-table') slots.detail = <VertexTable m={m} />;
  else if (k.detail === 'volume')
    slots.detail = (
      <>
        <Comparisons m={m} />
        <Calculators m={m} />
      </>
    );
  else if (k.detail === 'area')
    slots.detail = (
      <>
        {/* an area compared to a date or a design keeps its comparisons */}
        {m.items.length > 0 && <Comparisons m={m} />}
        <Calculators m={m} />
      </>
    );
  return slots;
}

/** Whether the slot table and the one chart rule agree (`chartRule.ts`). */
export const chartAgrees = (tool: MeasurementTool): boolean =>
  (slotKinds(tool).chart !== null) === measurementHasChart({ tool });

// ---------------------------------------------------------------- shared reads

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

/** A key naming the dated surfaces (a re-prepared surface changes its fingerprint). */
const datedKey = (dated: readonly DatedSurface[]) =>
  dated.map((d) => `${d.capture}:${d.tiles.id}:${d.tiles.fingerprint}`).join(',');

/**
 * What `load` gives for the inputs `key` names: undefined when there is nothing to load (`key`
 * null), null while it loads, then its value. A value loaded for other inputs is never shown.
 */
function useLoaded<T>(key: string | null, load: () => Promise<T>): T | null | undefined {
  const [got, setGot] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    void load().then((value) => {
      if (live) setGot({ key, value });
    });
    return () => {
      live = false;
    };
    // `key` names every input `load` reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (key === null) return undefined;
  return got?.key === key ? got.value : null;
}

/** A note in place of a chart or chips: still reading, or nothing to read. */
function Note({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="small faint" data-testid={testId}>
      {text}
    </p>
  );
}

// ---------------------------------------------------------------- points: elevation over time

/** A point's elevation on every survey date, as a time chart (elevation history folded in). */
function ElevationOverTime({ m }: { m: SurveyMeasurement }): ReactElement {
  const t = useT();
  const project = useWorkspace((s) => s.project?.id ?? null);
  const dated = useDatedSurfaces();
  const point = useDrawn(m)[0];
  const { settings, units } = useFormat(m);
  const e = point?.[0];
  const n = point?.[1];
  const rows = useLoaded<PointHistoryRow[]>(
    project && e !== undefined && n !== undefined && dated.length > 0
      ? `${project}|${String(e)},${String(n)}|${datedKey(dated)}`
      : null,
    () => pointHistory(dated, e ?? 0, n ?? 0, (s) => surfaceTiles(project ?? '', s)),
  );
  if (rows === null) return <Note text={t('mcard.computing')} testId="elevation-time-busy" />;
  if (!rows?.some((r) => r.z !== null))
    return <Note text={t('mcard.noData')} testId="elevation-time-none" />;
  return (
    <TimeChart
      data={{ kind: 'elevation', rows }}
      units={units}
      precision={settings.precision}
      testId="elevation-time"
    />
  );
}

// ---------------------------------------------------------------- lines: the profile per date

interface LineView {
  /** The dates on the chart (chips), and those switched off. */
  shown: string[];
  off: string[];
  shadeVs: string | null;
}

/** Each line's chosen dates, shared by its chips and its chart. */
const lineViews = createStore<Record<string, LineView>>()(() => ({}));

function patchView(id: string, base: LineView, patch: Partial<LineView>): void {
  lineViews.setState((s) => ({ ...s, [id]: { ...(s[id] ?? base), ...patch } }));
}

/**
 * The line's dates: those chosen, else the date in focus (or the latest) and the one before it,
 * and the date drawn as the current survey.
 */
function useLineView(m: SurveyMeasurement) {
  const dated = useDatedSurfaces();
  const focus = useFocusCapture();
  const stored = useStore(lineViews, (s) => s[m.id]);
  const current = dated.find((d) => d.capture === focus)?.capture ?? dated.at(-1)?.capture ?? null;
  const base = useMemo((): LineView => {
    const at = dated.findIndex((d) => d.capture === current);
    const before = at > 0 ? dated[at - 1]?.capture : undefined;
    return { shown: [current, before].filter((x): x is string => !!x), off: [], shadeVs: null };
  }, [dated, current]);
  const view = stored ?? base;
  const known = new Set(dated.map((d) => d.capture));
  const shown = view.shown.filter((c) => known.has(c));
  const option = (d: DatedSurface): ChipOption => ({
    key: d.capture,
    label: d.label,
    kind: d.capture === current ? 'current' : 'earlier',
    group: 'survey',
    date: d.date,
  });
  return { dated, current, view: { ...view, shown }, base, option };
}

/** The surfaces on the line's profile, as the chart's chips. */
function LineChips({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const { dated, view, base, option } = useLineView(m);
  if (dated.length === 0) return null;
  const off = new Set(view.off);
  return (
    <SurfaceChips
      shown={view.shown.flatMap((c) => {
        const d = dated.find((x) => x.capture === c);
        return d ? [option(d)] : [];
      })}
      off={off}
      addable={dated.filter((d) => !view.shown.includes(d.capture)).map(option)}
      onToggle={(key) => {
        patchView(m.id, base, {
          off: off.has(key) ? view.off.filter((k) => k !== key) : [...view.off, key],
        });
      }}
      onAdd={(key) => {
        patchView(m.id, base, { shown: [...view.shown, key] });
      }}
      onRemove={(key) => {
        patchView(m.id, base, {
          shown: view.shown.filter((k) => k !== key),
          off: view.off.filter((k) => k !== key),
          shadeVs: view.shadeVs === key ? null : view.shadeVs,
        });
      }}
      testId="line-chips"
    />
  );
}

/** A vertical exaggeration that fills a 600 x 220 plot, in whole steps from 1 to 20. */
function autoExaggeration(series: readonly ChartSeries[]): number {
  let c1 = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    c1 = Math.max(c1, s.chainage.at(-1) ?? 0);
    for (const z of s.z)
      if (z !== null) {
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
  }
  if (!(hi > lo) || c1 <= 0) return 1;
  const fill = (c1 / (hi - lo)) * (158 / 526);
  return [20, 10, 5, 2, 1].find((x) => x <= fill) ?? 1;
}

/** The line's profile on each chosen date (`ProfileChart`). */
function LineProfile({ m }: { m: SurveyMeasurement }): ReactElement | null {
  const t = useT();
  const project = useWorkspace((s) => s.project?.id ?? null);
  const pts = useDrawn(m);
  const { dated, current, view, base, option } = useLineView(m);
  const { settings, units, angles } = useFormat(m);
  const picked = dated.filter((d) => view.shown.includes(d.capture));
  const series = useLoaded<ChartSeries[]>(
    project && pts.length >= 2 && picked.length > 0
      ? `${project}|${JSON.stringify(pts)}|${datedKey(picked)}|${String(current)}`
      : null,
    () => {
      const len = pts.reduce(
        (s, p, i) => s + (i > 0 ? horizontalDistance(pts[i - 1] ?? p, p) : 0),
        0,
      );
      const step = Math.max(0.25, len / 400);
      return Promise.all(
        picked.map(async (d): Promise<ChartSeries> => {
          const p = await withSurface(
            (h) => sampleProfile(pts, h, step),
            d.tiles,
            surfaceTiles(project ?? '', d.tiles),
          );
          return { ...option(d), chainage: p.chainage, z: p.z };
        }),
      );
    },
  );
  if (dated.length === 0) return <Note text={t('mcard.noData')} testId="line-profile-none" />;
  if (series === null) return <Note text={t('mcard.computing')} testId="line-profile-busy" />;
  const visible = (series ?? []).filter((s) => !view.off.includes(s.key));
  if (!visible.some((s) => s.z.some((z) => z !== null)))
    return <Note text={t('mcard.noData')} testId="line-profile-none" />;
  const targets = visible
    .filter((s) => s.kind !== 'current')
    .map((s) => ({ key: s.key, label: s.label }));
  const shadeVs = targets.some((x) => x.key === view.shadeVs) ? view.shadeVs : null;
  return (
    <>
      <ShadeVs
        targets={visible.some((s) => s.kind === 'current') ? targets : []}
        value={shadeVs}
        onChange={(key) => {
          patchView(m.id, base, { shadeVs: key });
        }}
      />
      <ProfileChart
        series={visible}
        shadeVs={shadeVs}
        exaggeration={autoExaggeration(visible)}
        ends={{ a: 'A', b: 'B' }}
        units={units}
        precision={settings.precision}
        angles={angles}
        testId="line-profile"
      />
    </>
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
      ? `${project}|${JSON.stringify(ring)}|${datedKey(dated)}`
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
        const a = areas?.[d.capture];
        const text =
          areas === null
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

// ---------------------------------------------------------------- the vertex table

/** The differences between consecutive vertices, in the site's units and bearing style. */
export function VertexTable({ m }: { m: SurveyMeasurement }): ReactElement {
  const pts = useDrawn(m);
  const { settings, units, locale, angles } = useFormat(m);
  const rows = vertexTable(pts);
  const d = (v: number) => formatQuantity(v, 'distance', units, settings.precision, locale);
  return (
    <table className="sv-verts" data-testid="survey-vertex-table">
      <caption>Vertex differences</caption>
      <thead>
        <tr>
          <th scope="col">From</th>
          <th scope="col">dE</th>
          <th scope="col">dN</th>
          <th scope="col">dZ</th>
          <th scope="col">Horizontal</th>
          <th scope="col">Bearing</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.from}>
            <td className="mono">
              {r.from + 1} to {r.to + 1}
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
