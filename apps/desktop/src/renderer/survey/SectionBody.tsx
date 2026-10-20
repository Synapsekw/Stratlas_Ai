/**
 * The cross-section on the shared profile chart (M11 G5; volumetric parity W1), shown in the dock
 * and in the large window: the surfaces as chips (the current survey on by default, any other
 * survey date or design surface added), "Shade vs" one of the shown surfaces, vertical
 * exaggeration, the cutaway, sections at the active alignment's stations, pins with elevation,
 * delta to the shade target and grade, and under the chart PNG, DXF…, CSV and Add to report.
 */
import { formatQuantity } from '@aio/geo';
import { seriesStyle, type ChartSeries, type Grade } from '@aio/survey';
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExportFormatDialog, type ExportChoice } from '../charts/ExportFormatDialog';
import { ProfileChart, ShadeVs, SurfaceChips, type ChipOption } from '../charts';
import { addToReport } from '../report/templateStore';
import { useDesigns } from './designsStore';
import { useMeasure } from './measureStore';
import {
  addPin,
  addSurface,
  currentKey,
  DXF_FORMATS,
  exportSection,
  exportSectionCsv,
  exportSectionPng,
  FORMAT_LABELS,
  leaveStations,
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
} from './sectionStore';

export function gradeText(g: Grade | null): string {
  if (!g) return 'n/a';
  // below 1 in a million it reads flat (a plane's rounding, not a slope)
  if (Math.abs(g.ratio) < 1e-6) return '0.00° · 0.00% · flat';
  return `${g.degrees.toFixed(2)}° · ${g.percent.toFixed(2)}% · 1:${g.oneIn.toFixed(2)}`;
}

const DXF_CHOICES: ExportChoice<SectionFormat>[] = DXF_FORMATS.map((format) => ({
  format,
  label: FORMAT_LABELS[format],
  group: 'DXF',
}));

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

/** The section's chart, surfaces, pins and controls (in the dock and in the window). */
export function SectionBody({ big = false }: { big?: boolean }) {
  const tr = useT();
  const s = useSection((x) => x);
  const settings = useMeasure((m) => m.settings);
  // a package (player mode) shows its sections; writing a DXF runs a pipeline, which it never does
  const readOnly = useMeasure((m) => m.readOnly);
  const manifest = useWorkspace((w) => w.project?.manifest ?? null);
  const activeAlignment = useDesigns((d) => d.active);
  const root = useRef<HTMLDivElement>(null);
  const [dxfOpen, setDxfOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const current = currentKey(s.choices, s.source, manifest);
  const { choices, selected, result, source } = s;
  const all = useMemo(
    () => sectionSeries({ choices, selected, result, source }, manifest),
    [choices, selected, result, source, manifest],
  );
  const hidden = useMemo(() => new Set(s.hidden), [s.hidden]);
  const visible = useMemo(() => all.filter((x) => !hidden.has(x.key)), [all, hidden]);
  const currentShown = visible.some((x) => x.kind === 'current');
  const shadeTargets = currentShown
    ? visible.filter((x) => x.kind !== 'current').map((x) => ({ key: x.key, label: x.label }))
    : [];

  const chip = (key: string): ChipOption | null => {
    const c = s.choices.find((x) => x.key === key);
    if (!c) return null;
    return {
      key,
      label: c.label,
      kind: key === current ? 'current' : c.kind === 'design' ? 'design' : 'earlier',
      group: c.kind,
      ...(c.date ? { date: c.date } : {}),
    };
  };
  const shown = s.selected.flatMap((k) => chip(k) ?? []);
  const addable = s.choices.flatMap((c) => (s.selected.includes(c.key) ? [] : (chip(c.key) ?? [])));

  // pins draw and list the shown surfaces only
  const pins = useMemo(
    () => s.pins.map((p) => ({ ...p, values: p.values.filter((v) => !hidden.has(v.key)) })),
    [s.pins, hidden],
  );

  const d = (v: number) => formatQuantity(v, 'distance', settings.units, settings.precision);
  const signed = (v: number) => `${v > 0 && d(v) !== d(0) ? '+' : ''}${d(v)}`;
  const measureId = s.source?.kind === 'measurement' ? s.source.id : undefined;
  const busy = s.exporting?.busy === true;
  const note = said ?? s.exporting?.note ?? null;
  const svg = () => root.current?.querySelector<SVGSVGElement>('svg.pc-svg') ?? null;
  const reportBlocked = readOnly
    ? t('actions.reason.package')
    : !measureId
      ? 'Save the section as a measurement to add it to the report.'
      : false;

  const actions = (
    <>
      <button
        type="button"
        className="btn sm"
        data-testid="section-png"
        disabled={!visible.length || busy}
        onClick={() => {
          setSaid(null);
          const el = svg();
          if (el) void exportSectionPng(el);
        }}
      >
        <Icon name="download" size={12} /> {tr('chart.png')}
      </button>
      <button
        type="button"
        className="btn sm"
        data-testid="section-dxf"
        aria-haspopup="dialog"
        disabled={readOnly || !s.result || busy}
        title={readOnly ? t('actions.reason.package') : undefined}
        onClick={() => {
          setSaid(null);
          setDxfOpen(true);
        }}
      >
        <Icon name="download" size={12} /> {`${tr('chart.dxf')}…`}
      </button>
      <button
        type="button"
        className="btn sm"
        data-testid="section-csv"
        disabled={!visible.length || busy}
        onClick={() => {
          setSaid(null);
          void exportSectionCsv(visible, settings.units, settings.precision);
        }}
      >
        <Icon name="download" size={12} /> {tr('chart.csv')}
      </button>
      <button
        type="button"
        className="btn sm"
        data-testid="section-add-to-report"
        disabled={reportBlocked !== false}
        title={reportBlocked || undefined}
        onClick={() => {
          if (!measureId) return;
          void addToReport(measureId).then(
            (r) => {
              setSaid(t(r === 'added' ? 'report.added' : 'report.already'));
            },
            (e: unknown) => {
              setSaid(e instanceof Error ? e.message : String(e));
            },
          );
        }}
      >
        <Icon name="report" size={12} /> {tr('chart.addToReport')}
      </button>
    </>
  );

  return (
    <div ref={root} className={`sec-body${big ? ' big' : ''}`} data-measure-id={measureId}>
      <div className="sec-side">
        {s.sourcesError && <p className="small danger">{s.sourcesError}</p>}
        {!s.choices.length && !s.sourcesError && (
          <p className="small faint">
            No prepared surfaces or design surfaces yet: prepare the surveys first.
          </p>
        )}
        {s.result?.missing.map((m) => (
          <p key={m.key} className="small danger">
            {m.label}: {m.reason}
          </p>
        ))}
        <label className="pop-row">
          <span>Exaggeration</span>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={s.exaggeration}
            aria-label="Vertical exaggeration"
            data-testid="section-exaggeration"
            onChange={(e) => {
              setExaggeration(Number(e.target.value));
            }}
          />
          <span className="mono">{`${String(s.exaggeration)}:1`}</span>
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
        {activeAlignment && <StationControls />}
      </div>
      <div className="sec-main">
        <div className="pc-head">
          <SurfaceChips
            shown={shown}
            off={hidden}
            addable={addable}
            onToggle={toggleShown}
            onAdd={(key) => {
              const c = s.choices.find((x) => x.key === key);
              if (c) addSurface(c.ref);
            }}
            onRemove={removeSurface}
            testId="section-chips"
          />
          <ShadeVs targets={shadeTargets} value={s.shadeVs} onChange={setShadeVs} />
        </div>
        {s.error && (
          <p className="notice danger small" role="alert">
            <Icon name="warn" size={14} /> {s.error}
          </p>
        )}
        {s.result && visible.length ? (
          <ProfileChart
            series={visible}
            shadeVs={s.shadeVs}
            exaggeration={s.exaggeration}
            ends={{ a: 'A', b: 'B' }}
            units={settings.units}
            precision={settings.precision}
            {...(settings.angles ? { angles: settings.angles } : {})}
            pins={pins}
            onPin={(c) => {
              void addPin(c);
            }}
            testId={big ? 'section-window-chart' : 'section-chart'}
            actions={actions}
          />
        ) : (
          <p className="small faint sec-empty">
            {s.busy
              ? 'Sampling the surfaces…'
              : s.selected.length
                ? 'Switch a surface on to draw it.'
                : 'Add a survey or design to draw the section.'}
          </p>
        )}
        <p className="small faint">
          {s.result
            ? `${d(s.result.length)} long, sampled every ${d(s.result.stepM)}. Click the chart to pin a chainage.`
            : ''}
        </p>
      </div>
      <div className="sec-pins">
        <span className="pop-title">Pins</span>
        {!pins.length && <p className="small faint">Click the chart to add a pin.</p>}
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
                      {gradeText(v.grade)}
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
              ? 'Pick a surface under Shade vs to see each line’s difference from it.'
              : `Δ from ${all.find((x) => x.key === s.shadeVs)?.label ?? ''}.`}
          </p>
        )}
        {note && (
          <p className="small faint" data-testid="section-export-note" role="status">
            {note}
          </p>
        )}
      </div>
      {/* on the body: the dock is transformed, which would hold a fixed scrim inside it */}
      {dxfOpen &&
        createPortal(
          <ExportFormatDialog
            title="Export the cross-section"
            choices={DXF_CHOICES}
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
      <span className="pop-title">Stations of the active alignment</span>
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
