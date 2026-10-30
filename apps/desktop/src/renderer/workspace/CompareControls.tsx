import { changeStore, useChange } from '@aio/change';
import { MapView, type MapController, type MapIssueDisplay } from '@aio/maps';
import { Button, Icon, useT } from '@aio/ui';
import { useVolumetric, volumetric } from '@aio/volumetric';
import {
  canCompare,
  scopedStore,
  workspace,
  type CaptureIndex,
  type StoreScope,
} from '@aio/workspace';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { openChangesTab, useChangeOverlays } from '../change';
import { FocusZone } from '../FocusZone';
import { help } from '../help/store';
import { useGraphics } from '../graphics';
import { shell, useShell } from '../shell';
import { useMeasureDisplayMap } from '../survey/measureDisplay';
import { compareNotice } from './compare';
import { ChangeLegends } from './MapSwipe';
import { isTwin, type SplitModel } from './SplitPanes';
import { chooseCapture, compareSplit, PER_CAPTURE, type PaneKind, type Side } from './splitModel';

/**
 * Mount point for tools of later streams beside Compare dates while two dates show (M8): C2 adds
 * its Swipe and Blend control with one line in its own module, `COMPARE_TOOLS.push(SwipeTools)`,
 * imported once from the renderer.
 */
export const COMPARE_TOOLS: ((p: { split: SplitModel }) => ReactNode)[] = [];

export interface CompareDates {
  /** The project has two survey dates to compare. */
  available: boolean;
  /** Both sides of the split show one kind of pane, one date each. */
  twin: boolean;
  /** "Compare dates", or "Leave the comparison" while comparing. */
  label: string;
  /**
   * Compare (or leave the comparison). `captures` picks the two dates, first on the left; by
   * default the first and the last survey.
   */
  open: (captures?: readonly string[]) => void;
}

/**
 * "Compare dates": opens the split with the first survey date on the left and the last on the
 * right, as two 3D views (from 3D or the split) or two maps (from the map). On the Low graphics
 * tier one 3D view runs: the volumetric swipe, or two maps, with a notice. Again while comparing,
 * it leaves the comparison (the choice stays remembered for the split).
 */
export function useCompareDates(split: SplitModel): CompareDates {
  const t = useT();
  const mode = useShell((s) => s.stageMode);
  const tier = useGraphics((s) => s.tier);
  const volumes = useVolumetric((s) => s.status === 'ready');
  const index = split.index;
  const available = index !== null && canCompare(index);
  const twin = available && mode === 'split' && isTwin(split);
  const label = t(twin ? 'stage.compare.leave' : 'stage.compare.button');
  const open = (picked?: readonly string[]) => {
    if (!index) return;
    const sh = shell.getState();
    if (twin) {
      sh.setStageMode(split.sides.left === 'map' ? 'map' : '3d');
      return;
    }
    const captures = picked ?? index.captures.map((c) => c.id);
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
  return { available, twin, label, open };
}

/**
 * "Compare dates" beside the view modes (`useCompareDates`), and while comparing, Show changes,
 * the compare tools of later streams and "How compare works" (the chapter in Help).
 */
export function CompareButton({
  split,
  whileComparing = false,
}: {
  split: SplitModel;
  /**
   * Only what belongs to a comparison under way (the stage island, whose View row owns Compare
   * dates): Leave the comparison, Show changes, the compare tools and help; nothing otherwise.
   */
  whileComparing?: boolean;
}) {
  const t = useT();
  const { available, twin, label, open } = useCompareDates(split);
  // "Show changes": change pins on the compared views (and on one view outside the comparison)
  useChangeOverlays(split);
  const showChanges = useChange((s) => s.show);
  if (!available || (whileComparing && !twin && !showChanges)) return null;

  return (
    <div className="compare-group">
      <div className="tgroup-h overlay-box" data-fixed="">
        {(!whileComparing || twin) && (
          <button
            type="button"
            className="tool"
            data-testid="compare-dates"
            aria-pressed={twin}
            aria-label={label}
            onClick={() => {
              open();
            }}
          >
            <Icon name="history" />
            <span className="tip">{label}</span>
          </button>
        )}
        {(twin || showChanges) && (
          <button
            type="button"
            className="tool"
            data-testid="compare-show-changes"
            aria-pressed={showChanges}
            aria-label={t(showChanges ? 'change.hide' : 'change.show')}
            onClick={() => {
              const on = !showChanges;
              changeStore.getState().setShow(on);
              if (on) {
                openChangesTab();
                shell.getState().setRight(false);
              }
            }}
          >
            <Icon name="flag" />
            <span className="tip">{t(showChanges ? 'change.hide' : 'change.show')}</span>
          </button>
        )}
        {twin && COMPARE_TOOLS.map((Tool, i) => <Tool key={i} split={split} />)}
        {/* a window under 1280 px: "How compare works" folds into the tools row as a "?", so
            the group beside the island is no wider than its tools (styles.css) */}
        {twin && (
          <button
            type="button"
            className="tool compare-how-q"
            aria-label={t('compare.how')}
            onClick={() => {
              help.getState().openHelp({ chapter: 'compare-dates' });
            }}
          >
            <span aria-hidden="true">?</span>
            <span className="tip">{t('compare.how')}</span>
          </button>
        )}
      </div>
      {/* under the tools, so the group stays narrow beside the island */}
      {twin && (
        <Button
          variant="link"
          className="compare-how overlay-box"
          data-help="compare-dates"
          onClick={() => {
            help.getState().openHelp({ chapter: 'compare-dates' });
          }}
        >
          {t('compare.how')}
        </Button>
      )}
    </div>
  );
}

/**
 * The second map of a split comparing two dates: its date's ortho over the basemap, the saved
 * survey measurements of the site and of its date (drawn only), and the legend of a change heat
 * map it shows. Drawing and the measure tools stay with the main map.
 */
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
  const [map, setMap] = useState<MapController | null>(null);
  const onMap = useCallback(
    (c: MapController | null) => {
      setMap(c);
      onController(c);
    },
    [onController],
  );
  useMeasureDisplayMap(map, store);
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
          onController={onMap}
        />
      </div>
      <ChangeLegends store={store} />
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
    if (e && e !== v.epoch) v.setEpoch(e);
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
