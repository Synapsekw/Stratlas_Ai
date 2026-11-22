import { getActiveStage, onActiveScene } from '@aio/engine';
import type { SitePoint, SurveyMeasurement } from '@aio/schema';
import {
  isTelecomTool,
  measurementFrom,
  telecomPointCount,
  TOOL_LABELS,
  type TelecomTool,
} from '@aio/survey';
import { useT } from '@aio/ui';
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

/** The catalogue key suffix of each tool's texts. */
const KEY = { azimuth: 'azimuth', 'antenna-tilt': 'tilt', clearance: 'clearance' } as const;

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
  const t = useT();
  return readOnly
    ? t('palette.unavailable.telecomReadOnly')
    : mode === 'map'
      ? t('palette.unavailable.telecomMap')
      : !stage
        ? t('palette.unavailable.telecomNo3d')
        : !ready
          ? t('palette.unavailable.telecomLoading')
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
  const t = useT();
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
      aria-label={t('telecom.tools.title')}
      data-testid="telecom-tools"
      onKeyDown={(event) => {
        // Keep native Space activation here; the app otherwise uses it for global playback.
        if (event.key === ' ') event.stopPropagation();
      }}
    >
      <header>
        <b>{t('telecom.tools.title')}</b>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            revealMeasurement(focus ?? null);
          }}
        >
          {t('telecom.tools.measurements')}
        </button>
      </header>
      {/* a picked measurement carries its own guidance in its card */}
      {(unavailable !== null || active !== null || measurement === null) && (
        <p className="telecom-help" id="telecom-guidance">
          {unavailable ??
            (active ? t(`telecom.tools.guidance.${KEY[active]}`) : t('telecom.tools.idle'))}
        </p>
      )}
      {active === 'azimuth' && <NorthNote />}
      <DetectAntennas />
      {active && draw && model && (
        <div className="telecom-result" aria-live="polite">
          <MeasureCard model={model} variant="live" testId="telecom-card" />
          <span className="mono small">
            {t('telecom.tools.picked', {
              picked: draw.points.length,
              total: telecomPointCount(active),
            })}
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
            {t('telecom.tools.undo')}
          </button>
          <button type="button" className="btn ghost sm" onClick={stopTool}>
            {t('telecom.tools.cancel')}
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
          {t('telecom.tools.save')}
        </button>
      )}
    </section>
  );
}

/** Which north the azimuth is measured from. */
function NorthNote() {
  const t = useT();
  const local = useWorkspace((s) => !!s.project && !('epsg' in s.project.manifest.crs));
  return (
    <p className="telecom-help">
      {local ? t('telecom.tools.north.local') : t('telecom.tools.north.grid')}
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
  const t = useT();
  const tool = measurement.tool as TelecomTool;
  return (
    <>
      <p className="telecom-help" id="telecom-guidance">
        {t(`telecom.tools.meaning.${KEY[tool]}`)}
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
                {t('telecom.tools.flip')}
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
              {editing ? t('telecom.tools.editDone') : t('telecom.tools.edit')}
            </button>
          </div>
          <details className="telecom-vertices">
            <summary>{t('telecom.tools.endpoints')}</summary>
            <TelecomVertices measurement={measurement} />
          </details>
        </>
      )}
    </>
  );
}

function TelecomVertices({ measurement: m }: { measurement: SurveyMeasurement }) {
  const t = useT();
  return (
    <div className="telecom-coordinates">
      {m.points.map((point, i) => (
        <fieldset key={i}>
          <legend>{t('telecom.tools.point', { n: i + 1 })}</legend>
          {(['e', 'n', 'z'] as const).map((key, axis) => (
            <label key={key}>
              {t(`telecom.tools.axis.${key}`)}
              <input
                className="sv-input mono"
                type="number"
                step="0.001"
                aria-label={t('telecom.tools.vertex', {
                  n: i + 1,
                  axis: t(`telecom.tools.axis.${key}`),
                })}
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
