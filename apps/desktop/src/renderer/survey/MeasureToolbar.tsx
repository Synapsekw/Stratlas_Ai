/**
 * The survey measurements' workspace mount (M11 G3, PRD SRV-3 to SRV-5): `MeasureLayer` draws
 * the measurements in the 3D view and on the map, loads the project's file and shows the dialogs.
 * The tools, the list, the measurement panel, the drawing aids and the templates are the Measure
 * workbench in the right sidebar (workspace/workbench/benches/MeasureBench.tsx, stage island D12,
 * D18); Survey QA, Terrain overlays and Hydrology are sidebar tabs of their own.
 */
import type { EngineStage } from '@aio/engine';
import { fromWgs84 } from '@aio/geo';
import { getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import { isTelecomTool } from '@aio/survey';
import { useWorkspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '../shell';
import { primaryMap, primaryScene } from '../workspace/compare';
import { useMeasureFollow } from '../workspace/workbench/measureFollow';
import { CompareLayer } from './Comparison';
import { DesignRolePrompt } from './DesignRolePrompt';
import { ExportDialogMount } from './ExportDialog';
import { useMagicController } from './MagicPolygon';
import { MeasureMenu } from './MeasureMenu';
import { attachMeasurePick3d, attachMeasurePickMap, type MeasureMenuAt } from './measurePick';
import { PendingNote, usePending } from './PendingNote';
import { createMapHeights, type EnBox } from './mapHeights';
import { attach3d, attachMap, frameOf, stageClamp } from './measureScene';
import { useFocusCapture } from './qaHelpers';
import { surfaceOfCapture, useQa } from './qaStore';
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
 * changes bar and the dialogs. A measurement in the main 3D view or on the main map is picked with
 * a left click and has its menu on a right-click (`measurePick`, `MeasureMenu`); the second view
 * of a split and the display-only views have neither.
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
  const [menuAt, setMenuAt] = useState<MeasureMenuAt | null>(null);
  const closeMenu = useCallback(() => {
    setMenuAt(null);
  }, []);
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
    const detachPick = attachMeasurePick3d(stage, frame, setMenuAt);
    return () => {
      detachPick();
      detach();
      setSurface(null);
    };
  }, [stage, frame]);

  // where the stage has nothing under a map pick, the focused date's prepared surface gives the
  // height (tiles around the map's view, loaded ahead), so a map point never falls to 0
  const heights = useMemo(() => (projectId ? createMapHeights(projectId) : null), [projectId]);
  const focusCapture = useFocusCapture();
  const surfaces = useQa((s) => s.surfaces);
  const focusTiles = useMemo(
    () => (focusCapture ? surfaceOfCapture(surfaces, focusCapture) : null),
    [surfaces, focusCapture],
  );
  useEffect(() => {
    if (!heights) return;
    const epsg = frame?.epsg ?? null;
    const warm = () => {
      let around: EnBox | undefined;
      if (map && epsg !== null) {
        const b = map.map.getBounds();
        const sw = fromWgs84([b.getWest(), b.getSouth(), 0], epsg);
        const ne = fromWgs84([b.getEast(), b.getNorth(), 0], epsg);
        around = {
          minE: Math.min(sw[0], ne[0]),
          minN: Math.min(sw[1], ne[1]),
          maxE: Math.max(sw[0], ne[0]),
          maxN: Math.max(sw[1], ne[1]),
        };
      }
      void heights.warm(focusTiles, around);
    };
    warm();
    if (!map) return;
    map.map.on('moveend', warm);
    return () => {
      map.map.off('moveend', warm);
    };
  }, [heights, focusTiles, map, frame]);

  useEffect(() => {
    if (!map || !frame) return;
    const clampZ = stage ? stageClamp(stage, frame) : () => null;
    const detach = [
      attachMap(
        map,
        frame,
        clampZ,
        heights ? { dates: primaryMap, heights } : { dates: primaryMap },
      ),
      attachSectionMap(map, frame.epsg),
      attachOverlaysMap(map, frame.epsg),
      attachMeasurePickMap(map, frame, setMenuAt),
    ];
    return () => {
      for (const d of detach) d();
    };
  }, [map, frame, stage, heights]);

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
      <MeasureMenu at={menuAt} onClose={closeMenu} />
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
