/**
 * The cross-section's chart, surfaces, pins and controls (M11 G5), shown in the dock and in the
 * large window: surfaces to sample, vertical exaggeration, cut and fill shading, the cutaway,
 * sections at the active alignment's stations, pins with elevation, delta and grade, and
 * **Download** as DXF or CSV.
 */
import { formatQuantity } from '@aio/geo';
import type { Grade } from '@aio/survey';
import { Icon } from '@aio/ui';
import { useMemo, useState } from 'react';
import { useDesigns } from './designsStore';
import { useMeasure } from './measureStore';
import { SectionChart, type ChartLine } from './SectionChart';
import {
  addPin,
  colourOf,
  exportSection,
  FORMAT_LABELS,
  leaveStations,
  removePin,
  setCutaway,
  setExaggeration,
  setReference,
  setShade,
  showStation,
  toggleSurface,
  useSection,
  type SectionFormat,
} from './sectionStore';

export function gradeText(g: Grade | null): string {
  if (!g) return 'n/a';
  // below 1 in a million it reads flat (a plane's rounding, not a slope)
  if (Math.abs(g.ratio) < 1e-6) return '0.00° · 0.00% · flat';
  return `${g.degrees.toFixed(2)}° · ${g.percent.toFixed(2)}% · 1:${g.oneIn.toFixed(2)}`;
}

/** The section's chart, surfaces, pins and controls (in the dock and in the window). */
export function SectionBody({ big = false }: { big?: boolean }) {
  const s = useSection((x) => x);
  const settings = useMeasure((m) => m.settings);
  // a package (player mode) shows its sections; writing one out runs a pipeline, which it never does
  const readOnly = useMeasure((m) => m.readOnly);
  const activeAlignment = useDesigns((d) => d.active);
  const [format, setFormat] = useState<SectionFormat>('dxf-2d-xz');
  const lines: ChartLine[] = useMemo(() => {
    const out: ChartLine[] = [];
    s.selected.forEach((key, i) => {
      const p = s.result?.profiles.find((x) => x.surface === key);
      const c = s.choices.find((x) => x.key === key);
      if (p) out.push({ key, label: c?.label ?? p.label, colour: colourOf(i), z: p.z });
    });
    return out;
  }, [s.selected, s.result, s.choices]);
  const d = (v: number) => formatQuantity(v, 'distance', settings.units, settings.precision);
  const label = (key: string) => s.choices.find((c) => c.key === key)?.label ?? key;
  return (
    <div className={`sec-body${big ? ' big' : ''}`}>
      <div className="sec-side">
        <span className="pop-title">Surfaces</span>
        {s.sourcesError && <p className="small danger">{s.sourcesError}</p>}
        {!s.choices.length && !s.sourcesError && (
          <p className="small faint">
            No prepared surfaces or design surfaces yet: prepare the surveys first.
          </p>
        )}
        <ul className="sec-surfaces">
          {s.choices.map((c) => {
            const i = s.selected.indexOf(c.key);
            return (
              <li key={c.key}>
                <label className="pop-row" data-testid={`section-surface-${c.key}`}>
                  <input
                    type="checkbox"
                    checked={i >= 0}
                    onChange={() => {
                      toggleSurface(c.key);
                    }}
                  />
                  <span
                    className="sec-swatch"
                    style={{ background: i >= 0 ? colourOf(i) : 'transparent' }}
                  />
                  <span className="pop-grow">{c.label}</span>
                </label>
              </li>
            );
          })}
        </ul>
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
          <span className="mono">1:{s.exaggeration}</span>
        </label>
        <label className="pop-row">
          <span>Shade</span>
          <select
            className="sv-input"
            data-testid="section-shade"
            value={s.shade ? `${s.shade.from}|${s.shade.to}` : ''}
            onChange={(e) => {
              const [from, to] = e.target.value.split('|');
              setShade(from && to ? { from, to } : null);
            }}
          >
            <option value="">No cut and fill</option>
            {s.selected.flatMap((a) =>
              s.selected
                .filter((b) => b !== a)
                .map((b) => (
                  <option key={`${a}|${b}`} value={`${a}|${b}`}>
                    {label(a)} to {label(b)}
                  </option>
                )),
            )}
          </select>
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
        {s.error && (
          <p className="notice danger small" role="alert">
            <Icon name="warn" size={14} /> {s.error}
          </p>
        )}
        {s.result ? (
          <SectionChart
            result={s.result}
            lines={lines}
            pins={s.pins}
            exaggeration={s.exaggeration}
            shade={s.shade}
            settings={settings}
            onPin={(c) => {
              void addPin(c);
            }}
            testId={big ? 'section-window-chart' : 'section-chart'}
          />
        ) : (
          <p className="small faint sec-empty">
            {s.busy ? 'Sampling the surfaces…' : 'Pick a surface.'}
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
        {!s.pins.length && <p className="small faint">Click the chart to add a pin.</p>}
        {s.pins.map((p, i) => (
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
              {p.values.map((v, k) => (
                <tr key={v.key}>
                  <th scope="row">
                    <span className="sec-swatch" style={{ background: colourOf(k) }} />
                    <button
                      type="button"
                      className={`btn ghost sm${k === p.reference ? ' on' : ''}`}
                      title="Take deltas from this surface"
                      aria-pressed={k === p.reference}
                      onClick={() => {
                        setReference(k);
                      }}
                    >
                      {v.label}
                    </button>
                  </th>
                  <td className="mono" data-testid="section-pin-z">
                    {v.z === null ? 'no data' : d(v.z)}
                  </td>
                  <td className="mono" data-testid="section-pin-delta">
                    {v.delta === null || k === p.reference
                      ? ''
                      : `Δ ${v.delta >= 0 ? '+' : ''}${d(v.delta)}`}
                  </td>
                  <td className="mono small" data-testid="section-pin-grade">
                    {gradeText(v.grade)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {!readOnly && (
          <div className="sec-download">
            <select
              className="sv-input"
              aria-label="Download format"
              data-testid="section-format"
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as SectionFormat);
              }}
            >
              {(Object.keys(FORMAT_LABELS) as SectionFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn sm"
              data-testid="section-download"
              disabled={!s.result || s.exporting?.busy === true}
              onClick={() => {
                void exportSection(format);
              }}
            >
              <Icon name="download" size={12} /> Download
            </button>
          </div>
        )}
        {s.exporting?.note && (
          <p className="small faint" data-testid="section-export-note" role="status">
            {s.exporting.note}
          </p>
        )}
      </div>
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
