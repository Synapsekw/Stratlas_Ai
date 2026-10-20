/**
 * One measurement's detail card (M11 G3, volumetric parity W2): the shared `MeasureCard` in its
 * detail variant. The card holds the name, the scope chip, the colour, the primary value, the
 * secondary line and "More"; the tool's chips, chart and detail come from `card/slots.tsx`. Under
 * them: the template (changeable) and its custom fields, style and label, the units override, the
 * scope (site or one survey: promote, demote, copy to another survey) and the vertices (drag in the
 * 3D view, or type coordinates). The "⋯" menu and the actions row are the registry's.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { unitLabel } from '@aio/geo';
import type { MeasurementStyle, SurveyMeasurement } from '@aio/schema';
import { changeTemplate, isTelecomTool, TOOL_LABELS, type RolePicks } from '@aio/survey';
import { Icon, IconButton, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState, type CSSProperties } from 'react';
import { CardActions, CardMenu, cardModel, MeasureCard } from './card';
import { slotsFor, usePointVsText } from './card/slots';
import {
  copyToSurvey,
  editEvent,
  knownTemplates,
  openDialog,
  patchMeasurement,
  replaceMeasurement,
  select,
  setScope,
  startEditing,
  stopEditing,
  updateMeasurement,
  useMeasure,
  withDesignLayers,
} from './measureStore';
import { drawnPoints } from './measureDates';
import {
  DEFAULT_BORDER_WIDTH,
  DEFAULT_FILL_OPACITY,
  DEFAULT_MEASURE_COLOUR,
  MEASURE_COLOURS,
} from './measureColours';
import { HoldNote } from './Qa';
import { useFocusCapture } from './qaHelpers';
import { isHeld, useQa } from './qaStore';

const MAX_VERTEX_ROWS = 50;

export function MeasurementPanel() {
  const m = useMeasure((s) => s.file.measurements.find((x) => x.id === s.focus) ?? null);
  return m ? <PanelCard m={m} /> : null;
}

/** The focused measurement's detail card. */
function PanelCard({ m }: { m: SurveyMeasurement }) {
  const t = useT();
  const focus = useMeasure((s) => s.focus);
  const readOnly = useMeasure((s) => s.readOnly);
  // a look-only reviewer reads the panel as the tree and the 3D menu offer it: no edits
  const lookOnly = useAnnotateReadOnly();
  const settings = useMeasure((s) => s.settings);
  const templates = useMeasure((s) => s.templates);
  const surface = useMeasure((s) => s.surface);
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const focusCapture = useFocusCapture();
  const capture = m.scope.kind === 'survey' ? m.scope.capture : null;
  const held = useQa((s) => {
    const on = capture ?? focusCapture;
    return on ? isHeld(s.qa[on]) : false;
  });
  // where the measurement is drawn (its date's line-up added): the readouts, the terrain samples
  // and the vertex fields are of what the person sees; edits go back through the shift
  const shown = useMemo(() => ({ ...m, points: drawnPoints(m, manifest) }), [m, manifest]);
  const all = useMemo(() => knownTemplates({ templates, settings }), [templates, settings]);
  const model = useMemo(
    () =>
      cardModel(shown, {
        settings,
        templates: all,
        captures: captures ?? [],
        ...(surface ? { surface } : {}),
      }),
    [shown, settings, all, captures, surface],
  );
  const slots = useMemo(() => slotsFor(m, 'detail'), [m]);
  // a point compared with a design or a date: its difference joins the secondary line
  const vs = usePointVsText(m);

  if (!focus) return null;
  const ro = readOnly || lookOnly;
  return (
    <MeasureCard
      model={
        vs ? { ...model, secondary: [model.secondary, vs].filter(Boolean).join(' · ') } : model
      }
      variant="detail"
      measureId={m.id}
      testId="survey-panel"
      {...(ro
        ? {}
        : {
            onRename: (label: string) => {
              patchMeasurement(m.id, { label });
            },
          })}
      menu={
        <>
          <CardMenu id={m.id} />
          <IconButton
            icon="x"
            label={t('dialog.close')}
            data-testid="survey-panel-close"
            onClick={() => {
              stopEditing();
              select([], null);
            }}
          />
        </>
      }
      slots={{
        ...slots,
        ...(held ? { status: <HoldNote capture={capture} /> } : {}),
        detail: (
          <>
            {slots.detail}
            <PanelSections m={m} shown={shown} ro={ro} />
          </>
        ),
      }}
      actions={<CardActions id={m.id} />}
    />
  );
}

/** The template, style and label, units, scope and vertices, under the tool's own detail. */
function PanelSections({
  m,
  shown,
  ro,
}: {
  m: SurveyMeasurement;
  shown: SurveyMeasurement;
  ro: boolean;
}) {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const templates = useMeasure((s) => s.templates);
  const editing = useMeasure((s) => s.editing);
  const captures = useWorkspace((s) => s.project?.manifest.captures ?? []);
  const [copyTo, setCopyTo] = useState('');
  const all = useMemo(() => knownTemplates({ templates, settings }), [templates, settings]);
  const tpl = m.template ? all.find((x) => x.id === m.template) : undefined;
  const family = all.filter(
    (x) => x.family === m.family && (!isTelecomTool(x.tool) || x.tool === m.tool),
  );
  const setStyle = (patch: Partial<MeasurementStyle>) => {
    patchMeasurement(m.id, {
      style: { color: DEFAULT_MEASURE_COLOUR, ...(m.style ?? {}), ...patch },
    });
  };
  const capture = m.scope.kind === 'survey' ? m.scope.capture : null;

  return (
    <>
      <p className="small faint">
        {tpl ? `${tpl.name} · ` : ''}
        {TOOL_LABELS[m.tool]}
        {m.createdBy ? ` · by ${m.createdBy}` : ''}
      </p>

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
              const next = family.find((x) => x.id === e.target.value) ?? null;
              const apply = (picks: RolePicks) => {
                const changed = changeTemplate(m, next, new Date().toISOString(), picks);
                if (changed) replaceMeasurement(changed);
              };
              // a template that compares to a design asks for its layers first (G9 sets)
              if (next) void withDesignLayers(next, apply);
              else apply({});
            }}
          >
            <option value="">None ({TOOL_LABELS[m.tool]})</option>
            {family.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
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

      <details className="sv-sec" data-testid="survey-style">
        <summary>{t('mcard.styleLabel')}</summary>
        <fieldset className="sv-grid" disabled={ro}>
          <div className="sv-field">
            <span id={`sv-colour-${m.id}`}>{t('mcard.colour')}</span>
            {/* the one palette the right-click menu offers, then any other colour */}
            <div className="sv-picks" role="group" aria-labelledby={`sv-colour-${m.id}`}>
              {MEASURE_COLOURS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="sv-pick"
                  aria-label={t(c.label)}
                  aria-pressed={(m.style?.color ?? DEFAULT_MEASURE_COLOUR).toLowerCase() === c.hex}
                  data-testid={`style-colour-${c.id}`}
                  style={{ '--sw': c.hex } as CSSProperties}
                  onClick={() => {
                    setStyle({ color: c.hex });
                  }}
                />
              ))}
              <input
                type="color"
                className="sv-pick-custom"
                aria-label={t('mcard.colour')}
                value={m.style?.color ?? DEFAULT_MEASURE_COLOUR}
                onChange={(e) => {
                  setStyle({ color: e.target.value });
                }}
              />
            </div>
          </div>
          <label className="sv-field">
            <span>{t('mcard.fill')}</span>
            <input
              type="color"
              value={m.style?.fill ?? m.style?.color ?? DEFAULT_MEASURE_COLOUR}
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
              value={m.style?.fillOpacity ?? DEFAULT_FILL_OPACITY}
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
              value={m.style?.borderWidth ?? DEFAULT_BORDER_WIDTH}
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

      <details className="sv-sec">
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
        <summary>
          {t('mcard.vertices')} ({m.points.length})
        </summary>
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
          <caption className="sr-only">{t('mcard.vertices')}</caption>
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
                m={shown}
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
    </>
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
        {!ro && !isTelecomTool(m.tool) && (
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
