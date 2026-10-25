/**
 * The cross-section on the shared profile chart (M11 G5; volumetric parity W1), shown in the dock
 * and in the large window: the surfaces as chips (the current survey on by default, any other
 * survey date or design surface added), "Shade vs" one of the shown surfaces, vertical
 * exaggeration, the cutaway, sections at the active alignment's stations, pins with elevation,
 * delta to the shade target and grade, and under the chart PNG, DXF…, CSV and Add to report.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { formatQuantity, localeOf } from '@aio/geo';
import {
  DEFAULT_ANGLES,
  type AngleSettings,
  type SurveyMeasurement,
  type SurveyPrecision,
  type SurveyUnits,
} from '@aio/schema';
import { formatAngle, seriesStyle, shadeTargets, type ChartSeries, type Grade } from '@aio/survey';
import { Button, Icon, makeActionCtx, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProfileChart, ShadeVs, SurfaceChips, type ChipOption } from '../charts';
import { chartPng, savePng } from '../charts/exportChart';
import { ExportFormatDialog, type ExportChoice } from '../charts/ExportFormatDialog';
import { addToReport } from '../report/templateStore';
import { useShell } from '../shell';
import { measureEditBlocked } from '../shell/actions/measureActions';
import { useDesigns } from './designsStore';
import { useLinkedHover } from './linkedHover';
import { fileBase } from './exportHelpers';
import { useMeasure } from './measureStore';
import { isPile } from './pile/openPile';
import {
  addPin,
  addSurface,
  currentKey,
  DXF_FORMATS,
  exportSection,
  exportSectionCsv,
  FORMAT_LABELS,
  kindOf,
  leaveStations,
  noteExport,
  removePin,
  removeSurface,
  sectionSeries,
  setCutaway,
  setExaggeration,
  setShadeVs,
  showStation,
  toggleShown,
  useSection,
  type SectionFormat,
  type SectionSource,
} from './sectionStore';
import { useLinkedChart } from './useLinkedChart';

/**
 * Sections at the active alignment's stations are a road's: offered while an alignment is active,
 * but never on a pile's section (the profile line across it, opened from the pile panel), where
 * they mean nothing.
 */
export function offersStations(
  alignmentActive: boolean,
  source: SectionSource | null,
  measurements: readonly Pick<SurveyMeasurement, 'id' | 'tool' | 'family'>[],
): boolean {
  if (!alignmentActive) return false;
  if (source?.kind !== 'measurement') return true;
  const m = measurements.find((x) => x.id === source.id);
  return !m || !isPile(m);
}

/** Below this a grade reads flat (a plane's rounding, not a slope). */
const FLAT = 1e-6;

/**
 * A pin's grade as the site settings write it: the angle in the angle unit (`formatAngle`), the
 * percent and the 1:n ratio in the site grade precision.
 */
export function pinGradeText(
  g: Grade | null,
  units: SurveyUnits,
  precision: SurveyPrecision,
  angles: AngleSettings = DEFAULT_ANGLES,
): string {
  if (!g) return '-';
  const flat = Math.abs(g.ratio) < FLAT;
  const ratio = flat ? 0 : g.ratio;
  const deg = flat ? 0 : g.degrees;
  const as = (style: SurveyUnits['grade']) =>
    formatQuantity(ratio, 'grade', { ...units, grade: style }, precision);
  return [
    formatAngle(deg, angles, localeOf(units.distance)),
    as('percent'),
    flat ? t('section.flat') : as('ratio-1-n'),
  ].join(' · ');
}

/** The DXF variants for the export dialog, named in the current language. */
const dxfChoices = (): ExportChoice<SectionFormat>[] =>
  DXF_FORMATS.map((format) => ({ format, label: t(FORMAT_LABELS[format]), group: 'DXF' }));

/** A short line sample in a series' stroke, the chips' legend look, for the pin tables. */
function LineKey({ series, all }: { series: ChartSeries; all: readonly ChartSeries[] }) {
  const st = seriesStyle(series, all);
  return (
    <svg className="pc-swatch" viewBox="0 0 16 8" aria-hidden="true">
      <line
        x1={1}
        x2={15}
        y1={4}
        y2={4}
        stroke={st.stroke}
        strokeWidth={st.width + 0.5}
        strokeOpacity={st.opacity}
        strokeDasharray={st.dash || undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The section's chart, surfaces, pins and controls (in the dock and in the window). */
export function SectionBody({ big = false }: { big?: boolean }) {
  const tr = useT();
  const s = useSection((x) => x);
  const settings = useMeasure((m) => m.settings);
  // a package (player mode) shows its sections; writing a DXF runs a pipeline, which it never does
  const readOnly = useMeasure((m) => m.readOnly);
  const pkg = useShell((x) => x.pkg);
  const lookOnly = useAnnotateReadOnly();
  const manifest = useWorkspace((w) => w.project?.manifest ?? null);
  const activeAlignment = useDesigns((d) => d.active);
  const measurements = useMeasure((m) => m.file.measurements);
  const root = useRef<HTMLDivElement>(null);
  const [dxfOpen, setDxfOpen] = useState(false);

  const { choices, selected, result, source } = s;
  const current = useMemo(() => {
    const key = currentKey(choices, source, manifest);
    return choices.find((c) => c.key === key) ?? null;
  }, [choices, source, manifest]);
  const all = useMemo(
    () => sectionSeries({ choices, selected, result, source }, manifest),
    [choices, selected, result, source, manifest],
  );
  const hidden = useMemo(() => new Set(s.hidden), [s.hidden]);
  const visible = useMemo(() => all.filter((x) => !hidden.has(x.key)), [all, hidden]);
  // the chart and the section line in 3D and on the map share one point (spec section 4); the
  // dock and the window show one body at a time, both under the key 'section'
  const linked = useLinkedChart('section', s.line, visible);
  // "Add pin here" pins the section at the point the readout shows: the pin, else the hover
  const here = useLinkedHover((h) =>
    h.pin?.key === 'section'
      ? h.pin.chainageM
      : h.hover?.key === 'section'
        ? h.hover.chainageM
        : null,
  );
  // shading is against the current survey, so with it off there is nothing to shade
  const targets = visible.some((x) => x.kind === 'current') ? shadeTargets(visible) : [];

  const chip = (key: string): ChipOption | null => {
    const c = choices.find((x) => x.key === key);
    if (!c) return null;
    return {
      key,
      label: c.label,
      kind: kindOf(c, current),
      group: c.kind,
      ...(c.date ? { date: c.date } : {}),
    };
  };
  const shown = selected.flatMap((k) => chip(k) ?? []);
  const addable = choices.flatMap((c) => (selected.includes(c.key) ? [] : (chip(c.key) ?? [])));

  // pins draw and list the shown surfaces only
  const pins = useMemo(
    () => s.pins.map((p) => ({ ...p, values: p.values.filter((v) => !hidden.has(v.key)) })),
    [s.pins, hidden],
  );

  const d = (v: number) => formatQuantity(v, 'distance', settings.units, settings.precision);
  const signed = (v: number) => `${v > 0 && d(v) !== d(0) ? '+' : ''}${d(v)}`;
  const grade = (g: Grade | null) =>
    pinGradeText(g, settings.units, settings.precision, settings.angles);
  const measureId = source?.kind === 'measurement' ? source.id : undefined;
  const busy = s.exporting?.busy === true;
  const empty = visible.length ? undefined : t('section.showOne');
  const dxfBlocked = readOnly || pkg ? t('actions.reason.package') : empty;
  const reportBlocked = !measureId
    ? t('section.reportHint')
    : manifest
      ? measureEditBlocked(
          makeActionCtx({ manifest, pkg: !!pkg, canEdit: !pkg && !lookOnly && !readOnly }),
        ) || undefined
      : t('report.noProject');

  /**
   * The chart this toolbar sits under as a PNG: this body's own chart, never a lookup by
   * measurement id, which could find another card or the other body (the dock and the window).
   */
  const savePicture = async () => {
    try {
      const svg = root.current?.querySelector<SVGSVGElement>('svg.pc-svg');
      if (!svg) throw new Error(t('chart.exportFailed'));
      const path = await savePng(
        await chartPng(svg),
        `${fileBase(source?.label ?? 'section')}.png`,
      );
      noteExport('png', path ? t('section.saved', { path }) : null);
    } catch (e) {
      noteExport('png', message(e));
    }
  };

  const actions = (
    <>
      <Button
        icon="download"
        data-testid="section-png"
        disabledReason={empty}
        disabled={busy}
        onClick={() => {
          void savePicture();
        }}
      >
        {tr('chart.png')}
      </Button>
      <Button
        icon="download"
        data-testid="section-dxf"
        aria-haspopup="dialog"
        disabledReason={dxfBlocked}
        disabled={busy}
        onClick={() => {
          setDxfOpen(true);
        }}
      >
        {`${tr('chart.dxf')}…`}
      </Button>
      <Button
        icon="download"
        data-testid="section-csv"
        disabledReason={empty}
        disabled={busy}
        onClick={() => {
          void exportSectionCsv(visible, settings.units, settings.precision);
        }}
      >
        {tr('chart.csv')}
      </Button>
      <Button
        icon="report"
        data-testid="section-add-to-report"
        disabledReason={reportBlocked}
        onClick={() => {
          if (!measureId) return;
          void addToReport(measureId).then(
            (r) => {
              noteExport('report', t(r === 'added' ? 'report.added' : 'report.already'));
            },
            (e: unknown) => {
              noteExport('report', message(e));
            },
          );
        }}
      >
        {tr('chart.addToReport')}
      </Button>
    </>
  );

  const body = (
    <div ref={root} className={`sec-body${big ? ' big' : ''}`} data-measure-id={measureId}>
      <div className="sec-side">
        {s.sourcesError && <p className="small danger">{s.sourcesError}</p>}
        {!choices.length && !s.sourcesError && (
          <p className="small faint">
            No prepared surfaces or design surfaces yet: prepare the surveys first.
          </p>
        )}
        {result?.missing.map((m) => (
          <p key={m.key} className="small danger">
            {m.label}: {m.reason}
          </p>
        ))}
        <label className="pop-row">
          <span>{tr('section.exaggeration')}</span>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={s.exaggeration}
            aria-label={tr('section.exaggerationLabel')}
            data-testid="section-exaggeration"
            onChange={(e) => {
              setExaggeration(Number(e.target.value));
            }}
          />
          <span className="mono">
            {tr('section.exaggerationValue', { n: String(s.exaggeration) })}
          </span>
        </label>
        <label className="pop-row">
          <span className="pop-grow">Enable cutaway</span>
          <input
            type="checkbox"
            data-testid="section-cutaway"
            checked={s.cutaway}
            onChange={(e) => {
              setCutaway(e.target.checked);
            }}
          />
        </label>
        {offersStations(activeAlignment !== null, source, measurements) && <StationControls />}
      </div>
      <div className="sec-main">
        <div className="pc-head">
          <SurfaceChips
            shown={shown}
            off={hidden}
            addable={addable}
            onToggle={toggleShown}
            onAdd={(key) => {
              const c = choices.find((x) => x.key === key);
              if (c) addSurface(c.ref);
            }}
            onRemove={removeSurface}
            testId="section-chips"
          />
          <ShadeVs targets={targets} value={s.shadeVs} onChange={setShadeVs} />
        </div>
        {s.error && (
          <p className="notice danger small" role="alert">
            <Icon name="warn" size={14} /> {s.error}
          </p>
        )}
        {result && visible.length ? (
          <ProfileChart
            series={visible}
            shadeVs={s.shadeVs}
            exaggeration={s.exaggeration}
            ends={{ a: 'A', b: 'B' }}
            units={settings.units}
            precision={settings.precision}
            locale={settings.locale ?? localeOf(settings.units.distance)}
            {...(settings.angles ? { angles: settings.angles } : {})}
            pins={pins}
            {...linked}
            readoutAction={
              <Button
                icon="pin"
                data-testid="section-add-pin"
                disabled={here === null}
                onClick={() => {
                  if (here !== null) void addPin(here);
                }}
              >
                {tr('section.addPinHere')}
              </Button>
            }
            testId={big ? 'section-window-chart' : 'section-chart'}
            {...(big ? {} : { actions })}
          />
        ) : (
          <p className="small faint sec-empty">
            {s.busy
              ? tr('section.sampling')
              : selected.length
                ? tr('section.switchOn')
                : tr('section.addSurface')}
          </p>
        )}
        <p className="small faint">
          {result ? `${d(result.length)} long, sampled every ${d(result.stepM)}.` : ''}
        </p>
        {result && visible.length > 0 && (
          <p className="small faint" data-testid="hover-footer">
            {tr('hover.footer')}
          </p>
        )}
      </div>
      <div className="sec-pins">
        <span className="caps faint">Pins</span>
        {!pins.length && <p className="small faint">{tr('section.addPinHint')}</p>}
        {pins.map((p, i) => (
          <table
            key={`${String(p.chainage)}-${String(i)}`}
            className="sv-readout sec-pin-table"
            data-testid="section-pin"
          >
            <caption>
              <span className="mono">Ch {d(p.chainage)}</span>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Remove the pin at ${d(p.chainage)}`}
                onClick={() => {
                  removePin(i);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </caption>
            <tbody>
              {p.values.map((v) => {
                const series = visible.find((x) => x.key === v.key);
                const isRef = s.shadeVs === null || v.key === s.shadeVs;
                return (
                  <tr key={v.key} data-reference={v.key === s.shadeVs ? '' : undefined}>
                    <th scope="row">
                      {series && <LineKey series={series} all={visible} />}
                      <span>{series?.label ?? v.label}</span>
                    </th>
                    <td className="mono" data-testid="section-pin-z">
                      {v.z === null ? 'no data' : d(v.z)}
                    </td>
                    <td className="mono" data-testid="section-pin-delta">
                      {v.delta === null || isRef ? '' : `Δ ${signed(v.delta)}`}
                    </td>
                    <td className="mono small" data-testid="section-pin-grade">
                      {grade(v.grade)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
        {pins.length > 0 && (
          <p className="small faint">
            {s.shadeVs === null
              ? tr('section.pickShade')
              : tr('section.deltaFrom', {
                  name: all.find((x) => x.key === s.shadeVs)?.label ?? '',
                })}
          </p>
        )}
        {s.exporting?.note && (
          <p className="small faint" data-testid="section-export-note" role="status">
            {s.exporting.note}
          </p>
        )}
      </div>
      {/* on the body: the dock is transformed, which would hold a fixed scrim inside it */}
      {dxfOpen &&
        createPortal(
          <ExportFormatDialog
            title={tr('section.exportTitle')}
            choices={dxfChoices()}
            initial="dxf-2d-xz"
            onExport={(f) => {
              setDxfOpen(false);
              void exportSection(f);
            }}
            onClose={() => {
              setDxfOpen(false);
            }}
          />,
          document.body,
        )}
    </div>
  );
  // the window keeps the exports in its footer, always in view while its body scrolls; the dock
  // sets them under the chart
  return big ? (
    <>
      {body}
      <footer className="sec-foot" data-testid="section-window-actions">
        {actions}
      </footer>
    </>
  ) : (
    body
  );
}

function StationControls() {
  const st = useSection((s) => s.stations);
  const [interval, setInterval] = useState(st?.intervalM ?? 20);
  const [left, setLeft] = useState(st?.leftM ?? 15);
  const [right, setRight] = useState(st?.rightM ?? 15);
  const go = (index: number) => {
    showStation({ intervalM: interval, leftM: left, rightM: right, index });
  };
  const num = (v: string, f: (n: number) => void) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) f(n);
  };
  return (
    <div className="sec-stations" role="group" aria-label="Sections at stations">
      <span className="caps faint">Stations of the active alignment</span>
      <div className="sv-row">
        <label className="sv-field">
          <span>Every (m)</span>
          <input
            className="sv-input"
            type="number"
            min={0.1}
            value={interval}
            onChange={(e) => {
              num(e.target.value, setInterval);
            }}
          />
        </label>
        <label className="sv-field">
          <span>Left (m)</span>
          <input
            className="sv-input"
            type="number"
            min={0.1}
            value={left}
            onChange={(e) => {
              num(e.target.value, setLeft);
            }}
          />
        </label>
        <label className="sv-field">
          <span>Right (m)</span>
          <input
            className="sv-input"
            type="number"
            min={0.1}
            value={right}
            onChange={(e) => {
              num(e.target.value, setRight);
            }}
          />
        </label>
      </div>
      <div className="sv-row">
        <button
          type="button"
          className="btn sm"
          disabled={!st || st.index <= 0}
          onClick={() => {
            go((st?.index ?? 1) - 1);
          }}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn sm"
          data-testid="section-stations"
          onClick={() => {
            go(st ? st.index : 0);
          }}
        >
          {st ? 'Apply' : 'Section at stations'}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={!st}
          onClick={() => {
            go((st?.index ?? -1) + 1);
          }}
        >
          Next
        </button>
        {st && (
          <button type="button" className="btn ghost sm" onClick={leaveStations}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
