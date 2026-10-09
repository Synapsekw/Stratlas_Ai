// The house report's sections drawn from the site's runs (M11): haul-road compliance (G11,
// `aio.haul-run/1`) and hydrology (G10, `aio.hydro-run/1`). Main names the runs as
// `survey:readHaulRuns` and `survey:readHydroRuns` list them (newest first); the page reads their
// `run.json` through its fetch. Like G9's survey sections, each states what its numbers are in
// (CRS, datum, geoid, calibration, units) and formats them with the site's units and precision.
import { formatQuantity } from '@aio/geo';
import { surveyBasis, type SurveyBasis } from '@aio/project/export';
import {
  CALIBRATION_FILE,
  defaultSurveySettings,
  HAUL_DIR,
  HaulRun,
  HYDRO_DIR,
  HYDRO_RUN_FILE,
  HydroRun,
  SiteCalibration,
  SURVEY_SETTINGS_FILE,
  SurveySettings,
  type HaulCheck,
  type HaulStation,
  type ProjectManifest,
  type ReportSectionId,
} from '@aio/schema';
import { t } from '@aio/ui';
import { longDate, num1 } from '../../report/narrativeTemplate';
import { esc } from '../layout';
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
import { basisLines, formats } from './survey';

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

/** Stations listed per haul-road run; the run file has every one. */
export const HAUL_STATIONS_MAX = 300;

/** The runs the `haul` and `hydrology` sections print, with the basis of their numbers. */
export interface SiteRuns {
  basis: SurveyBasis;
  haul: HaulRun[];
  hydro: HydroRun[];
}

interface RunReader {
  json(path: string): Promise<unknown>;
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Read the runs main named (ids, newest first). A run that is missing, does not parse or whose id
 * is not its folder's is left out, as the panels leave it out.
 */
export async function readSiteRuns(
  read: RunReader,
  manifest: ProjectManifest,
  ids: { haul: readonly string[]; hydro: readonly string[] },
): Promise<SiteRuns> {
  const one = async <T extends { id: string }>(
    schema: { safeParse(v: unknown): { success: boolean; data?: T } },
    dir: string,
    id: string,
  ): Promise<T[]> => {
    if (!SAFE.test(id)) return [];
    const r = schema.safeParse(await read.json(`${dir}/${id}/${HYDRO_RUN_FILE}`));
    return r.success && r.data && r.data.id === id ? [r.data] : [];
  };
  const [settingsRaw, calRaw, haul, hydro] = await Promise.all([
    read.json(SURVEY_SETTINGS_FILE),
    read.json(CALIBRATION_FILE),
    Promise.all(ids.haul.map((id) => one<HaulRun>(HaulRun, HAUL_DIR, id))),
    Promise.all(ids.hydro.map((id) => one<HydroRun>(HydroRun, HYDRO_DIR, id))),
  ]);
  const s = SurveySettings.safeParse(settingsRaw);
  const c = SiteCalibration.safeParse(calRaw);
  return {
    basis: surveyBasis(
      s.success ? s.data : defaultSurveySettings(),
      manifest.crs,
      c.success ? c.data : null,
    ),
    haul: haul.flat(),
    hydro: hydro.flat(),
  };
}

/** The run sections that have something to print. */
export function runSectionIds(runs: SiteRuns | null): ReportSectionId[] {
  if (!runs) return [];
  return [
    ...(runs.haul.length > 0 ? (['haul'] as const) : []),
    ...(runs.hydro.length > 0 ? (['hydrology'] as const) : []),
  ];
}

function basisBlock(p: Pager, b: SurveyBasis): void {
  const lines = basisLines(b);
  p.add(el(`<div class="sv-basis">${lines.map((l) => `<span>${txt(l)}</span>`).join('')}</div>`));
}

/** A grade or cross fall stored in percent, shown in the site's grade style (as the panel shows it). */
const gradeText = (b: SurveyBasis) => (v: number | null | undefined) =>
  v === null || v === undefined ? '' : formatQuantity(v / 100, 'grade', b.units, b.precision);

// ---------------------------------------------------------------- haul roads

const CHECKS: readonly HaulCheck[] = [
  'width',
  'grade',
  'crossFall',
  'superelevation',
  'bermLeft',
  'bermRight',
];

const LIMITS = [
  ['minWidthM', 'm'],
  ['maxGradePct', '%'],
  ['crossFallMinPct', '%'],
  ['crossFallMaxPct', '%'],
  ['minBermHeightM', 'm'],
] as const;

/** A station's result: Pass, or Fail with the checks it fails. */
export function stationResult(s: HaulStation): string {
  if (s.status !== 'fail') return tk(`house.haul.status.${s.status}`);
  const failed = CHECKS.filter((c) => s.checks[c] === 'fail').map((c) =>
    tk(`house.haul.check.${c}`),
  );
  return `${tk('house.haul.status.fail')}: ${failed.join(', ')}`;
}

/** The haul-road compliance section: one block per run, newest first. */
export function layoutHaul(p: Pager, ctx: HouseContext, n: string): void {
  const runs = ctx.runs;
  if (!runs || runs.haul.length === 0) return;
  const f = formats(runs.basis);
  const pctText = gradeText(runs.basis);
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.haul'));
  basisBlock(p, runs.basis);
  p.add(el(`<p class="nar">${txt(tk('house.haul.intro'))}</p>`));
  for (const run of runs.haul) {
    subheading(
      p,
      tk('house.haul.run', { name: run.centreline.name, date: longDate(run.computedAt) }),
    );
    const sm = run.summary;
    p.add(
      tiles([
        { value: String(sm.stations), label: tk('house.haul.kpi.stations') },
        { value: String(sm.pass), label: tk('house.haul.kpi.pass') },
        { value: String(sm.fail), label: tk('house.haul.kpi.fail'), color: '#b2182b' },
        { value: String(sm.noData), label: tk('house.haul.kpi.noData') },
      ]),
    );
    p.add(
      el(
        `<p class="caption">${txt(
          tk('house.haul.along', {
            length: f.distance(run.centreline.lengthM),
            interval: f.distance(run.intervalM),
            surface: run.surface.name,
            cell: f.distance(run.surface.cellM),
          }),
        )}</p>`,
      ),
    );

    // the limits used
    const limits = LIMITS.flatMap(([k, unit]) => {
      const v = run.params.limits[k];
      if (v === undefined) return [];
      return [[tk(`house.haul.limit.${k}`), unit === '%' ? pctText(v) : f.distance(v)]];
    });
    p.add(el(`<h3>${txt(tk('house.haul.limits'))}</h3>`), true);
    if (limits.length === 0) p.add(el(`<p class="caption">${txt(tk('house.haul.noLimits'))}</p>`));
    else
      p.table(
        tableMaker('grid sv-haul-limits', [tk('house.haul.col.limit'), tk('house.haul.col.value')]),
        limits.map(([label, value]) => row([txt(label ?? ''), esc(value ?? '')])),
      );

    // where it fails
    p.add(el(`<h3>${txt(tk('house.haul.stretches'))}</h3>`), true);
    if (run.stretches.length === 0)
      p.add(el(`<p class="caption">${txt(tk('house.haul.noStretches'))}</p>`));
    else
      p.table(
        tableMaker('grid num sv-haul-stretches', [
          tk('house.haul.col.check'),
          tk('house.haul.col.from'),
          tk('house.haul.col.to'),
          tk('house.haul.col.length'),
          tk('house.haul.kpi.stations'),
        ]),
        run.stretches.map((s) =>
          row(
            [
              txt(tk(`house.haul.check.${s.check}`)),
              esc(s.fromStation),
              esc(s.toStation),
              esc(f.distance(Math.abs(s.toChainageM - s.fromChainageM))),
              esc(String(s.stations)),
            ],
            'fail',
          ),
        ),
      );

    // every station with pass or fail
    p.add(el(`<h3>${txt(tk('house.haul.stationsTitle'))}</h3>`), true);
    const shown = run.stations.slice(0, HAUL_STATIONS_MAX);
    const d = (v: number | null) => (v === null ? '' : f.distance(v));
    // a berm's crest height; ground that falls away has none
    const berm = (b: HaulStation['bermLeft']) =>
      !b ? '' : b.kind === 'drop' ? tk('house.haul.drop') : d(b.heightM);
    p.table(
      tableMaker('grid num sv-haul-stations', [
        tk('house.haul.col.station'),
        tk('house.haul.col.width'),
        tk('house.haul.col.grade'),
        tk('house.haul.col.crossFall'),
        tk('house.haul.col.super'),
        tk('house.haul.col.berms'),
        tk('house.haul.col.result'),
      ]),
      shown.map((s) =>
        row(
          [
            esc(s.stationLabel),
            esc(d(s.widthM)),
            esc(pctText(s.gradePct)),
            esc([pctText(s.crossFallLeftPct), pctText(s.crossFallRightPct)].join(' / ')),
            esc(pctText(s.superelevationPct)),
            esc([berm(s.bermLeft), berm(s.bermRight)].join(' / ')),
            txt(stationResult(s)),
          ],
          s.status === 'fail' ? 'fail' : '',
        ),
      ),
    );
    if (run.stations.length > shown.length)
      p.add(
        el(
          `<p class="caption">${txt(
            tk('house.haul.more', { n: run.stations.length - shown.length, run: run.id }),
          )}</p>`,
        ),
      );
  }
  p.add(el(`<p class="caption">${txt(tk('house.haul.method'))}</p>`));
}

// ---------------------------------------------------------------- hydrology

/** The hydrology section: one block per run (flood, flow, rainfall), newest first. */
export function layoutHydrology(p: Pager, ctx: HouseContext, n: string): void {
  const runs = ctx.runs;
  if (!runs || runs.hydro.length === 0) return;
  const f = formats(runs.basis);
  heading(p, `${n} · ${tk('house.survey.kicker')}`, tk('house.sec.hydrology'));
  basisBlock(p, runs.basis);
  p.add(el(`<p class="nar">${txt(tk('house.hydro.intro'))}</p>`));
  const flow = (m3s: number) => tk('house.hydro.flowRate', { n: m3s.toFixed(3) });
  for (const run of runs.hydro) {
    const date = longDate(run.computedAt);
    const kind = run.pipeline.slice('hydro.'.length);
    subheading(p, tk(`house.hydro.${kind}`, { date }));
    if (run.preview)
      p.add(
        el(`<p class="notice warn small" data-sv="preview">${txt(tk('house.hydro.preview'))}</p>`),
      );
    if (run.pipeline === 'hydro.flood') {
      const r = run.results;
      p.add(
        tiles([
          { value: f.distance(r.levelM), label: tk('house.hydro.kpi.level') },
          { value: f.area(r.areaM2), label: tk('house.hydro.kpi.area') },
          { value: f.volume(r.volumeM3), label: tk('house.hydro.kpi.volume') },
          { value: f.distance(r.maxDepthM), label: tk('house.hydro.kpi.depth') },
        ]),
      );
      p.add(el(`<p class="caption">${txt(tk(`house.hydro.mode.${r.mode}`))}</p>`));
    } else if (run.pipeline === 'hydro.flow') {
      const r = run.results;
      p.add(
        el(
          `<p class="caption">${txt(
            tk('house.hydro.flowMode', {
              mode: tk(`house.hydro.flowMode.${r.mode}`),
              method: tk(`house.hydro.method.${r.method}`),
              depressions: tk(`house.hydro.depressions.${r.depressions}`),
              cell: f.distance(run.cellM),
            }),
          )}</p>`,
        ),
      );
      if (r.path)
        p.add(
          el(
            `<p class="nar">${txt(
              tk('house.hydro.path', {
                length: f.distance(r.path.lengthM),
                fall: f.distance(r.path.fallM),
                edge: r.path.leavesSurface ? tk('house.hydro.pathEdge') : '',
              }),
            )}</p>`,
          ),
        );
      if (r.outlets && r.outlets.length > 0) {
        p.add(el(`<h3>${txt(tk('house.hydro.catchments'))}</h3>`), true);
        p.table(
          tableMaker('grid num sv-hydro-catchments', [
            tk('house.hydro.col.outlet'),
            tk('house.hydro.col.pour'),
            tk('house.hydro.col.area'),
            tk('house.hydro.col.contributing'),
          ]),
          r.outlets.map((o, i) =>
            row([
              txt(o.outlet ? String(i + 1) : tk('house.hydro.mainOutlet')),
              esc(`${o.pourPoint[0].toFixed(2)}, ${o.pourPoint[1].toFixed(2)}`),
              esc(f.area(o.areaM2)),
              esc(o.contributingAreaM2 === undefined ? '' : f.area(o.contributingAreaM2)),
            ]),
          ),
        );
      }
      if (r.streamLinks !== undefined)
        p.add(
          el(
            `<p class="nar">${txt(
              tk('house.hydro.streams', {
                n: r.streamLinks,
                length: f.distance(r.streamLengthM ?? 0),
                area: f.area(r.streamAreaM2 ?? 0),
              }),
            )}</p>`,
          ),
        );
    } else {
      const r = run.results;
      p.add(
        tiles([
          { value: f.volume(r.rainM3), label: tk('house.hydro.kpi.rain') },
          { value: f.volume(r.outflowM3), label: tk('house.hydro.kpi.outflow') },
          { value: f.volume(r.storedM3), label: tk('house.hydro.kpi.stored') },
          { value: flow(r.peakOutflowM3s), label: tk('house.hydro.kpi.peak') },
        ]),
      );
      p.add(el(`<h3>${txt(tk('house.hydro.rainSummary'))}</h3>`), true);
      const rows: [string, string][] = [
        ['duration', tk('house.hydro.minutes', { n: num1(r.durationMin) })],
        ['area', f.area(r.areaM2)],
        ['rain', f.volume(r.rainM3)],
        ['infiltrated', f.volume(r.infiltratedM3)],
        ['outflow', f.volume(r.outflowM3)],
        ['stored', f.volume(r.storedM3)],
        [
          'peak',
          tk('house.hydro.peakAt', { flow: flow(r.peakOutflowM3s), min: num1(r.peakAtMin) }),
        ],
        ['final', flow(r.finalOutflowM3s)],
        ['depth', f.distance(r.maxDepthM)],
        ['mass', `${r.massErrorPct.toFixed(2)} %`],
      ];
      p.table(
        tableMaker('grid sv-hydro-rain', [
          tk('house.hydro.col.quantity'),
          tk('house.haul.col.value'),
        ]),
        rows.map(([k, v]) => row([txt(tk(`house.hydro.row.${k}`)), esc(v)])),
      );
    }
    p.add(
      el(
        `<p class="caption">${txt(
          tk('house.runs.computed', { date, surface: run.surface.name }),
        )}</p>`,
      ),
    );
    for (const note of run.notes ?? []) p.add(el(`<p class="caption">${txt(note)}</p>`));
  }
  p.add(el(`<p class="caption">${txt(tk('house.runs.stale'))}</p>`));
}
