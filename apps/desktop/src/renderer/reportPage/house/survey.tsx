// The house report's survey sections (M11 G9, PRD SRV-13; volumetric parity W1, W2, W4, W8):
// measurements, earthworks to design, the stockpile inventory, volume over time and landfill
// airspace and compaction. Each states what its numbers were computed and shown with (CRS,
// vertical datum, geoid, calibration and units) and formats every value as the app does
// (`@aio/geo` `formatQuantity`, the site's units and precision). The charts and the measurement
// cards are the app's own components (`ProfileChart`, `TimeChart`, `MeasureCard`) printed as
// static markup, and every pile figure is the one its card and the Volumes view show (the data
// comes from `surveyData.ts`), so the report agrees with the app.
import {
  formatNumber,
  formatQuantity,
  localeOf,
  unitFactor,
  unitLabel,
  type NumberLocale,
} from '@aio/geo';
import { houseVolumesOf } from '@aio/project/export';
import type {
  ComparisonReport,
  HouseVolumes,
  MeasurementReport,
  SurveyBasis,
} from '@aio/project/export';
import { DEFAULT_ANGLES, type ComparisonResult, type SurveySettings } from '@aio/schema';
import {
  TOOL_LABELS,
  type ChartSeries,
  type NotCounted,
  type StackRow,
  type TimeRow,
} from '@aio/survey';
import { t } from '@aio/ui';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { autoExaggeration, plotOf } from '../../charts/exaggeration';
import { ProfileChart } from '../../charts/ProfileChart';
import { TimeChart, type TimeReference } from '../../charts/TimeChart';
import { MeasureCard } from '../../survey/card/MeasureCard';
import { longDate } from '../../report/narrativeTemplate';
import { esc } from '../layout';
import { niceStep } from './charts';
import type { Pager } from './pager';
import {
  el,
  heading,
  row,
  subheading,
  tableMaker,
  tiles,
  txt,
  type HouseContext,
} from './sections';
import {
  chartSeries,
  type EntryChart,
  type PileOverTime,
  type ReportEntry,
  type ReportSurveyData,
} from './surveyData';

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

/** Chart width in CSS pixels: the full page body (182 mm). */
const FULL = 688;
/** Chart height in CSS pixels. */
const CHART_H = 200;

// ---------------------------------------------------------------- formatting

/** The site's number style: its own choice, else its distance unit's system (as the app's). */
export const localeOfSite = (
  b: Pick<SurveyBasis, 'units'>,
  s?: Pick<SurveySettings, 'locale'> | null,
): NumberLocale => s?.locale ?? localeOf(b.units.distance);

/** The formatters of a site: the panel's units, precision and number style (`settings.locale`). */
export function formats(b: SurveyBasis, s?: Pick<SurveySettings, 'locale'> | null) {
  const loc = localeOfSite(b, s);
  return {
    locale: loc,
    volume: (m3: number) => formatQuantity(m3, 'volume', b.units, b.precision, loc),
    area: (m2: number) => formatQuantity(m2, 'area', b.units, b.precision, loc),
    distance: (m: number) => formatQuantity(m, 'distance', b.units, b.precision, loc),
    /** Tonnes (mass is SI kilograms in `@aio/geo`). */
    mass: (tonnes: number) => formatQuantity(tonnes * 1000, 'mass', b.units, b.precision, loc),
    density: (tPerM3: number) => formatQuantity(tPerM3, 'density', b.units, 3, loc),
    /** A share (0 to 1) as a percentage, to one decimal (none when it is whole). */
    pct: (share: number) => {
      const v = Math.round(share * 1000) / 10;
      return `${formatNumber(v, Number.isInteger(v) ? 0 : 1, loc)} %`;
    },
  };
}
type Formats = ReturnType<typeof formats>;

/** The formatters of the report's survey data: its basis and its settings' number style. */
const formatsOf = (data: ReportSurveyData) => formats(data.basis, data.settings);

/** What the numbers were computed and shown with, one line each. */
export function basisLines(b: SurveyBasis, s?: Pick<SurveySettings, 'locale'> | null): string[] {
  const loc = localeOfSite(b, s);
  // a calibration's residuals are small: millimetres on a metric site, inches on another
  const small = loc === 'metric' ? 'mm' : 'in';
  const rms = (m: number | null) =>
    m === null ? '-' : formatQuantity(m, 'distance', small, 1, loc);
  const heights =
    b.verticalDatum === 'geoid'
      ? tk('house.survey.basis.heights.geoid', {
          geoid: `${b.geoid ?? ''}${b.verticalCrs ? ` (${b.verticalCrs})` : ''}`,
        })
      : tk(`house.survey.basis.heights.${b.verticalDatum}`);
  const cal = b.calibration
    ? tk('house.survey.basis.cal', {
        name: b.calibration.name,
        h: rms(b.calibration.rmsH),
        v: rms(b.calibration.rmsV),
      })
    : tk('house.survey.basis.calNone');
  const u = b.units;
  const units = [u.distance, u.area, u.volume, u.density, u.mass].map((x) => unitLabel(x));
  return [
    tk('house.survey.basis.crs', {
      crs: b.crs,
      distances: tk(`house.survey.basis.${b.distances}`),
    }),
    heights,
    tk('house.survey.basis.geoid', {
      geoid: b.geoid ?? tk('house.survey.basis.noGeoid'),
    }),
    cal,
    tk('house.survey.basis.units', {
      units: [...units, tk(`house.survey.basis.grade.${u.grade}`)].join(', '),
    }),
  ];
}

function basisBlock(p: Pager, data: ReportSurveyData): void {
  const lines = basisLines(data.basis, data.settings);
  p.add(el(`<div class="sv-basis">${lines.map((l) => `<span>${txt(l)}</span>`).join('')}</div>`));
  const cur = data.current;
  p.add(
    el(
      `<p class="caption">${txt(
        data.computed && cur
          ? tk('house.survey.computed', { survey: longDate(cur.date) })
          : tk('house.survey.stored'),
      )}</p>`,
    ),
  );
}

const statusText = (s: ComparisonResult['status'] | 'missing') =>
  s === 'ok' ? '' : tk(`house.survey.status.${s}`);

/** The status of a result with its reason ("Partial: 3% outside the survey"). */
function statusOf(r: ComparisonResult | null, reason: string): string {
  if (!r) return reason || statusText('missing');
  if (r.carried) return tk('vol.status.carried', { base: r.carried.base });
  const s = statusText(r.status);
  return [s, r.reason ?? ''].filter(Boolean).join(': ');
}

const usable = (r: ComparisonResult | null): r is ComparisonResult =>
  r !== null && (r.status === 'ok' || r.status === 'partial');

/** A caption naming the deadband when one was used (the report always says so). */
function deadbandNote(
  p: Pager,
  results: readonly ComparisonResult[],
  distance: (x: number) => string,
) {
  const used = results.filter((r) => r.usedDeadband);
  if (used.length === 0) return;
  const ds = [...new Set(used.map((r) => r.deadbandM))];
  p.add(
    el(
      `<p class="caption">${txt(
        tk('house.survey.deadband', {
          d: ds.map((d) => distance(d)).join(', '),
          count: used.length,
          n: String(used.length),
        }),
      )}</p>`,
    ),
  );
}

// ---------------------------------------------------------------- the shared charts, static

/** A shared component as the report prints it: static markup, no handlers. */
const markup = (node: ReactElement): string => renderToStaticMarkup(node);

/** A figure holding one printed chart. */
const figure = (html: string, cls = '') =>
  el(`<figure class="chartfig svc${cls ? ` ${cls}` : ''}">${html}</figure>`);

interface ChartUnits {
  units: SurveyBasis['units'];
  precision: SurveyBasis['precision'];
}
const chartUnits = (data: ReportSurveyData): ChartUnits => ({
  units: data.basis.units,
  precision: data.basis.precision,
});

/** The profile chart, static: designs dashed, earlier surveys grey, cut and fill vs a design. */
function profileChart(
  series: readonly ChartSeries[],
  data: ReportSurveyData,
  testId: string,
): ReactElement {
  const shadeVs = series.some((s) => s.kind === 'current')
    ? (series.find((s) => s.kind === 'design')?.key ?? null)
    : null;
  return (
    <ProfileChart
      series={series}
      shadeVs={shadeVs}
      exaggeration={autoExaggeration(series, plotOf(FULL, CHART_H))}
      ends={{ a: tk('mcard.endA'), b: tk('mcard.endB') }}
      {...chartUnits(data)}
      angles={data.settings.angles ?? DEFAULT_ANGLES}
      width={FULL}
      height={CHART_H}
      interactive={false}
      testId={testId}
    />
  );
}

function volumeChart(rows: readonly TimeRow[], data: ReportSurveyData): ReactElement {
  return (
    <TimeChart
      data={{ kind: 'volume', rows }}
      {...chartUnits(data)}
      width={FULL}
      height={CHART_H}
      interactive={false}
      testId="report-volume-time"
    />
  );
}

/** The chart a template entry prints, as its card draws it. */
function entryChart(chart: EntryChart, data: ReportSurveyData): ReactElement {
  switch (chart.kind) {
    case 'profile':
      return profileChart(chart.series, data, 'report-line-profile');
    case 'volume':
      return volumeChart(chart.rows, data);
    case 'elevation': {
      const references: TimeReference[] =
        chart.level === null
          ? []
          : [{ key: 'point', label: tk('mcard.pointLevel'), z: chart.level, kind: 'base' }];
      return (
        <TimeChart
          data={{ kind: 'elevation', rows: chart.rows }}
          references={references}
          {...chartUnits(data)}
          width={FULL}
          height={CHART_H}
          interactive={false}
          testId="report-elevation-time"
        />
      );
    }
  }
}

// ---------------------------------------------------------------- the plan

/**
 * The measurements from above, cropped to their extent: polygons, lines and points in the project
 * CRS (east right, north up) with their reference labels, a scale bar and a north arrow.
 */
export function measurementPlan(
  items: readonly Pick<MeasurementReport, 'ref' | 'family' | 'outline'>[],
  label: string,
  size = { width: FULL, height: 340 },
  site: { units: Pick<SurveyBasis['units'], 'distance'>; locale?: NumberLocale } = {
    units: { distance: 'm' },
  },
): string {
  const pts = items.flatMap((m) => m.outline);
  if (pts.length === 0) return '';
  const es = pts.map((q) => q[0]);
  const ns = pts.map((q) => q[1]);
  const pad = Math.max(2, (Math.max(...es) - Math.min(...es)) * 0.04);
  const minE = Math.min(...es) - pad;
  const maxE = Math.max(...es) + pad;
  const minN = Math.min(...ns) - pad;
  const maxN = Math.max(...ns) + pad;
  const margin = 16;
  const { width, height } = size;
  const k = Math.min(
    (width - 2 * margin) / (maxE - minE || 1),
    (height - 2 * margin - 14) / (maxN - minN || 1),
  );
  const ox = (width - (maxE - minE) * k) / 2;
  const oy = (height - 14 - (maxN - minN) * k) / 2;
  const X = (e: number) => ox + (e - minE) * k;
  const Y = (n: number) => oy + (maxN - n) * k;
  const xy = (q: readonly number[]) => `${X(q[0] ?? 0).toFixed(1)},${Y(q[1] ?? 0).toFixed(1)}`;
  const shapes = items
    .map((m) => {
      const o = m.outline;
      const first = o[0];
      if (!first) return '';
      const cx = o.reduce((s, q) => s + q[0], 0) / o.length;
      const cy = o.reduce((s, q) => s + q[1], 0) / o.length;
      const tag = `<text class="pl" x="${X(cx).toFixed(1)}" y="${(Y(cy) + 3).toFixed(1)}" text-anchor="middle">${esc(m.ref)}</text>`;
      if (m.family === 'point')
        return `<circle class="svp" cx="${X(first[0]).toFixed(1)}" cy="${Y(first[1]).toFixed(1)}" r="2.4"/>${tag}`;
      const d = o.map((q, i) => `${i === 0 ? 'M' : 'L'}${xy(q)}`).join('');
      return m.family === 'polygon' && o.length >= 3
        ? `<path class="pile" d="${d}Z"/>${tag}`
        : `<path class="svl" d="${d}"/>${tag}`;
    })
    .join('');
  // a round step in the site's distance unit, labelled in it
  const factor = unitFactor('distance', site.units.distance);
  const stepUnits = niceStep((maxE - minE) / factor / 5);
  const step = stepUnits * factor;
  const decimals = Math.max(0, Math.ceil(-Math.log10(stepUnits) - 1e-9));
  const stepText = formatQuantity(step, 'distance', site.units.distance, decimals, site.locale);
  const sy = height - 6;
  const scale = `<g class="scale"><line x1="${ox.toFixed(1)}" y1="${String(sy)}" x2="${(ox + step * k).toFixed(1)}" y2="${String(sy)}"/><text x="${(ox + step * k + 4).toFixed(1)}" y="${String(sy + 3)}">${esc(stepText)}</text></g>`;
  const north = `<g class="north" transform="translate(${(width - 14).toFixed(1)},16)"><path d="M0,-10 L5,6 L0,3 L-5,6 Z"/><text y="18" text-anchor="middle">N</text></g>`;
  return `<svg class="map" viewBox="0 0 ${String(width)} ${String(height)}" width="100%" role="img" aria-label="${esc(label)}">${shapes}${scale}${north}</svg>`;
}

/** The volume measurements from above (the site page's stockpile map), or ''. */
export function pilePlan(data: ReportSurveyData | null | undefined, label: string): string {
  if (!data) return '';
  const ids = new Set(data.volumes.piles.map((p) => p.id));
  return measurementPlan(
    data.measurements.filter((m) => ids.has(m.id)),
    label,
    undefined,
    {
      units: data.basis.units,
      locale: localeOfSite(data.basis, data.settings),
    },
  );
}

// ---------------------------------------------------------------- measurements

/** The readouts of one measurement on one line ("Area 1 234.50 m² · Perimeter 140.000 m"). */
const resultText = (m: MeasurementReport) =>
  m.values
    .filter((v) => v.si !== null && !['cut', 'fill', 'net', 'total', 'vertices'].includes(v.key))
    .slice(0, 4)
    .map((v) => `${v.label} ${v.display}`)
    .join(' · ');

/** The status line a volume card shows: carried from an earlier version, or stale. */
function cardStatus(e: ReportEntry): string | null {
  const r = e.m.results.find((x) => x.item === e.m.items[0]?.id);
  if (!r) return e.m.tool === 'volume' ? tk('vol.status.notComputed') : null;
  if (r.carried) return tk('vol.status.carried', { base: r.carried.base });
  if (r.status === 'stale') return tk('vol.status.stale');
  return null;
}

/** One template entry as its report card (W8): the card, its chart and its readout table. */
function entryCard(e: ReportEntry, data: ReportSurveyData): string {
  const model = e.card;
  const status = cardStatus(e);
  const chart = e.chart && e.parts.includes('chart') ? entryChart(e.chart, data) : null;
  return markup(
    <MeasureCard
      model={model}
      variant="report"
      measureId={e.m.id}
      testId="report-card"
      slots={{
        ...(chart ? { chart } : {}),
        ...(status ? { status } : {}),
      }}
    />,
  );
}

function readoutTable(p: Pager, m: MeasurementReport): void {
  const rows = m.values.filter((v) => v.si !== null || v.display !== '');
  if (rows.length === 0) return;
  p.table(
    tableMaker('grid sv-readout', [
      tk('house.survey.col.measurement'),
      tk('house.survey.col.result'),
    ]),
    rows.map((v) => row([txt(v.label), esc(v.display)])),
  );
}

export function layoutMeasurements(p: Pager, ctx: HouseContext, n: string): void {
  const data = ctx.survey;
  if (!data) return;
  const f = formatsOf(data);
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.measurements'));
  basisBlock(p, data);
  const plan = measurementPlan(data.measurements, tk('house.survey.plan'), undefined, {
    units: data.basis.units,
    locale: localeOfSite(data.basis, data.settings),
  });
  if (plan) {
    subheading(p, tk('house.survey.plan'));
    p.add(el(`<figure class="chartfig">${plan}</figure>`));
    p.add(el(`<p class="caption">${txt(tk('house.survey.planCaption'))}</p>`));
  }
  subheading(p, tk('house.survey.list'));
  if (data.entries.length > 0) {
    // the report template's entries (W8): each measurement's card, in the template's order
    const reports = new Map(data.measurements.map((m) => [m.id, m]));
    for (const e of data.entries) {
      p.add(el(`<div class="sv-card" data-ref="${esc(e.ref)}">${entryCard(e, data)}</div>`));
      const m = reports.get(e.m.id);
      if (m && e.parts.includes('table')) readoutTable(p, m);
    }
  } else {
    p.table(
      tableMaker('grid sv-list', [
        tk('house.survey.col.ref'),
        tk('house.survey.col.measurement'),
        tk('house.survey.col.tool'),
        tk('house.survey.col.survey'),
        tk('house.survey.col.result'),
      ]),
      data.measurements.map((m) =>
        row([
          `<b>${esc(m.ref)}</b>`,
          `${txt(m.label)}${m.folder ? `<br><span class="faint small">${txt(m.folder)}</span>` : ''}`,
          txt(m.template ?? TOOL_LABELS[m.tool]),
          esc(m.capture ? longDate(m.capture.date) : ''),
          `${txt(resultText(m))}${
            m.fields.length
              ? `<br><span class="faint small">${txt(m.fields.map((x) => `${x.name}: ${x.value}`).join(' · '))}</span>`
              : ''
          }`,
        ]),
      ),
    );
    const more = data.measurementCount - data.measurements.length;
    if (more > 0)
      p.add(el(`<p class="caption">${txt(tk('house.survey.more', { n: String(more) }))}</p>`));
  }
  // the volumes of every comparison as stored, with a totals row of the current results
  const cmp = data.measurements.flatMap((m) => m.comparisons.map((c) => ({ m, c })));
  if (cmp.length === 0) return;
  subheading(p, tk('house.survey.volumes'));
  const ok = cmp.flatMap(({ c }) => (usable(c.result) ? [c.result] : []));
  const rows = cmp.map(({ m, c }) => volumeRow(m.ref, m.label, c, f));
  const sum = (k: 'cutM3' | 'fillM3' | 'netM3' | 'areaM2') => ok.reduce((a, r) => a + r[k], 0);
  rows.push(
    row(
      [
        '',
        `<b>${txt(tk('house.survey.total'))}</b>`,
        txt(tk('house.survey.counted', { n: String(ok.length), of: String(cmp.length) })),
        `<b>${esc(f.volume(sum('cutM3')))}</b>`,
        `<b>${esc(f.volume(sum('fillM3')))}</b>`,
        `<b>${esc(f.volume(sum('netM3')))}</b>`,
        `<b>${esc(f.area(sum('areaM2')))}</b>`,
        '',
      ],
      'num total',
    ),
  );
  p.table(
    tableMaker('grid num sv-vol', [
      tk('house.survey.col.ref'),
      tk('house.survey.col.measurement'),
      tk('house.survey.col.comparison'),
      tk('house.survey.col.cut'),
      tk('house.survey.col.fill'),
      tk('house.survey.col.net'),
      tk('house.survey.col.area'),
      tk('house.survey.col.status'),
    ]),
    rows,
  );
  p.add(el(`<p class="caption">${txt(tk('house.survey.signs'))}</p>`));
  deadbandNote(p, ok, f.distance);
}

function volumeRow(ref: string, label: string, c: ComparisonReport, f: Formats): HTMLElement {
  const r = c.result;
  const shown = usable(r);
  return row(
    [
      `<b>${esc(ref)}</b>`,
      txt(label),
      txt(c.label),
      shown ? esc(f.volume(r.cutM3)) : '',
      shown ? esc(f.volume(r.fillM3)) : '',
      shown ? esc(f.volume(r.netM3)) : '',
      shown ? esc(f.area(r.areaM2)) : '',
      txt(statusOf(r, c.reason)),
    ],
    r?.status === 'stale' || r?.status === 'refused' ? 'num flag' : 'num',
  );
}

// ---------------------------------------------------------------- volumes over time

/** Why a pile is left out of a date's total, in words (the Volumes view's). */
export function notCountedText(x: NotCounted): string {
  switch (x.reason) {
    case 'stale':
      return tk('vol.notCounted.stale');
    case 'no-data':
      return tk('vol.notCounted.noData');
    case 'not-computed':
      return tk('vol.notCounted.notComputed');
    case 'failed':
      return x.detail
        ? tk('vol.notCounted.failedWhy', { reason: x.detail })
        : tk('vol.notCounted.failed');
    case 'no-comparison':
      return tk('vol.notCounted.noComparison');
  }
}

/** A date's piles left out of its total: "Stockpile B (stale), Pad (no survey data)". */
function notCountedList(s: StackRow, names: ReadonlyMap<string, string>): string {
  return (s.notCounted ?? [])
    .map((x) =>
      tk('vol.view.notCountedEntry', { name: names.get(x.id) ?? x.id, reason: notCountedText(x) }),
    )
    .join(', ');
}

/** The change of a date's total since the date before with counted piles, over the piles on both. */
function changeText(s: StackRow, f: Formats): string {
  const c = s.change;
  if (!c) return '';
  const of =
    c.piles < c.of ? ` (${tk('vol.view.ofPiles', { n: String(c.piles), count: c.of })})` : '';
  return `${f.volume(c.m3)}${of}`;
}

/** One pile's row on a date, as its card's table words it. */
function rowStatus(r: TimeRow, p: PileOverTime): string {
  if (r.stale) return tk('vol.status.stale');
  switch (r.status) {
    case 'ok':
      return '';
    case 'partial':
      return r.reason ? tk('vol.card.partlyWhy', { reason: r.reason }) : tk('vol.status.partial');
    case 'refused':
      return r.reason ? tk('vol.card.refusedWhy', { reason: r.reason }) : tk('vol.status.none');
    case 'missing':
      return p.carried ? tk('vol.status.none') : tk('vol.status.notComputed');
    default:
      return statusText(r.status);
  }
}

/** A pile's volume on every survey date: its time chart and its table (date, volume, change). */
function pileOverTime(p: Pager, pile: PileOverTime, data: ReportSurveyData): void {
  const f = formatsOf(data);
  subheading(p, `${pile.ref} · ${pile.label}`);
  if (pile.carried) p.add(el(`<p class="caption">${txt(pile.carried)}</p>`));
  if (pile.rows.some((r) => r.valueM3 !== null))
    p.add(figure(markup(volumeChart(pile.rows, data))));
  const tonnes = pile.material?.densityTPerM3 !== undefined;
  p.table(
    tableMaker('grid num sv-time', [
      tk('house.survey.col.survey'),
      tk('house.survey.col.volume'),
      tk('vol.change'),
      ...(tonnes ? [tk('house.survey.col.tonnes')] : []),
      tk('house.survey.col.status'),
    ]),
    pile.rows.map((r) =>
      row(
        [
          esc(longDate(r.date)),
          r.valueM3 === null ? '' : esc(f.volume(r.valueM3)),
          r.changeM3 === null ? '' : esc(f.volume(r.changeM3)),
          ...(tonnes ? [r.tonnes === null ? '' : esc(f.mass(r.tonnes))] : []),
          txt(rowStatus(r, pile)),
        ],
        r.stale || r.status === 'refused' ? 'num flag' : 'num',
      ),
    ),
  );
}

/**
 * The site inventory over time (W4): the piles stacked per survey date, and a table of each
 * date's total (current figures only), its change and the piles left out with why.
 */
export function inventoryBlock(p: Pager, data: ReportSurveyData): void {
  const f = formatsOf(data);
  const inv = data.volumes.inventory;
  if (inv.length === 0) return;
  const names = new Map(data.volumes.piles.map((x) => [x.id, `${x.ref} ${x.label}`]));
  const charted = inv.filter((r) => r.parts.length > 0);
  if (charted.length > 0)
    p.add(
      figure(
        markup(
          <TimeChart
            data={{ kind: 'stack', rows: charted, names }}
            {...chartUnits(data)}
            width={FULL}
            height={CHART_H}
            interactive={false}
            testId="report-inventory-time"
          />,
        ),
      ),
    );
  const piles = data.volumes.piles.length;
  p.table(
    tableMaker('grid num sv-inv', [
      tk('house.survey.col.survey'),
      tk('vol.card.total'),
      tk('vol.change'),
      tk('house.vot.col.counted'),
      tk('vol.view.notCounted'),
    ]),
    inv.map((s) =>
      row(
        [
          esc(longDate(s.date)),
          s.parts.length > 0 ? `<b>${esc(f.volume(s.totalM3))}</b>` : '',
          esc(changeText(s, f)),
          esc(tk('vol.view.ofPiles', { n: String(s.parts.length), count: piles })),
          txt(notCountedList(s, names)),
        ],
        'num',
      ),
    ),
  );
  const partial = [...new Set(inv.flatMap((s) => s.partial ?? []))];
  if (partial.length > 0)
    p.add(
      el(
        `<p class="caption">${txt(
          tk('vol.view.partial', { names: partial.map((id) => names.get(id) ?? id).join(', ') }),
        )}</p>`,
      ),
    );
}

/** The piles the volume over time section prints: the template's, else every one. */
function overTimePiles(data: ReportSurveyData): PileOverTime[] {
  if (data.entries.length === 0) return data.volumes.piles;
  const byId = new Map(data.volumes.piles.map((x) => [x.id, x]));
  const named = data.entries.flatMap((e) => {
    const pile = byId.get(e.m.id);
    return pile ? [pile] : [];
  });
  // a template of other measurements only: every pile, as without one
  return named.length > 0 ? named : data.volumes.piles;
}

export function layoutVolumeOverTime(p: Pager, ctx: HouseContext, n: string): void {
  const data = ctx.survey;
  if (!data) return;
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.volume-over-time'));
  basisBlock(p, data);
  p.add(el(`<p class="nar">${txt(tk('house.vot.intro'))}</p>`));
  for (const pile of overTimePiles(data)) pileOverTime(p, pile, data);
  if (data.volumes.inventory.length > 0) {
    subheading(p, tk('vol.inventory'));
    inventoryBlock(p, data);
  }
}

// ---------------------------------------------------------------- stockpiles

/** The latest date's row (the Volumes view's total) and the date its change is since. */
export function latestInventory(data: ReportSurveyData): {
  cur: StackRow | null;
  prev: StackRow | null;
} {
  const inv = data.volumes.inventory;
  const cur = inv.at(-1) ?? null;
  const prev = cur?.change ? (inv.slice(0, -1).findLast((r) => r.parts.length > 0) ?? null) : null;
  return { cur, prev };
}

/**
 * The site inventory the house model summarises (KPIs, the narrative): the Volumes view's figures,
 * in the site's units; null without a volume measurement.
 */
/** Whether volume over time prints: a pile with figures on two dates or more, as worked out. */
export const printsVolumeOverTime = (data: ReportSurveyData): boolean =>
  data.volumes.piles.some((x) => x.rows.filter((r) => r.valueM3 !== null).length >= 2);

export function houseVolumes(data: ReportSurveyData | null | undefined): HouseVolumes | null {
  if (!data) return null;
  return houseVolumesOf(
    data.volumes.inventory,
    data.volumes.piles.map((x) => x.carried ?? x.base),
    formatsOf(data).volume,
  );
}

export function layoutStockpiles(p: Pager, ctx: HouseContext, n: string): void {
  const data = ctx.survey;
  if (!data) return;
  const f = formatsOf(data);
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.stockpiles'));
  basisBlock(p, data);
  const piles = data.volumes.piles;
  const { cur, prev } = latestInventory(data);
  if (cur)
    p.add(
      el(
        `<p class="nar">${txt(
          prev
            ? tk('house.survey.pile.intro', {
                date: longDate(cur.date),
                prev: longDate(prev.date),
              })
            : tk('house.survey.pile.introOne', { date: longDate(cur.date) }),
        )}</p>`,
      ),
    );
  const on = (s: StackRow | null, id: string) => s?.parts.find((x) => x.id === id)?.valueM3 ?? null;
  const density = (pile: PileOverTime) => pile.material?.densityTPerM3 ?? null;
  const tonnesOf = (pile: PileOverTime, m3: number | null) => {
    const d = density(pile);
    return m3 !== null && d !== null ? m3 * d : null;
  };
  const counted = piles.filter((x) => on(cur, x.id) !== null);
  const both = counted.filter((x) => on(prev, x.id) !== null);
  const sumOf = (list: readonly PileOverTime[], s: StackRow | null) =>
    list.reduce((a, x) => a + (on(s, x.id) ?? 0), 0);
  /** Mass of a set of piles, null when one of them has no density. */
  const massOf = (list: readonly PileOverTime[], s: StackRow | null) =>
    list.length > 0 && list.every((x) => density(x) !== null)
      ? list.reduce((a, x) => a + (tonnesOf(x, on(s, x.id)) ?? 0), 0)
      : null;
  const totalM3 = cur && cur.parts.length > 0 ? cur.totalM3 : null;
  const mass = massOf(counted, cur);
  const kpi = [
    { value: String(piles.length), label: tk('house.survey.kpi.piles') },
    { value: totalM3 === null ? '-' : f.volume(totalM3), label: tk('house.survey.kpi.volume') },
  ];
  if (mass !== null) kpi.push({ value: f.mass(mass), label: tk('house.survey.kpi.mass') });
  if (cur?.change) kpi.push({ value: changeText(cur, f), label: tk('house.survey.kpi.change') });
  p.add(tiles(kpi));
  const names = new Map(piles.map((x) => [x.id, `${x.ref} ${x.label}`]));
  const left = new Map((cur?.notCounted ?? []).map((x) => [x.id, x]));
  const head = [
    tk('house.survey.col.ref'),
    tk('house.survey.col.pile'),
    tk('house.survey.col.material'),
    tk('house.survey.col.density'),
    cur
      ? tk('house.survey.col.volumeOn', { date: longDate(cur.date) })
      : tk('house.survey.col.volume'),
    tk('house.survey.col.tonnes'),
    ...(prev
      ? [
          tk('house.survey.col.volumeOn', { date: longDate(prev.date) }),
          tk('house.survey.col.change'),
          tk('house.survey.col.changeT'),
        ]
      : []),
  ];
  const rows = piles.map((pile) => {
    const v = on(cur, pile.id);
    const w = on(prev, pile.id);
    const d = density(pile);
    const change = v !== null && w !== null ? v - w : null;
    // a stale figure prints as the card shows it, marked, and is never added to the total
    const staleRow = cur
      ? pile.rows.find((r) => r.capture === cur.capture && r.stale && r.valueM3 !== null)
      : undefined;
    const shownM3 = v ?? staleRow?.valueM3 ?? null;
    const flagged = left.has(pile.id) || pile.carried !== null;
    return row(
      [
        `<b>${esc(pile.ref)}</b>`,
        `${txt(pile.label)}${flagged ? ' *' : ''}`,
        txt(
          pile.material
            ? `${pile.material.name}${pile.material.code ? ` (${pile.material.code})` : ''}`
            : tk('house.survey.noMaterial'),
        ),
        d === null ? '' : esc(f.density(d)),
        shownM3 === null ? '' : esc(f.volume(shownM3)),
        shownM3 === null || tonnesOf(pile, shownM3) === null
          ? ''
          : esc(f.mass(tonnesOf(pile, shownM3) ?? 0)),
        ...(prev
          ? [
              w === null ? '' : esc(f.volume(w)),
              change === null ? '' : esc(f.volume(change)),
              change === null || d === null ? '' : esc(f.mass(change * d)),
            ]
          : []),
      ],
      staleRow ? 'num flag' : 'num',
    );
  });
  rows.push(
    row(
      [
        '',
        `<b>${txt(tk('house.survey.total'))}</b>`,
        txt(tk('vol.view.ofPiles', { n: String(counted.length), count: piles.length })),
        '',
        totalM3 === null ? '' : `<b>${esc(f.volume(totalM3))}</b>`,
        mass === null ? '' : `<b>${esc(f.mass(mass))}</b>`,
        ...(prev
          ? [
              esc(f.volume(prev.totalM3)),
              cur?.change ? `<b>${esc(changeText(cur, f))}</b>` : '',
              massOf(both, cur) !== null && massOf(both, prev) !== null
                ? esc(f.mass((massOf(both, cur) ?? 0) - (massOf(both, prev) ?? 0)))
                : '',
            ]
          : []),
      ],
      'num total',
    ),
  );
  p.table(tableMaker('grid num sv-piles', head), rows);
  // what the total leaves out, and the figures carried over from an earlier version
  const notes: string[] = [];
  if (cur && left.size > 0)
    notes.push(
      tk('house.survey.pile.notCounted', {
        date: longDate(cur.date),
        list: notCountedList(cur, names),
      }),
    );
  for (const pile of piles)
    if (pile.carried) notes.push(`${names.get(pile.id) ?? pile.id}: ${pile.carried}`);
  if (notes.length) p.add(el(`<p class="caption">* ${txt(notes.join('; '))}</p>`));
  if (cur?.partial?.length)
    p.add(
      el(
        `<p class="caption">${txt(
          tk('vol.view.partial', {
            names: cur.partial.map((id) => names.get(id) ?? id).join(', '),
          }),
        )}</p>`,
      ),
    );
  const bases = [...new Set(piles.map((x) => x.carried ?? x.base).filter(Boolean))].join(', ');
  p.add(el(`<p class="caption">${txt(tk('house.survey.pile.basis', { bases }))}</p>`));
  // the materials summary of the piles counted on the latest date
  const order: (string | null)[] = [];
  for (const x of counted) {
    const id = x.material?.id ?? null;
    if (!order.includes(id)) order.push(id);
  }
  if (order.length > 1 || (order.length === 1 && order[0] !== null)) {
    subheading(p, tk('house.survey.byMaterial'));
    const groups = order.map((id) => counted.filter((x) => (x.material?.id ?? null) === id));
    const line = (list: readonly PileOverTime[], label: string, total: boolean) => {
      const common = list.filter((x) => on(prev, x.id) !== null);
      const m = massOf(list, cur);
      const dm = prev ? massOf(common, cur) : null;
      const pm = prev ? massOf(common, prev) : null;
      return row(
        [
          total ? `<b>${txt(label)}</b>` : txt(label),
          esc(String(list.length)),
          esc(f.volume(sumOf(list, cur))),
          m === null ? '' : esc(f.mass(m)),
          ...(prev
            ? [
                common.length > 0 ? esc(f.volume(sumOf(common, cur) - sumOf(common, prev))) : '',
                dm !== null && pm !== null ? esc(f.mass(dm - pm)) : '',
              ]
            : []),
        ],
        total ? 'num total' : 'num',
      );
    };
    p.table(
      tableMaker('grid num sv-mat', [
        tk('house.survey.col.material'),
        tk('house.survey.col.piles'),
        tk('house.survey.col.volume'),
        tk('house.survey.col.tonnes'),
        ...(prev ? [tk('house.survey.col.change'), tk('house.survey.col.changeT')] : []),
      ]),
      [
        ...groups.map((list) =>
          line(list, list[0]?.material?.name ?? tk('house.survey.noMaterial'), false),
        ),
        line(counted, tk('house.survey.total'), true),
      ],
    );
  }
}

// ---------------------------------------------------------------- earthworks

export function layoutEarthworks(p: Pager, ctx: HouseContext, n: string): void {
  const data = ctx.survey;
  if (!data) return;
  const f = formatsOf(data);
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.earthworks'));
  basisBlock(p, data);
  const first = data.earthworks.find((e) => e.first)?.first?.capture;
  if (data.current)
    p.add(
      el(
        `<p class="nar">${txt(
          tk(first ? 'house.survey.ew.intro' : 'house.survey.ew.introOne', {
            date: longDate(data.current.date),
            first: first ? longDate(first.date) : '',
          }),
        )}</p>`,
      ),
    );
  const results = data.earthworks.flatMap((e) => (e.current ? [e.current.result] : []));
  const sum = (k: 'cutM3' | 'fillM3' | 'netM3') => results.reduce((a, r) => a + r[k], 0);
  p.add(
    tiles([
      { value: f.volume(sum('cutM3')), label: tk('house.survey.kpi.cut') },
      { value: f.volume(sum('fillM3')), label: tk('house.survey.kpi.fill') },
      { value: f.volume(sum('netM3')), label: tk('house.survey.kpi.net') },
    ]),
  );
  const rows = data.earthworks.map((e) => {
    const r = e.current?.result ?? null;
    return row(
      [
        `<b>${esc(e.ref)}</b>`,
        `${txt(e.label)}<br><span class="faint small">${txt(e.item)}</span>`,
        txt(e.design),
        r ? esc(f.volume(r.cutM3)) : '',
        r ? esc(f.volume(r.fillM3)) : '',
        r ? esc(f.volume(r.netM3)) : txt(e.reason),
        e.tolerance ? esc(`${f.pct(e.tolerance.share)} (±${f.distance(e.toleranceM)})`) : '',
        e.progress === null ? '' : esc(f.pct(e.progress)),
      ],
      'num',
    );
  });
  rows.push(
    row(
      [
        '',
        `<b>${txt(tk('house.survey.total'))}</b>`,
        '',
        `<b>${esc(f.volume(sum('cutM3')))}</b>`,
        `<b>${esc(f.volume(sum('fillM3')))}</b>`,
        `<b>${esc(f.volume(sum('netM3')))}</b>`,
        '',
        '',
      ],
      'num total',
    ),
  );
  p.table(
    tableMaker('grid num sv-ew', [
      tk('house.survey.col.ref'),
      tk('house.survey.col.area'),
      tk('house.survey.col.design'),
      tk('house.survey.col.cut'),
      tk('house.survey.col.fill'),
      tk('house.survey.col.net'),
      tk('house.survey.col.tolerance'),
      tk('house.survey.col.progress'),
    ]),
    rows,
  );
  p.add(el(`<p class="caption">${txt(tk('house.survey.ew.signs'))}</p>`));
  deadbandNote(p, results, f.distance);
  if (data.sections.length > 0) {
    subheading(p, tk('house.survey.ew.sections'));
    for (const s of data.sections) {
      const series = chartSeries(s.profiles);
      if (!series.some((x) => x.z.filter((z) => z !== null).length >= 2)) continue;
      p.add(figure(markup(profileChart(series, data, 'report-section'))));
      p.add(
        el(
          `<p class="caption">${txt(tk('house.survey.ew.section', { ref: s.ref, label: s.label, length: f.distance(s.lengthM) }))}</p>`,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------- landfill

export function layoutLandfill(p: Pager, ctx: HouseContext, n: string): void {
  const data = ctx.survey;
  if (!data) return;
  const f = formatsOf(data);
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.landfill'));
  basisBlock(p, data);
  p.add(el(`<p class="nar">${txt(tk('house.survey.lf.intro'))}</p>`));
  for (const cell of data.landfill) {
    subheading(p, `${cell.ref} · ${cell.label}`);
    const weighed = cell.lifts.filter((l) => l.densityTPerM3 !== null);
    const mean =
      weighed.length > 0
        ? weighed.reduce((a, l) => a + (l.tonnes ?? 0), 0) /
          weighed.reduce((a, l) => a + (l.volumeM3 ?? 0), 0)
        : null;
    const kpi = [
      {
        value: cell.airspace ? f.volume(cell.airspace.remainingM3) : '-',
        label: tk('house.survey.kpi.airspace'),
      },
      { value: f.volume(cell.usedM3), label: tk('house.survey.kpi.used') },
    ];
    if (cell.tonnes !== null)
      kpi.push({ value: f.mass(cell.tonnes), label: tk('house.survey.kpi.tonnes') });
    if (mean !== null && Number.isFinite(mean))
      kpi.push({ value: f.density(mean), label: tk('house.survey.kpi.compaction') });
    p.add(tiles(kpi));
    p.add(
      el(
        `<p class="caption" data-sv="airspace">${txt(
          cell.airspace
            ? tk('house.survey.lf.airspace', {
                volume: f.volume(cell.airspace.remainingM3),
                design: cell.design,
                date: longDate(cell.airspace.capture.date),
              })
            : tk('house.survey.lf.noAirspace', { reason: cell.airspaceReason }),
        )}</p>`,
      ),
    );
    p.table(
      tableMaker('grid num sv-lifts', [
        tk('house.survey.col.lift'),
        tk('house.survey.col.survey'),
        tk('house.survey.col.volume'),
        tk('house.survey.col.tonnes'),
        tk('house.survey.col.compaction'),
        tk('house.survey.col.note'),
      ]),
      cell.lifts.map((l, i) =>
        row(
          [
            esc(String(i + 1)),
            esc(longDate(l.capture.date)),
            l.volumeM3 === null ? '' : esc(f.volume(l.volumeM3)),
            l.tonnes === null ? '' : esc(f.mass(l.tonnes)),
            l.densityTPerM3 === null ? '' : esc(f.density(l.densityTPerM3)),
            txt(
              l.volumeM3 === null
                ? [statusText(l.status), l.reason].filter(Boolean).join(': ')
                : l.tonnes === null
                  ? tk('house.survey.lf.noWeigh')
                  : '',
            ),
          ],
          'num',
        ),
      ),
    );
  }
  p.add(el(`<p class="caption">${txt(tk('house.survey.lf.method'))}</p>`));
}
