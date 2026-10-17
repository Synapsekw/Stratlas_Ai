/**
 * The survey measurements' workspace mount (M11 G3, PRD SRV-3 to SRV-5): `MeasureLayer` draws
 * the measurements in the 3D view and on the map, loads the project's file and shows the dialogs.
 * The tools, the list, the measurement panel, the drawing aids and the templates are the Measure
 * workbench in the right sidebar (workspace/workbench/benches/MeasureBench.tsx, stage island D12,
 * D18); Survey QA, Terrain overlays and Hydrology are sidebar tabs of their own.
 */
import type { EngineStage } from '@aio/engine';
import { getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import { isTelecomTool } from '@aio/survey';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '../shell';
import { primaryMap, primaryScene } from '../workspace/compare';
import { useMeasureFollow } from '../workspace/workbench/measureFollow';
import { CompareLayer } from './Comparison';
import { DesignRolePrompt } from './DesignRolePrompt';
import { ExportDialogMount } from './ExportDialog';
import { useMagicController } from './MagicPolygon';
import { PendingNote, usePending } from './PendingNote';
import { attach3d, attachMap, frameOf, stageClamp } from './measureScene';
import { loadMeasurements, setSurface, stopTool, stopEditing, useMeasure } from './measureStore';
import { TemplateEditor } from './TemplateEditor';
import { useOverlaysLoad } from './Overlays';
import { attachOverlaysMap } from './overlaysMap';
import { SectionDock } from './SectionDock';
import { attachSectionMap } from './sectionMap';
import { UnitsDialog } from './UnitsDialog';
import './measure.css';

function useActiveMap(): MapController | null {
  return useSyncExternalStore(onActiveMap, getActiveMap, getActiveMap);
}

/**
 * The workspace mount of the measurements (one per stage, whatever toolbar groups show). In a
 * package (player mode) it draws and lists the measurements, sections, overlays and comparison
 * results read only: main reads them from the package in place and refuses every write and job,
 * and the panels hide their edit, run and save controls (`readOnly`).
 */
export function MeasureMount({ stage }: { stage: EngineStage | null }) {
  return <MeasureLayer stage={stage} />;
}

/**
 * The measurements in the views: loads the project's file, attaches the 3D and map drawing, keeps
 * the Measure workbench and the survey panel tabs following the tools, and shows the unsaved
 * changes bar and the dialogs.
 */
export function MeasureLayer({ stage }: { stage: EngineStage | null }) {
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const stageMode = useShell((s) => s.stageMode);
  const annotating = useShell((s) => s.annotating);
  const pkg = useShell((s) => s.pkg);
  const manifest = project?.manifest ?? null;
  const map = useActiveMap();
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  const focusTool = useMeasure((s) => s.file.measurements.find((m) => m.id === s.focus)?.tool);
  const activeTool = useMeasure((s) => s.tool?.tool);
  const dialog = useMeasure((s) => s.dialog);
  useOverlaysLoad();
  useMeasureFollow();
  // Suggest boundaries holds the drawing while the measurements are on the stage, not its tab
  useMagicController();

  useEffect(() => {
    void loadMeasurements(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!stage || !frame) return;
    const clamp = stageClamp(stage, frame);
    setSurface({ heightAt: clamp });
    // the main view's own dates: the date its side shows while the split shows dates
    const detach = attach3d(stage, frame, { dates: primaryScene });
    return () => {
      detach();
      setSurface(null);
    };
  }, [stage, frame]);

  useEffect(() => {
    if (!map || !frame) return;
    const clampZ = stage ? stageClamp(stage, frame) : () => null;
    const detach = [
      attachMap(map, frame, clampZ, { dates: primaryMap }),
      attachSectionMap(map, frame.epsg),
      attachOverlaysMap(map, frame.epsg),
    ];
    return () => {
      for (const d of detach) d();
    };
  }, [map, frame, stage]);

  // a project switch ends any drawing
  useEffect(() => {
    stopTool();
  }, [projectId]);

  useEffect(() => {
    if (
      (stageMode === 'map' || annotating || pkg || !stage) &&
      activeTool &&
      isTelecomTool(activeTool)
    )
      stopTool();
    if (
      (stageMode === 'map' || annotating || pkg || !stage) &&
      focusTool &&
      isTelecomTool(focusTool)
    )
      stopEditing();
  }, [stageMode, annotating, pkg, stage, activeTool, focusTool]);

  if (!projectId) return null;
  return createPortal(
    <>
      <UnsavedBar />
      <CompareLayer stage={stage} map={map} frame={frame} />
      <SectionDock stage={stage} />
      {dialog?.kind === 'templates' && <TemplateEditor />}
      {dialog?.kind === 'units' && <UnitsDialog />}
      <DesignRolePrompt />
      <ExportDialogMount />
    </>,
    document.body,
  );
}

/**
 * The stage's fallback for unsaved measurement changes (D18): they and their Save live in the
 * Measure workbench, so the stage shows them only while the right sidebar is folded away, where
 * the Save would otherwise be out of reach. The same note as the bench's.
 */
export function UnsavedBar() {
  const folded = useShell((s) => s.rightCollapsed);
  const pending = usePending();
  if (!folded || !pending) return null;
  return (
    <div className="sv-drawbar" data-surface="dark">
      <PendingNote saveTestId="survey-save-stage" />
    </div>
  );
}
