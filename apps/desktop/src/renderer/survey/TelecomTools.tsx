import { getActiveStage, onActiveScene } from '@aio/engine';
import type { SitePoint, SurveyMeasurement } from '@aio/schema';
import {
  isTelecomTool,
  measurementFrom,
  telecomPointCount,
  TOOL_LABELS,
  type TelecomTool,
} from '@aio/survey';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useSyncExternalStore } from 'react';
import { shell, useShell } from '../shell';
import { CardActions, CardMenu, cardModel, MeasureCard } from './card';
import { DetectAntennas } from './DetectAntennas';
import {
  drawEvent,
  editEvent,
  flipAzimuth,
  isDirty,
  knownTemplates,
  patchMeasurement,
  saveMeasurements,
  revealMeasurement,
  startEditing,
  startTool,
  stopEditing,
  stopTool,
  useMeasure,
} from './measureStore';
import './telecom.css';

const GUIDANCE: Record<TelecomTool, string> = {
  azimuth:
    'Pick three points along the top or bottom edge of the antenna front face. Check the facing arrow, then flip it if needed.',
  'antenna-tilt':
    'Pick bottom and top on the same straight antenna edge. Physical inclination from project vertical, not electrical tilt or signed downtilt.',
  clearance:
    'Pick two endpoints across the chosen gap. Reports direct 3D distance, horizontal separation and absolute vertical gap.',
};
const MEANING: Record<TelecomTool, string> = {
  azimuth:
    'Clockwise from project/grid north. The facing arrow shows the chosen outward direction.',
  'antenna-tilt':
    'Unsigned physical inclination from project vertical: 0 degrees upright, 90 degrees horizontal. Not electrical tilt or signed downtilt.',
  clearance: 'The chosen endpoint gap only. This does not check for an obstacle-free volume.',
};

/**
 * Why the telecom tools cannot pick right now (a package, the map, no 3D view, measurements not
 * read yet), or null when they can. The Measure workbench's Telecom rows are disabled with it.
 */
export function useTelecomUnavailable(): string | null {
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const mode = useShell((s) => s.stageMode);
  const pkg = useShell((s) => s.pkg);
  const readOnly = useMeasure((s) => s.readOnly) || pkg !== null;
  const ready = useMeasure((s) => s.status === 'ready');
  return readOnly
    ? 'This package is read only. Open a writable project to draw.'
    : mode === 'map'
      ? 'Switch to 3D or Split to pick points on a point cloud or mesh.'
      : !stage
        ? 'Open the 3D view to pick points on a point cloud or mesh.'
        : !ready
          ? 'Measurements are loading or unavailable.'
          : null;
}

/** Start a telecom tool: picks are on the 3D view, so annotating and the view's own tool end. */
export function startTelecomTool(t: TelecomTool): void {
  shell.getState().setAnnotating(false);
  getActiveStage()?.setTool('select');
  startTool(t);
}

/**
 * The telecom measurement in hand (Measure workbench, Telecom): what to pick and what it means,
 * the reading, Undo and Cancel while picking, the endpoints of a picked one, and Save. The tools
 * themselves are the workbench's Telecom rows.
 */
export function TelecomTools() {
  const pkg = useShell((s) => s.pkg);
  const tool = useMeasure((s) => s.tool);
  const draw = useMeasure((s) => s.draw);
  const readOnly = useMeasure((s) => s.readOnly) || pkg !== null;
  const focused = useMeasure((s) => s.file.measurements.find((m) => m.id === s.focus));
  const focus = useMeasure((s) => s.focus);
  const message = useMeasure((s) => s.message);
  const editing = useMeasure((s) => s.editing);
  const settings = useMeasure((s) => s.settings);
  const templates = useMeasure((s) => s.templates);
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  const dirty = useMeasure(isDirty);
  const saving = useMeasure((s) => s.saving);
  const active = tool && isTelecomTool(tool.tool) ? tool.tool : null;
  const measurement = focused && isTelecomTool(focused.tool) ? focused : null;
  const unavailable = useTelecomUnavailable();
  const preview: SurveyMeasurement | null = useMemo(
    () =>
      active && draw
        ? measurementFrom(active, {
            id: 'live',
            label: TOOL_LABELS[active],
            scope: { kind: 'site' },
            points:
              draw.cursor && draw.points.length < telecomPointCount(active)
                ? [...draw.points, draw.cursor]
                : draw.points,
            createdAt: '',
          })
        : null,
    [active, draw],
  );
  const result = useMemo(
    () =>
      preview ??
      (measurement && editing ? { ...measurement, points: editing.points } : measurement),
    [preview, measurement, editing],
  );
  const all = useMemo(() => knownTemplates({ templates, settings }), [templates, settings]);
  // the shared card's model: angles and lengths in the site's units and angle settings
  const model = useMemo(
    () =>
      result ? cardModel(result, { settings, templates: all, captures: captures ?? [] }) : null,
    [result, settings, all, captures],
  );

  return (
    <section
      className="telecom-tools"
      aria-label="Telecom measurements"
      data-testid="telecom-tools"
      onKeyDown={(event) => {
        // Keep native Space activation here; the app otherwise uses it for global playback.
        if (event.key === ' ') event.stopPropagation();
      }}
    >
      <header>
        <b>Telecom measurements</b>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            revealMeasurement(focus ?? null);
          }}
        >
          Measurements
        </button>
      </header>
      {/* a picked measurement carries its own guidance in its card */}
      {(unavailable !== null || active !== null || measurement === null) && (
        <p className="telecom-help" id="telecom-guidance">
          {unavailable ??
            (active
              ? GUIDANCE[active]
              : 'Pick on point clouds or meshes in 3D. Heights come from the picked surface.')}
        </p>
      )}
      {active === 'azimuth' && <NorthNote />}
      <DetectAntennas />
      {active && draw && model && (
        <div className="telecom-result" aria-live="polite">
          <MeasureCard model={model} variant="live" testId="telecom-card" />
          <span className="mono small">
            {draw.points.length} / {telecomPointCount(active)} points picked
          </span>
        </div>
      )}
      {!active && measurement && model && (
        <MeasureCard
          model={model}
          variant="detail"
          measureId={measurement.id}
          testId="telecom-card"
          {...(readOnly
            ? {}
            : {
                onRename: (label: string) => {
                  patchMeasurement(measurement.id, { label });
                },
              })}
          menu={<CardMenu id={measurement.id} />}
          slots={{
            detail: (
              <TelecomDetail
                measurement={measurement}
                readOnly={readOnly}
                unavailable={unavailable}
                editing={editing !== null}
              />
            ),
          }}
          actions={<CardActions id={measurement.id} />}
        />
      )}
      {message && (
        <p className="telecom-help" role="status">
          {message}
        </p>
      )}
      {active && draw && (
        <div className="telecom-actions">
          <button
            type="button"
            className="btn sm"
            disabled={draw.points.length === 0}
            onClick={() => {
              drawEvent({ type: 'undo' }, { view: '3d' });
            }}
          >
            Undo last point
          </button>
          <button type="button" className="btn ghost sm" onClick={stopTool}>
            Cancel
          </button>
        </div>
      )}
      {dirty && !readOnly && (
        <button
          type="button"
          className="btn sm primary"
          disabled={saving}
          data-testid="telecom-save"
          onClick={() => void saveMeasurements()}
        >
          Save measurements
        </button>
      )}
    </section>
  );
}

/** Which north the azimuth is measured from. */
function NorthNote() {
  const local = useWorkspace((s) => !!s.project && !('epsg' in s.project.manifest.crs));
  return (
    <p className="telecom-help">
      {local
        ? 'Project north is local; no surveyed orientation is assumed.'
        : 'Grid north follows the project CRS; this is not true north.'}
    </p>
  );
}

/**
 * The telecom card's detail: what the reading means, Flip direction and Edit endpoints, and the
 * picks (the endpoint coordinates).
 */
function TelecomDetail({
  measurement,
  readOnly,
  unavailable,
  editing,
}: {
  measurement: SurveyMeasurement;
  readOnly: boolean;
  unavailable: string | null;
  editing: boolean;
}) {
  const tool = measurement.tool as TelecomTool;
  return (
    <>
      <p className="telecom-help" id="telecom-guidance">
        {MEANING[tool]}
      </p>
      {tool === 'azimuth' && <NorthNote />}
      {!readOnly && (
        <>
          <div className="telecom-actions">
            {tool === 'azimuth' && (
              <button
                type="button"
                className="btn sm"
                data-testid="telecom-flip-direction"
                onClick={() => {
                  flipAzimuth(measurement.id);
                }}
              >
                Flip direction
              </button>
            )}
            <button
              type="button"
              className="btn sm"
              disabled={unavailable !== null}
              aria-pressed={editing}
              onClick={() => {
                if (editing) stopEditing();
                else startEditing();
              }}
            >
              {editing ? 'Done editing' : 'Edit endpoints in 3D'}
            </button>
          </div>
          <details className="telecom-vertices">
            <summary>Endpoint coordinates</summary>
            <TelecomVertices measurement={measurement} />
          </details>
        </>
      )}
    </>
  );
}

function TelecomVertices({ measurement: m }: { measurement: SurveyMeasurement }) {
  return (
    <div className="telecom-coordinates">
      {m.points.map((point, i) => (
        <fieldset key={i}>
          <legend>Point {i + 1}</legend>
          {(['E', 'N', 'Z'] as const).map((label, axis) => (
            <label key={label}>
              {label}
              <input
                className="sv-input mono"
                type="number"
                step="0.001"
                aria-label={`Vertex ${i + 1} ${label}`}
                value={point[axis]}
                onChange={(e) => {
                  if (e.target.value === '') return;
                  const value = e.target.valueAsNumber;
                  if (!Number.isFinite(value)) return;
                  const next: SitePoint = [point[0], point[1], point[2]];
                  if (axis === 0) next[0] = value;
                  else if (axis === 1) next[1] = value;
                  else next[2] = value;
                  // Use the same edit path as scene dragging; fixed-count guards apply in one place.
                  startEditing();
                  editEvent({
                    type: 'set',
                    vertex: i,
                    coords: { e: next[0], n: next[1], z: next[2] },
                  });
                  stopEditing();
                }}
              />
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
