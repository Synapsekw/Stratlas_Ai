import { installIssueOverlay, pinDisplay } from '@aio/annotate';
import { CameraLink, SceneView, type ClientRectLike, type EngineStage } from '@aio/engine';
import { setBudgetShare, splitBudget } from '@aio/pointcloud';
import { useT } from '@aio/ui';
import { VolumetricStage } from '@aio/volumetric';
import {
  scopedStore,
  useWorkspace,
  workspace,
  type CaptureIndex,
  type StoreScope,
} from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { CloudChangeLegend } from '../change/producers/CloudChangeLegend';
import { FocusZone } from '../FocusZone';
import { graphics } from '../graphics';
import { useMeasureDisplay3d } from '../survey/measureDisplay';
import { compareRuntime, drapeAllowed, useCaptureEpoch } from './compare';
import { ChangeLegends } from './MapSwipe';
import { CursorReadout, useSceneCursor } from './SceneCursor';
import { StageClassLegend, StageElevationLegend } from './StageLegends';
import { useSiteBasemapLayer } from './siteBasemap';
import type { Side } from './splitModel';
import { useStreetMap3d } from './streetMap3d';

/**
 * Layer kinds the second view leaves out: the video plays (and projects) in one view only, and a
 * retired viewer of an older project is drawn nowhere.
 */
const SECOND_VIEW_DROPS = ['video', 'legacy'] as const;

function sameSection(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Follow the main view in what is not about the date: backdrop, sun time and water, callout mode,
 * section planes and graphics quality.
 */
function mirror(from: EngineStage, to: EngineStage) {
  const e = from.environment;
  const s = to.environment;
  if (
    e.mode !== s.mode ||
    e.timeMs !== s.timeMs ||
    e.water !== s.water ||
    e.waterLevel !== s.waterLevel
  )
    to.setEnvironment({ mode: e.mode, timeMs: e.timeMs, water: e.water, waterLevel: e.waterLevel });
  if (from.labelMode !== to.labelMode) to.setLabelMode(from.labelMode);
  if (!sameSection(from.section, to.section)) to.setSection({ ...from.section });
  const q = from.quality;
  if (!sameSection(q, to.quality)) to.setQuality(q);
}

/**
 * The second 3D view of a split that compares two survey dates: its own stage (engine) showing
 * the layers of one capture, sharing parsed models with the main view, its camera linked to the
 * main view's, the same selection (a pile picked on one date is outlined on the other), issue
 * pins, sun time, section and half the point budget. It shows what the main view shows, for its
 * own date: the volumes overlay (bodies, toe lines, surface colours), the legends and the saved
 * survey measurements, all drawn only. Tools, editing, the agent and the video stay with the
 * main view.
 */
export function CompareScene({
  side,
  capture,
  index,
  main,
  linked,
  corner,
  stageRef,
  keepOut,
}: {
  side: Side;
  capture: string;
  index: CaptureIndex;
  /** The main 3D view (the active stage). */
  main: EngineStage | null;
  linked: boolean;
  corner?: ReactNode;
  stageRef: RefObject<HTMLDivElement | null>;
  keepOut: () => Iterable<ClientRectLike>;
}) {
  const t = useT();
  const scope = useMemo<StoreScope>(
    () => ({ capture, index, mode: 'drop', dropKinds: SECOND_VIEW_DROPS, camera: !linked }),
    [capture, index, linked],
  );
  // created once; the scope changes in place so the stage keeps its loaded layers
  const [store] = useState(() => scopedStore(workspace, scope));
  useEffect(() => {
    store.setScope(scope);
  }, [store, scope]);
  const [stage, setStage] = useState<EngineStage | null>(null);
  const { cursor, onMove, onLeave } = useSceneCursor(() => stage);
  const link = useRef<CameraLink | null>(null);
  // switching the link keeps the link object (it brings the views together again)
  const linkedNow = useRef(linked);
  useEffect(() => {
    linkedNow.current = linked;
    link.current?.setLinked(linked);
  }, [linked]);

  // linked cameras: orbit, pan and zoom on either view moves both
  useEffect(() => {
    if (!stage || !main) return;
    const l = new CameraLink(main, stage, linkedNow.current);
    link.current = l;
    compareRuntime.link = l;
    return () => {
      l.dispose();
      link.current = null;
      compareRuntime.link = null;
    };
  }, [stage, main]);

  // sun time, backdrop, callouts, section and quality follow the main view
  useEffect(() => {
    if (!stage || !main) return;
    mirror(main, stage);
    return main.onStateChange(() => {
      mirror(main, stage);
    });
  }, [stage, main]);

  // the offline street map under the site, as in the main view (its pack lookup is the main's)
  const project = useWorkspace((s) => s.project);
  const streetMap = useStreetMap3d();
  useSiteBasemapLayer(stage, project, streetMap.shown, false);

  // the volumes overlay of this view's date (VolumetricStage below), as the main view has it:
  // it also keeps the survey's flat ortho out of 3D. Its surface colours add a texture to this
  // view, so they ask first whether two views still fit the tier's graphics memory.
  const epoch = useCaptureEpoch(capture);
  const layerVisible = useCallback((id: string) => !store.getState().hidden[id], [store]);
  const budget = useCallback(
    (bytes: number) =>
      drapeAllowed(
        (main?.memoryEstimate() ?? 0) + (stage?.memoryEstimate() ?? 0),
        bytes,
        graphics().getState().tier,
      ),
    [main, stage],
  );

  // the saved survey measurements of the site and of this view's date
  useMeasureDisplay3d(stage, store);

  // issue pins as in the main view: those of this view's date and of no date
  useEffect(() => {
    if (!stage) return;
    return installIssueOverlay(store, pinDisplay, { scene: stage });
  }, [stage, store]);

  // callouts keep clear of the toolbars and readouts
  useEffect(() => {
    if (!stage) return;
    stage.setLabelKeepOut(keepOut);
    return () => {
      stage.setLabelKeepOut(null);
    };
  }, [stage, keepOut]);

  // two views share the point budget in proportion to their size
  useEffect(() => {
    if (!stage || !main) return;
    const share = () => {
      const a = main.renderer.domElement;
      const b = stage.renderer.domElement;
      const weights = [a.clientWidth * a.clientHeight, b.clientWidth * b.clientHeight];
      const parts = splitBudget(1_000_000, weights);
      setBudgetShare(main, (parts[0] ?? 500_000) / 1_000_000);
      setBudgetShare(stage, (parts[1] ?? 500_000) / 1_000_000);
    };
    share();
    const root = stageRef.current;
    const ro = new ResizeObserver(share);
    if (root) ro.observe(root);
    return () => {
      ro.disconnect();
      setBudgetShare(main, 1);
    };
  }, [stage, main, stageRef]);

  useEffect(() => {
    compareRuntime.second = stage;
    return () => {
      compareRuntime.second = null;
    };
  }, [stage]);

  return (
    <FocusZone
      kind="scene3d"
      className="pane pane-3d pane-compare"
      data-side={side}
      data-testid="pane-3d-compare"
      data-capture={capture}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      aria-label={t('stage.compare.secondView')}
    >
      <div className="fill">
        <SceneView className="scene-fill" store={store} primary={false} onStage={setStage} />
      </div>
      <CursorReadout text={cursor} />
      <StageElevationLegend view={stage} />
      <VolumetricStage
        stage={stage}
        epoch={epoch}
        display
        layerVisible={layerVisible}
        budget={budget}
      />
      <StageClassLegend view={stage} />
      <CloudChangeLegend view={stage} />
      <ChangeLegends store={store} />
      {corner}
    </FocusZone>
  );
}
