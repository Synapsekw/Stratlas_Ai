/**
 * Survey measurement tools on the stage toolbar (M11 G3, PRD SRV-3 to SRV-5): the typed tools by
 * family, the bookmarked templates, the drawing aids (snapping, angle lock, typed distance and
 * bearing) and the way into the list, the templates and the units. `MeasureLayer` draws the
 * measurements in the 3D view and on the map and holds the panels; the toolbar mounts it.
 */
import type { EngineStage } from '@aio/engine';
import { unitLabel } from '@aio/geo';
import { getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import type { MeasurementTool } from '@aio/schema';
import {
  bookmarks,
  FAMILY_LABELS,
  parseBearing,
  templateLibrary,
  TOOL_FAMILY,
  TOOL_LABELS,
  type SnapSource,
} from '@aio/survey';
import { Icon, type IconName } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '../shell';
import { PopTool } from '../workspace/StageTools';
import { BulkTotals } from './BulkTotals';
import { CompareLayer } from './Comparison';
import { DesignsTool } from './Designs';
import { openCompareDialog } from './compareStore';
import { MeasurementList } from './MeasurementList';
import { MeasurementPanel } from './MeasurementPanel';
import { SurveyQaTool } from './Qa';
import { attach3d, attachMap, frameOf, stageClamp } from './measureScene';
import {
  drawEvent,
  isDirty,
  loadMeasurements,
  openDialog,
  saveMeasurements,
  setListOpen,
  setSnap,
  setSnapSource,
  setSurface,
  startTool,
  stopTool,
  useMeasure,
} from './measureStore';
import { TemplateEditor } from './TemplateEditor';
import { UnitsDialog } from './UnitsDialog';
import './measure.css';

/** The tools the toolbar offers, by family (sections and history open with G5 and G8). */
const FAMILIES: { family: 'point' | 'line' | 'polygon' | 'markup'; tools: MeasurementTool[] }[] = [
  { family: 'point', tools: ['elevation', 'elevation-difference', 'annotation'] },
  { family: 'line', tools: ['distance', 'grade', 'vertex-table', 'berm-check'] },
  { family: 'polygon', tools: ['area', 'volume'] },
  { family: 'markup', tools: ['freehand'] },
];

const FAMILY_ICON: Record<string, IconName> = {
  point: 'point',
  line: 'path',
  polygon: 'polygon',
  markup: 'brush',
};

const SNAP_SOURCES: { source: SnapSource; label: string }[] = [
  { source: 'measurement', label: 'Measurements' },
  { source: 'design', label: 'Designs' },
  { source: 'alignment', label: 'Alignments' },
  { source: 'guide', label: 'Guidelines' },
];

/** The stage toolbar's survey tools (in `MeasureTools`, and alone on the map). */
export function MeasureToolbar() {
  const active = useMeasure((s) => s.tool);
  const listOpen = useMeasure((s) => s.listOpen);
  const templates = useMeasure((s) => s.templates);
  const snap = useMeasure((s) => s.snap);
  const readOnly = useMeasure((s) => s.readOnly);
  const lib = useMemo(
    () => bookmarks(templateLibrary(templates.project, templates.user)),
    [templates],
  );
  // picking a tool or opening a panel closes the popover, so the keys go to the drawing
  const [open, setOpen] = useState(false);
  return (
    <>
      <PopTool
        icon="measure"
        label="Survey measurements"
        pressed={active !== null || listOpen}
        wide
        open={open}
        onOpenChange={setOpen}
      >
        <div className="pop-form sv-tools" data-testid="survey-tools">
          {/* the site's designs and survey QA: here rather than on the bar, which fits one row at
              1440 px with both side panels open */}
          <div className="sv-fam" role="group" aria-label="Site data">
            <span className="pop-title">
              <Icon name="layers" size={12} /> Site data
            </span>
            <div className="tgroup-h sv-nested">
              <DesignsTool />
              <SurveyQaTool
                onPicked={() => {
                  setOpen(false);
                }}
              />
            </div>
          </div>
          {!readOnly &&
            FAMILIES.map((f) => (
              <div
                key={f.family}
                className="sv-fam"
                role="group"
                aria-label={FAMILY_LABELS[f.family]}
              >
                <span className="pop-title">
                  <Icon name={FAMILY_ICON[f.family] ?? 'measure'} size={12} />{' '}
                  {FAMILY_LABELS[f.family]}
                </span>
                <div className="sv-tool-row">
                  {f.tools.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="btn sm"
                      aria-pressed={active?.tool === t && !active.template}
                      data-testid={`survey-tool-${t}`}
                      onClick={() => {
                        if (active?.tool === t && !active.template) stopTool();
                        else startTool(t);
                        setOpen(false);
                      }}
                    >
                      {TOOL_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          {!readOnly && lib.length > 0 && (
            <div className="sv-fam" role="group" aria-label="Bookmarked templates">
              <span className="pop-title">
                <Icon name="flag" size={12} /> Templates
              </span>
              <div className="sv-tool-row">
                {lib.map(({ template: t }) => (
                  <button
                    key={t.id}
                    type="button"
                    className="btn sm"
                    aria-pressed={active?.template?.id === t.id}
                    data-testid={`survey-bookmark-${t.id}`}
                    title={t.description ?? TOOL_LABELS[t.tool]}
                    onClick={() => {
                      if (active?.template?.id === t.id) stopTool();
                      else startTool(t.tool, t);
                      setOpen(false);
                    }}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {readOnly && (
            <p className="pop-note">
              This project is a read-only package: measurements are shown only.
            </p>
          )}
          <span className="pop-title">Drawing aids</span>
          <label className="pop-row">
            <span className="pop-grow">Snap to vertices</span>
            <input
              type="checkbox"
              checked={snap.vertices}
              onChange={(e) => {
                setSnap({ vertices: e.target.checked });
              }}
            />
          </label>
          <label className="pop-row">
            <span className="pop-grow">Snap to edges</span>
            <input
              type="checkbox"
              checked={snap.edges}
              onChange={(e) => {
                setSnap({ edges: e.target.checked });
              }}
            />
          </label>
          <div className="sv-chips" role="group" aria-label="Snap to">
            {SNAP_SOURCES.map((s) => (
              <label key={s.source} className="sv-chip">
                <input
                  type="checkbox"
                  checked={snap.sources[s.source]}
                  onChange={(e) => {
                    setSnapSource(s.source, e.target.checked);
                  }}
                />
                {s.label}
              </label>
            ))}
          </div>
          <label className="pop-row">
            <span>Snap distance</span>
            <input
              type="range"
              min={2}
              max={30}
              value={snap.tolerancePx}
              onChange={(e) => {
                setSnap({ tolerancePx: Number(e.target.value) });
              }}
            />
            <span className="mono">{snap.tolerancePx} px</span>
          </label>
          <p className="pop-note">
            Hold <span className="kbd">Shift</span> to lock the angle; type a distance and press{' '}
            <span className="kbd">Enter</span>; <span className="kbd">Tab</span> types a bearing;{' '}
            <span className="kbd">Esc</span> cancels.
          </p>
          <div className="sv-tool-row">
            <button
              type="button"
              className="btn sm"
              aria-pressed={listOpen}
              data-testid="survey-list-open"
              onClick={() => {
                setListOpen(!listOpen);
                setOpen(false);
              }}
            >
              <Icon name="layers" size={12} /> Measurements
            </button>
            <button
              type="button"
              className="btn sm"
              data-testid="survey-templates-open"
              onClick={() => {
                openDialog({ kind: 'templates', edit: null, scope: 'project' });
                setOpen(false);
              }}
            >
              <Icon name="flag" size={12} /> Templates
            </button>
            <button
              type="button"
              className="btn sm"
              data-testid="survey-units-open"
              onClick={() => {
                openDialog({ kind: 'units', target: 'site' });
                setOpen(false);
              }}
            >
              Units
            </button>
            <button
              type="button"
              className="btn sm"
              data-testid="survey-materials-tool"
              onClick={() => {
                openCompareDialog('materials');
                setOpen(false);
              }}
            >
              Materials
            </button>
            <button
              type="button"
              className="btn sm"
              data-testid="survey-site-open"
              onClick={() => {
                openCompareDialog('site');
                setOpen(false);
              }}
            >
              Whole site cut and fill
            </button>
          </div>
        </div>
      </PopTool>
    </>
  );
}

function useActiveMap(): MapController | null {
  return useSyncExternalStore(onActiveMap, getActiveMap, getActiveMap);
}

/**
 * The workspace mount of the measurements (one per stage, whatever toolbar groups show): none in
 * a package, whose player mode does not draw or edit measurements yet.
 */
export function MeasureMount({ stage }: { stage: EngineStage | null }) {
  const pkg = useShell((s) => s.pkg);
  return pkg ? null : <MeasureLayer stage={stage} />;
}

/**
 * The measurements in the views and their panels: loads the project's file, attaches the 3D and
 * map drawing, and shows the drawing bar, the list, the properties panel and the dialogs.
 */
export function MeasureLayer({ stage }: { stage: EngineStage | null }) {
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const manifest = project?.manifest ?? null;
  const map = useActiveMap();
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  const listOpen = useMeasure((s) => s.listOpen);
  const focus = useMeasure((s) => s.focus);
  const dialog = useMeasure((s) => s.dialog);

  useEffect(() => {
    void loadMeasurements(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!stage || !frame) return;
    const clamp = stageClamp(stage, frame);
    setSurface({ heightAt: clamp });
    const detach = attach3d(stage, frame);
    return () => {
      detach();
      setSurface(null);
    };
  }, [stage, frame]);

  useEffect(() => {
    if (!map || !frame) return;
    const clampZ = stage ? stageClamp(stage, frame) : () => null;
    return attachMap(map, frame, clampZ);
  }, [map, frame, stage]);

  // a project switch ends any drawing
  useEffect(() => {
    stopTool();
  }, [projectId]);

  if (!projectId) return null;
  return createPortal(
    <>
      <DrawBar />
      {(listOpen || focus) && (
        <aside className="sv-side" aria-label="Survey measurements" data-testid="survey-side">
          {listOpen && <MeasurementList stage={stage} />}
          {focus && <MeasurementPanel />}
          <BulkTotals />
        </aside>
      )}
      <CompareLayer stage={stage} map={map} frame={frame} />
      {dialog?.kind === 'templates' && <TemplateEditor />}
      {dialog?.kind === 'units' && <UnitsDialog />}
    </>,
    document.body,
  );
}

/** While drawing: the tool, the typed distance and bearing, and Finish and Cancel. */
function DrawBar() {
  const tool = useMeasure((s) => s.tool);
  const draw = useMeasure((s) => s.draw);
  const units = useMeasure((s) => s.settings.units);
  const dirty = useMeasure(isDirty);
  const saving = useMeasure((s) => s.saving);
  const editing = useMeasure((s) => s.editing !== null);
  const [, setTick] = useState(0);
  if (!tool || !draw) {
    if (!dirty && !editing) return null;
    return (
      <div
        className="sv-drawbar"
        role="region"
        aria-label="Unsaved measurements"
        data-surface="dark"
      >
        <span className="small">
          {editing
            ? 'Editing vertices: drag, Alt+click deletes, the blue dots insert.'
            : 'Unsaved measurement changes.'}
        </span>
        {dirty && (
          <button
            type="button"
            className="btn sm primary"
            disabled={saving}
            data-testid="survey-save"
            onClick={() => {
              void saveMeasurements();
            }}
          >
            Save measurements
          </button>
        )}
      </div>
    );
  }
  const bearing = parseBearing(draw.typing.bearing);
  const env = { distanceUnit: units.distance };
  return (
    <div
      className="sv-drawbar"
      role="region"
      aria-label="Drawing"
      data-testid="survey-drawbar"
      data-surface="dark"
    >
      <b>{tool.template?.name ?? TOOL_LABELS[tool.tool]}</b>
      <span className="faint small">
        {draw.points.length} {draw.points.length === 1 ? 'point' : 'points'}
        {draw.lockedBearing !== null && ` · locked ${draw.lockedBearing.toFixed(1)}°`}
        {draw.snap && ` · snapped to a ${draw.snap.source} ${draw.snap.kind}`}
      </span>
      {TOOL_FAMILY[tool.tool] !== 'point' && (
        <>
          <span
            className={`sv-typed${draw.typing.field === 'distance' ? ' on' : ''}`}
            data-testid="survey-typed-distance"
          >
            Distance <b className="mono">{draw.typing.distance || '...'}</b>{' '}
            {unitLabel(units.distance)}
          </span>
          <span
            className={`sv-typed${draw.typing.field === 'bearing' ? ' on' : ''}`}
            data-testid="survey-typed-bearing"
          >
            Bearing <b className="mono">{draw.typing.bearing || '...'}</b>
            {bearing !== null ? '°' : ''}
          </span>
        </>
      )}
      <span className="sv-grow" />
      {TOOL_FAMILY[tool.tool] !== 'point' && (
        <button
          type="button"
          className="btn sm"
          data-testid="survey-finish"
          onClick={() => {
            drawEvent({ type: 'finish' }, env);
            setTick((n) => n + 1);
          }}
        >
          Finish
        </button>
      )}
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => {
          stopTool();
        }}
      >
        Cancel
      </button>
    </div>
  );
}
