/**
 * One measurement's properties (M11 G3): its readouts in its units, template (changeable), custom
 * fields, style and labels, units override, scope (site or one survey: promote, demote, copy to
 * another survey), vertices (drag in the 3D view, or type coordinates); a polygon's comparison
 * items and calculators are G4's (`Comparison.tsx`, `Calculators.tsx`).
 */
import { formatQuantity, unitLabel } from '@aio/geo';
import type { MeasurementStyle, SurveyMeasurement } from '@aio/schema';
import {
  changeTemplate,
  effectiveUnits,
  formatRow,
  horizontalDistance,
  measurementReadout,
  TOOL_LABELS,
  vertexTable,
  formatBearing,
} from '@aio/survey';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import {
  copyToSurvey,
  deleteMeasurements,
  editEvent,
  openDialog,
  patchMeasurement,
  replaceMeasurement,
  select,
  setScope,
  startEditing,
  stopEditing,
  updateMeasurement,
  useMeasure,
} from './measureStore';
import { Calculators } from './Calculators';
import { Comparisons } from './Comparison';
import { MEASURE_COLOR } from './measureScene';

const MAX_VERTEX_ROWS = 50;

export function MeasurementPanel() {
  const focus = useMeasure((s) => s.focus);
  const m = useMeasure((s) => s.file.measurements.find((x) => x.id === s.focus) ?? null);
  const readOnly = useMeasure((s) => s.readOnly);
  const settings = useMeasure((s) => s.settings);
  const templates = useMeasure((s) => s.templates);
  const surface = useMeasure((s) => s.surface);
  const editing = useMeasure((s) => s.editing);
  const captures = useWorkspace((s) => s.project?.manifest.captures ?? []);
  const [copyTo, setCopyTo] = useState('');

  const all = useMemo(
    () => [...(templates.project?.templates ?? []), ...templates.user.templates],
    [templates],
  );
  const tpl = m?.template ? all.find((t) => t.id === m.template) : undefined;
  const units = effectiveUnits(settings.units, m?.units);
  const rows = useMemo(() => {
    if (!m) return [];
    // the 3D view's terrain as the surface, sampled at a step that keeps the panel quick
    const len = m.points.reduce(
      (s, p, i) => s + (i > 0 && m.points[i - 1] ? horizontalDistance(m.points[i - 1] ?? p, p) : 0),
      0,
    );
    const stepM = m.family === 'polygon' ? Math.max(0.5, len / 60) : Math.max(0.25, len / 400);
    return measurementReadout(m, { surface: surface ?? undefined, stepM }, tpl?.items);
  }, [m, surface, tpl]);

  if (!m || !focus) return null;
  const family = all.filter((t) => t.family === m.family);
  const ro = readOnly;
  const setStyle = (patch: Partial<MeasurementStyle>) => {
    patchMeasurement(m.id, { style: { color: MEASURE_COLOR, ...(m.style ?? {}), ...patch } });
  };
  const capture = m.scope.kind === 'survey' ? m.scope.capture : null;

  return (
    <section
      className="sv-card sv-panel"
      aria-label={`Measurement ${m.label}`}
      data-testid="survey-panel"
    >
      <header className="sv-head" role="none">
        <input
          className="sv-input sv-title"
          aria-label="Measurement name"
          value={m.label}
          readOnly={ro}
          data-testid="survey-label"
          onChange={(e) => {
            if (e.target.value.trim())
              patchMeasurement(m.id, { label: e.target.value.slice(0, 200) });
          }}
        />
        <button
          type="button"
          className="btn ghost sm"
          aria-label="Close the measurement"
          onClick={() => {
            stopEditing();
            select([], null);
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      <p className="small faint">
        {tpl ? `${tpl.name} · ` : ''}
        {TOOL_LABELS[m.tool]}
        {m.createdBy ? ` · by ${m.createdBy}` : ''}
      </p>

      <table className="sv-readout" data-testid="survey-readout">
        <caption className="sr-only">Results</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-key={r.key}>
              <th scope="row">{r.label}</th>
              <td className="mono">{formatRow(r, units, settings.precision)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {m.tool === 'vertex-table' && <VertexTable m={m} />}

      <details className="sv-sec" open>
        <summary>Details</summary>
        <label className="sv-field">
          <span>Template</span>
          <select
            className="sv-input"
            value={m.template ?? ''}
            disabled={ro}
            data-testid="survey-template"
            onChange={(e) => {
              const next = changeTemplate(
                m,
                family.find((t) => t.id === e.target.value) ?? null,
                new Date().toISOString(),
              );
              if (next) replaceMeasurement(next);
            }}
          >
            <option value="">None ({TOOL_LABELS[m.tool]})</option>
            {family.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="sv-field">
          <span>Folder</span>
          <input
            className="sv-input"
            value={m.folder ?? ''}
            readOnly={ro}
            onChange={(e) => {
              const folder = e.target.value.slice(0, 200);
              updateMeasurement(m.id, (x) => {
                const next = { ...x };
                if (folder) next.folder = folder;
                else delete next.folder;
                return next;
              });
            }}
          />
        </label>
        <label className="sv-field">
          <span>Description</span>
          <textarea
            className="sv-input"
            rows={2}
            value={m.description ?? ''}
            readOnly={ro}
            onChange={(e) => {
              const d = e.target.value.slice(0, 4000);
              updateMeasurement(m.id, (x) => {
                const next = { ...x };
                if (d) next.description = d;
                else delete next.description;
                return next;
              });
            }}
          />
        </label>
        {tpl && tpl.fields.length > 0 && (
          <fieldset className="sv-fields" disabled={ro}>
            <legend>{tpl.name} fields</legend>
            {tpl.fields.map((f) => {
              const v = m.fields?.[f.id];
              const set = (value: string | number | null) => {
                updateMeasurement(m.id, (x) => {
                  const fields = Object.fromEntries(
                    Object.entries(x.fields ?? {}).filter(([k]) => k !== f.id),
                  );
                  if (value !== null && value !== '') fields[f.id] = value;
                  const next: SurveyMeasurement = { ...x, fields };
                  if (Object.keys(fields).length === 0) delete next.fields;
                  return next;
                });
              };
              return (
                <label key={f.id} className="sv-field">
                  <span>{f.name}</span>
                  {f.type === 'dropdown' ? (
                    <select
                      className="sv-input"
                      value={v === undefined ? '' : String(v)}
                      data-testid={`survey-field-${f.id}`}
                      onChange={(e) => {
                        set(e.target.value || null);
                      }}
                    >
                      <option value="">Not set</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="sv-input"
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={v === undefined ? '' : String(v)}
                      data-testid={`survey-field-${f.id}`}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (f.type === 'number') {
                          const n = Number(raw);
                          set(raw === '' || !Number.isFinite(n) ? null : n);
                        } else set(raw.slice(0, 1000));
                      }}
                    />
                  )}
                </label>
              );
            })}
          </fieldset>
        )}
      </details>

      <details className="sv-sec">
        <summary>Style and label</summary>
        <fieldset className="sv-grid" disabled={ro}>
          <label className="sv-field">
            <span>Colour</span>
            <input
              type="color"
              value={m.style?.color ?? MEASURE_COLOR}
              onChange={(e) => {
                setStyle({ color: e.target.value });
              }}
            />
          </label>
          <label className="sv-field">
            <span>Fill</span>
            <input
              type="color"
              value={m.style?.fill ?? m.style?.color ?? MEASURE_COLOR}
              onChange={(e) => {
                setStyle({ fill: e.target.value });
              }}
            />
          </label>
          <label className="sv-field">
            <span>Fill opacity</span>
            <input
              type="number"
              className="sv-input"
              min={0}
              max={1}
              step={0.05}
              value={m.style?.fillOpacity ?? 0.2}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 0 && v <= 1) setStyle({ fillOpacity: v });
              }}
            />
          </label>
          <label className="sv-field">
            <span>Border width</span>
            <input
              type="number"
              className="sv-input"
              min={0}
              max={20}
              value={m.style?.borderWidth ?? 2}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 0 && v <= 20) setStyle({ borderWidth: v });
              }}
            />
          </label>
          <label className="sv-field">
            <span>Label size</span>
            <input
              type="number"
              className="sv-input"
              min={6}
              max={48}
              value={m.style?.labelSize ?? 12}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 6 && v <= 48) setStyle({ labelSize: v });
              }}
            />
          </label>
          <label className="sv-check">
            <input
              type="checkbox"
              checked={m.style?.labelOnlyWhenSelected === true}
              onChange={(e) => {
                setStyle({ labelOnlyWhenSelected: e.target.checked });
              }}
            />
            Label only when selected
          </label>
          <label className="sv-check">
            <input
              type="checkbox"
              checked={m.style?.showPropertyName === true}
              onChange={(e) => {
                setStyle({ showPropertyName: e.target.checked });
              }}
            />
            Show the property name
          </label>
        </fieldset>
      </details>

      <details className="sv-sec" open>
        <summary>Units</summary>
        <p className="small" data-testid="survey-units-summary">
          {m.units && Object.keys(m.units).length > 0
            ? `Own units: ${Object.values(m.units)
                .flatMap((u) => (u === undefined ? [] : [u]))
                .map((u) => unitLabel(u))
                .join(', ')}`
            : 'Site units'}
        </p>
        {!ro && (
          <button
            type="button"
            className="btn sm"
            data-testid="survey-units-measurement"
            onClick={() => {
              openDialog({ kind: 'units', target: 'measurement' });
            }}
          >
            Units for this measurement
          </button>
        )}
      </details>

      <details className="sv-sec">
        <summary>Scope</summary>
        <p className="small">
          {capture
            ? `Only in ${captures.find((c) => c.id === capture)?.label ?? capture}`
            : 'Whole site: shown with every survey'}
        </p>
        {!ro && (
          <div className="sv-row sv-wrap">
            {capture ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setScope(m.id, { kind: 'site' });
                }}
              >
                Promote to the whole site
              </button>
            ) : (
              captures.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setScope(m.id, { kind: 'survey', capture: c.id });
                  }}
                >
                  Only in {c.label}
                </button>
              ))
            )}
          </div>
        )}
        {!ro && captures.length > 0 && (
          <div className="sv-row">
            <select
              className="sv-input sv-grow"
              aria-label="Copy to survey"
              value={copyTo}
              onChange={(e) => {
                setCopyTo(e.target.value);
              }}
            >
              <option value="">Copy to another survey</option>
              {captures
                .filter((c) => c.id !== capture)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="btn sm"
              disabled={!copyTo}
              onClick={() => {
                copyToSurvey(m.id, copyTo);
                setCopyTo('');
              }}
            >
              Copy
            </button>
          </div>
        )}
      </details>

      <details className="sv-sec">
        <summary>Vertices ({m.points.length})</summary>
        {!ro && (
          <button
            type="button"
            className="btn sm"
            aria-pressed={editing !== null}
            onClick={() => {
              if (editing) stopEditing();
              else startEditing();
            }}
          >
            {editing ? 'Done editing' : 'Edit vertices in the view'}
          </button>
        )}
        <table className="sv-verts">
          <caption className="sr-only">Vertices</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{settings.order === 'ENZ' ? 'E' : 'N'}</th>
              <th scope="col">{settings.order === 'ENZ' ? 'N' : 'E'}</th>
              <th scope="col">Z</th>
              <th scope="col">
                <span className="sr-only">Delete</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {m.points.slice(0, MAX_VERTEX_ROWS).map((_, i) => (
              <VertexRow
                key={`${String(i)}-${String(m.points.length)}`}
                m={m}
                i={i}
                order={settings.order}
                ro={ro}
              />
            ))}
          </tbody>
        </table>
        {m.points.length > MAX_VERTEX_ROWS && (
          <p className="small faint">
            The first {MAX_VERTEX_ROWS} of {m.points.length} vertices.
          </p>
        )}
      </details>

      {m.family === 'polygon' ? (
        <>
          <Comparisons m={m} />
          <Calculators m={m} />
        </>
      ) : null}

      {!ro && (
        <div className="sv-row">
          <span className="sv-grow" />
          <button
            type="button"
            className="btn sm danger"
            onClick={() => {
              deleteMeasurements([m.id]);
            }}
          >
            Delete measurement
          </button>
        </div>
      )}
    </section>
  );
}

function VertexRow({
  m,
  i,
  order,
  ro,
}: {
  m: SurveyMeasurement;
  i: number;
  order: 'NEZ' | 'ENZ';
  ro: boolean;
}) {
  const p = m.points[i];
  if (!p) return null;
  const cell = (axis: 0 | 1 | 2) => (
    <td>
      <input
        className="sv-input mono"
        type="number"
        step="0.001"
        aria-label={`Vertex ${String(i + 1)} ${['E', 'N', 'Z'][axis] ?? ''}`}
        defaultValue={p[axis].toFixed(3)}
        readOnly={ro}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v) || v === p[axis]) return;
          startEditing();
          editEvent({
            type: 'set',
            vertex: i,
            coords: axis === 0 ? { e: v } : axis === 1 ? { n: v } : { z: v },
          });
          stopEditing();
        }}
      />
    </td>
  );
  return (
    <tr>
      <td className="mono">{i + 1}</td>
      {order === 'ENZ' ? cell(0) : cell(1)}
      {order === 'ENZ' ? cell(1) : cell(0)}
      {cell(2)}
      <td>
        {!ro && (
          <button
            type="button"
            className="btn ghost sm"
            aria-label={`Delete vertex ${String(i + 1)}`}
            onClick={() => {
              startEditing();
              editEvent({ type: 'delete', vertex: i });
              stopEditing();
            }}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </td>
    </tr>
  );
}

function VertexTable({ m }: { m: SurveyMeasurement }) {
  const settings = useMeasure((s) => s.settings);
  const units = effectiveUnits(settings.units, m.units);
  const rows = vertexTable(m.points);
  const d = (v: number) => formatQuantity(v, 'distance', units, settings.precision);
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
            <td className="mono">{formatBearing(r.bearingDeg)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
