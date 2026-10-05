import { MapView, type MapController, type MapIssueDisplay } from '@aio/maps';
import { Icon, useT } from '@aio/ui';
import { useVolumetric, volumetric } from '@aio/volumetric';
import {
  canCompare,
  scopedStore,
  workspace,
  type CaptureIndex,
  type StoreScope,
} from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FocusZone } from '../FocusZone';
import { useGraphics } from '../graphics';
import { shell, useShell } from '../shell';
import { compareNotice } from './compare';
import { isTwin, type SplitModel } from './SplitPanes';
import { chooseCapture, compareSplit, PER_CAPTURE, type PaneKind, type Side } from './splitModel';

/**
 * "Compare dates" beside the view modes: opens the split with the first survey date on the left
 * and the last on the right, as two 3D views (from 3D or the split) or two maps (from the map).
 * On the Low graphics tier one 3D view runs: the volumetric swipe, or two maps, with a notice.
 * Pressed again, it leaves the comparison (the choice stays remembered for the split).
 */
export function CompareButton({ split }: { split: SplitModel }) {
  const t = useT();
  const mode = useShell((s) => s.stageMode);
  const tier = useGraphics((s) => s.tier);
  const volumes = useVolumetric((s) => s.status === 'ready');
  const index = split.index;
  if (!index || !canCompare(index)) return null;
  const twin = mode === 'split' && isTwin(split);
  const captures = index.captures.map((c) => c.id);
  const label = t(twin ? 'stage.compare.leave' : 'stage.compare.button');

  const open = () => {
    const sh = shell.getState();
    if (twin) {
      sh.setStageMode(split.sides.left === 'map' ? 'map' : '3d');
      return;
    }
    const kind: PaneKind =
      mode === 'map'
        ? 'map'
        : mode === 'split' && PER_CAPTURE.includes(split.sides.left)
          ? split.sides.left
          : '3d';
    if (kind === '3d' && tier === 'low') {
      if (volumes) {
        sh.setStageMode('3d');
        volumetric.getState().setSwipe(true);
        compareNotice.getState().show(t('stage.compare.lowTierSwipe'));
        return;
      }
      split.set(compareSplit(split.sides, 'map', { captures }));
      sh.setStageMode('split');
      compareNotice.getState().show(t('stage.compare.lowTierMaps'));
      return;
    }
    compareNotice.getState().clear();
    split.set(compareSplit(split.sides, kind, { captures }));
    sh.setStageMode('split');
  };

  return (
    <div className="tgroup-h overlay-box" data-fixed="">
      <button
        type="button"
        className="tool"
        data-testid="compare-dates"
        aria-pressed={twin}
        aria-label={label}
        onClick={open}
      >
        <Icon name="history" />
        <span className="tip">{label}</span>
      </button>
    </div>
  );
}

/** The second map of a split comparing two dates: its date's ortho over the basemap. */
export function CompareMap({
  side,
  capture,
  index,
  issues,
  onController,
  corner,
}: {
  side: Side;
  capture: string;
  index: CaptureIndex;
  issues: MapIssueDisplay;
  onController: (c: MapController | null) => void;
  corner?: ReactNode;
}) {
  const scope = useMemo<StoreScope>(
    () => ({ capture, index, mode: 'hide', camera: true }),
    [capture, index],
  );
  const [store] = useState(() => scopedStore(workspace, scope));
  useEffect(() => {
    store.setScope(scope);
  }, [store, scope]);
  return (
    <FocusZone
      kind="map"
      className="pane pane-map pane-compare"
      data-side={side}
      data-testid="pane-map-compare"
      data-capture={capture}
    >
      <div className="fill">
        <MapView
          className="scene-fill"
          issues={issues}
          store={store}
          primary={false}
          onController={onController}
          cameraWedge={false}
        />
      </div>
      {corner}
    </FocusZone>
  );
}

/**
 * The volumes panel and the main 3D view show the same survey: a date picked on the pane moves
 * the panel, a date picked in the panel moves the pane.
 */
export function useVolumesFollowDate(
  split: SplitModel,
  side: Side | undefined,
  capture: string | undefined,
): void {
  const status = useVolumetric((s) => s.status);
  const epoch = useVolumetric((s) => s.epoch);
  const latest = useRef({ split, side, capture });
  useEffect(() => {
    latest.current = { split, side, capture };
  });
  // the pane's date to the panel
  useEffect(() => {
    if (status !== 'ready' || !capture) return;
    const v = volumetric.getState();
    const e = v.file?.captures.find((c) => c.captureId === capture)?.epoch;
    if (e && e !== v.epoch && !v.edit) v.setEpoch(e);
  }, [status, capture]);
  // the panel's date to the pane
  useEffect(() => {
    const { split: sp, side: sd, capture: cap } = latest.current;
    const v = volumetric.getState();
    if (v.status !== 'ready' || !sd || !cap || !sp.dates) return;
    const c = v.file?.captures.find((x) => x.epoch === v.epoch)?.captureId;
    if (c && c !== cap && sp.dates.captures.includes(c))
      sp.set(chooseCapture(sp.sides, sd, c, sp.dates));
  }, [epoch]);
}
