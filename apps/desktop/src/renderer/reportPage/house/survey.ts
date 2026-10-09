// The house report's survey sections (M11 G9, PRD SRV-13): measurements, earthworks to design,
// the stockpile inventory and landfill airspace and compaction. Each states what its numbers were
// computed and shown with (CRS, vertical datum, geoid, calibration and units) and formats every
// value as the measurement panel does (`@aio/geo` `formatQuantity`, the site's units and
// precision), so the report's totals match the panel. The data comes from `surveyData.ts`.
import { formatQuantity, unitLabel } from '@aio/geo';
import type {
  ComparisonReport,
  InventoryTotal,
  MeasurementReport,
  SectionReport,
  SurveyBasis,
  SurveyReportData,
} from '@aio/project/export';
import type { ComparisonResult } from '@aio/schema';
import { TOOL_LABELS } from '@aio/survey';
import { t } from '@aio/ui';
import { longDate, num1 } from '../../report/narrativeTemplate';
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

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

/** Chart width in CSS pixels: the full page body (182 mm). */
const FULL = 688;

// ---------------------------------------------------------------- formatting

/** The formatters of a site: the panel's units, precision and locale. */
export function formats(b: SurveyBasis) {
  return {
    volume: (m3: number) => formatQuantity(m3, 'volume', b.units, b.precision),
    area: (m2: number) => formatQuantity(m2, 'area', b.units, b.precision),
    distance: (m: number) => formatQuantity(m, 'distance', b.units, b.precision),
    /** Tonnes (mass is SI kilograms in `@aio/geo`). */
    mass: (tonnes: number) => formatQuantity(tonnes * 1000, 'mass', b.units, b.precision),
    density: (tPerM3: number) => formatQuantity(tPerM3, 'density', b.units, 3),
  };
}

const pct = (share: number) => `${num1(share * 100)} %`;

/** What the numbers were computed and shown with, one line each. */
export function basisLines(b: SurveyBasis): string[] {
  const heights =
    b.verticalDatum === 'geoid'
      ? tk('house.survey.basis.heights.geoid', {
          geoid: `${b.geoid ?? ''}${b.verticalCrs ? ` (${b.verticalCrs})` : ''}`,
        })
      : tk(`house.survey.basis.heights.${b.verticalDatum}`);
  const cal = b.calibration
    ? tk('house.survey.basis.cal', {
        name: b.calibration.name,
        h: b.calibration.rmsH === null ? '-' : `${num1(b.calibration.rmsH * 1000)} mm`,
        v: b.calibration.rmsV === null ? '-' : `${num1(b.calibration.rmsV * 1000)} mm`,
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

function basisBlock(p: Pager, data: SurveyReportData): void {
  const lines = basisLines(data.basis);
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

// ---------------------------------------------------------------- the plan

/**
 * The measurements from above, cropped to their extent: polygons, lines and points in the project
 * CRS (east right, north up) with their reference labels, a scale bar and a north arrow.
 */
export function measurementPlan(
  items: readonly Pick<MeasurementReport, 'ref' | 'family' | 'outline'>[],
  label: string,
  size = { width: FULL, height: 340 },
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
  const step = niceStep((maxE - minE) / 5);
  const sy = height - 6;
  const scale = `<g class="scale"><line x1="${ox.toFixed(1)}" y1="${String(sy)}" x2="${(ox + step * k).toFixed(1)}" y2="${String(sy)}"/><text x="${(ox + step * k + 4).toFixed(1)}" y="${String(sy + 3)}">${esc(String(step))} m</text></g>`;
  const north = `<g class="north" transform="translate(${(width - 14).toFixed(1)},16)"><path d="M0,-10 L5,6 L0,3 L-5,6 Z"/><text y="18" text-anchor="middle">N</text></g>`;
  return `<svg class="map" viewBox="0 0 ${String(width)} ${String(height)}" width="100%" role="img" aria-label="${esc(label)}">${shapes}${scale}${north}</svg>`;
}

const PROFILE_COLOURS = ['var(--acc)', '#7a8594', '#b2182b', '#2166ac'];

/** A cross-section: each surface's heights along the line, with a legend. */
export function sectionChart(s: SectionReport, size = { width: FULL, height: 200 }): string {
  const zs = s.profiles.flatMap((p) => p.z.filter((z): z is number => z !== null));
  if (zs.length < 2) return '';
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const span = Math.max(0.5, maxZ - minZ);
  const lo = minZ - span * 0.1;
  const hi = maxZ + span * 0.1;
  const { width, height } = size;
  const left = 44;
  const bottom = 18;
  const legend = 14;
  const X = (c: number) => left + (c / (s.lengthM || 1)) * (width - left - 8);
  const Y = (z: number) => legend + (hi - z) * ((height - bottom - legend) / (hi - lo));
  const lines = s.profiles
    .map((p, i) => {
      let d = '';
      let pen = false;
      p.z.forEach((z, k) => {
        const c = p.chainage[k];
        if (z === null || c === undefined) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${X(c).toFixed(1)},${Y(z).toFixed(1)}`;
        pen = true;
      });
      return `<path d="${d}" fill="none" stroke="${PROFILE_COLOURS[i % PROFILE_COLOURS.length] ?? '#000'}" stroke-width="1.2"/>`;
    })
    .join('');
  const keys = s.profiles
    .map(
      (p, i) =>
        `<g transform="translate(${String(left + i * 170)},6)"><rect width="10" height="3" fill="${PROFILE_COLOURS[i % PROFILE_COLOURS.length] ?? '#000'}"/><text x="14" y="4">${esc(p.label.slice(0, 32))}</text></g>`,
    )
    .join('');
  const z0 = `<text class="ax" x="${String(left - 4)}" y="${Y(maxZ).toFixed(1)}" text-anchor="end">${esc(maxZ.toFixed(2))}</text><text class="ax" x="${String(left - 4)}" y="${Y(minZ).toFixed(1)}" text-anchor="end">${esc(minZ.toFixed(2))}</text>`;
  const c0 = `<text class="ax" x="${String(left)}" y="${String(height - 4)}">0</text><text class="ax" x="${String(width - 8)}" y="${String(height - 4)}" text-anchor="end">${esc(s.lengthM.toFixed(1))} m</text>`;
  return `<svg class="svsec" viewBox="0 0 ${String(width)} ${String(height)}" width="100%" role="img" aria-label="${esc(s.label)}"><line class="axl" x1="${String(left)}" y1="${String(height - bottom)}" x2="${String(width - 8)}" y2="${String(height - bottom)}"/>${lines}${keys}${z0}${c0}</svg>`;
}

// ---------------------------------------------------------------- measurements

/** The readouts of one measurement on one line ("Area 1 234.50 m² · Perimeter 140.000 m"). */
const resultText = (m: MeasurementReport) =>
  m.values
    .filter((v) => v.si !== null && !['cut', 'fill', 'net', 'total', 'vertices'].includes(v.key))
    .slice(0, 4)
    .map((v) => `${v.label} ${v.display}`)
    .join(' · ');

export function layoutMeasurements(p: Pager, ctx: HouseContext, n: string): void {
  const data = ctx.survey;
  if (!data) return;
  const f = formats(data.basis);
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.measurements'));
  basisBlock(p, data);
  const plan = measurementPlan(data.measurements, tk('house.survey.plan'));
  if (plan) {
    subheading(p, tk('house.survey.plan'));
    p.add(el(`<figure class="chartfig">${plan}</figure>`));
    p.add(el(`<p class="caption">${txt(tk('house.survey.planCaption'))}</p>`));
  }
  subheading(p, tk('house.survey.list'));
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
  // the volumes of every comparison, with a totals row of the current results
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

function volumeRow(
  ref: string,
  label: string,
  c: ComparisonReport,
  f: ReturnType<typeof formats>,
): HTMLElement {
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

// ---------------------------------------------------------------- stockpiles

export function layoutStockpiles(p: Pager, ctx: HouseContext, n: string): void {
  const data = ctx.survey;
  if (!data) return;
  const inv = data.stockpiles;
  const f = formats(data.basis);
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.stockpiles'));
  basisBlock(p, data);
  const cur = inv.current;
  const prev = inv.previous;
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
  const t = inv.total;
  const kpi = [
    { value: String(t.piles), label: tk('house.survey.kpi.piles') },
    { value: f.volume(t.currentM3), label: tk('house.survey.kpi.volume') },
  ];
  if (t.tonnes !== null) kpi.push({ value: f.mass(t.tonnes), label: tk('house.survey.kpi.mass') });
  if (t.changeM3 !== null)
    kpi.push({ value: f.volume(t.changeM3), label: tk('house.survey.kpi.change') });
  p.add(tiles(kpi));
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
  const notes: string[] = [];
  const rows = inv.rows.map((r) => {
    const why = [r.current, r.previous]
      .filter((v) => v && v.status !== 'ok')
      .map(
        (v) =>
          `${r.ref} ${longDate(v?.capture.date ?? '')}: ${statusText(v?.status ?? 'missing')}${v?.reason ? `, ${v.reason}` : ''}`,
      );
    notes.push(...why);
    return row(
      [
        `<b>${esc(r.ref)}</b>`,
        `${txt(r.label)}${why.length ? ' *' : ''}`,
        txt(
          r.material
            ? `${r.material.name}${r.material.code ? ` (${r.material.code})` : ''}`
            : tk('house.survey.noMaterial'),
        ),
        r.densityTPerM3 === null ? '' : esc(f.density(r.densityTPerM3)),
        r.currentM3 === null ? '' : esc(f.volume(r.currentM3)),
        r.tonnes === null ? '' : esc(f.mass(r.tonnes)),
        ...(prev
          ? [
              r.previousM3 === null ? '' : esc(f.volume(r.previousM3)),
              r.changeM3 === null ? '' : esc(f.volume(r.changeM3)),
              r.changeTonnes === null ? '' : esc(f.mass(r.changeTonnes)),
            ]
          : []),
      ],
      'num',
    );
  });
  const totalRow = (x: InventoryTotal, label: string) =>
    row(
      [
        '',
        `<b>${txt(label)}</b>`,
        txt(tk('house.survey.nPiles', { count: x.piles, n: String(x.piles) })),
        '',
        `<b>${esc(f.volume(x.currentM3))}</b>`,
        x.tonnes === null ? '' : `<b>${esc(f.mass(x.tonnes))}</b>`,
        ...(prev
          ? [
              x.previousM3 === null ? '' : esc(f.volume(x.previousM3)),
              x.changeM3 === null ? '' : `<b>${esc(f.volume(x.changeM3))}</b>`,
              x.changeTonnes === null ? '' : esc(f.mass(x.changeTonnes)),
            ]
          : []),
      ],
      'num total',
    );
  rows.push(totalRow(t, tk('house.survey.total')));
  p.table(tableMaker('grid num sv-piles', head), rows);
  if (notes.length) p.add(el(`<p class="caption">* ${txt(notes.join('; '))}</p>`));
  const bases = [...new Set(inv.rows.map((r) => r.base))].join(', ');
  p.add(el(`<p class="caption">${txt(tk('house.survey.pile.basis', { bases }))}</p>`));
  if (inv.byMaterial.length > 1 || inv.byMaterial[0]?.material !== null) {
    subheading(p, tk('house.survey.byMaterial'));
    p.table(
      tableMaker('grid num sv-mat', [
        tk('house.survey.col.material'),
        tk('house.survey.col.piles'),
        tk('house.survey.col.volume'),
        tk('house.survey.col.tonnes'),
        ...(prev ? [tk('house.survey.col.change'), tk('house.survey.col.changeT')] : []),
      ]),
      [...inv.byMaterial, t].map((x, i, all) =>
        row(
          [
            i === all.length - 1
              ? `<b>${txt(tk('house.survey.total'))}</b>`
              : txt(x.material === null ? tk('house.survey.noMaterial') : x.name),
            esc(String(x.piles)),
            esc(f.volume(x.currentM3)),
            x.tonnes === null ? '' : esc(f.mass(x.tonnes)),
            ...(prev
              ? [
                  x.changeM3 === null ? '' : esc(f.volume(x.changeM3)),
                  x.changeTonnes === null ? '' : esc(f.mass(x.changeTonnes)),
                ]
              : []),
          ],
          i === all.length - 1 ? 'num total' : 'num',
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- earthworks

export function layoutEarthworks(p: Pager, ctx: HouseContext, n: string): void {
  const data = ctx.survey;
  if (!data) return;
  const f = formats(data.basis);
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
        e.tolerance ? esc(`${pct(e.tolerance.share)} (±${f.distance(e.toleranceM)})`) : '',
        e.progress === null ? '' : esc(pct(e.progress)),
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
      const svg = sectionChart(s);
      if (!svg) continue;
      p.add(el(`<figure class="chartfig">${svg}</figure>`));
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
  const f = formats(data.basis);
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
