/**
 * The coverage card on the stage (d-ba ruling I3, option b; spec F1 revised): `Stage.tsx` gives it
 * one corner slot (`rfLegend`, a foot corner away from the readout) while `useCoverageLegendShown()`
 * holds, and renders `<StageCoverageLegend />` there: the Coverage chip, and the legend under it.
 * Everything the card shows is read here, from the RF stores, so the stage's block stays small.
 */
import { useT } from '@aio/ui';
import { useVolumeHint } from '@aio/volumetric';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { createStore, useStore } from 'zustand';
import { useRoad } from '../road/store';
import { useShell } from '../shell';
import { useAntennaClouds } from '../telecom/AntennaRunner';
import { useAntennas } from '../telecom/antennaStore';
import { useCompareNotice } from '../workspace/compare';
import { datesOnScreen } from '../workspace/DatesOnScreen';
import { isTwin, useSplit } from '../workspace/SplitPanes';
import { sideOf, sidesOf } from '../workspace/splitModel';
import { useTimeline } from '../workspace/timeline';
import { useCutawayPref, useCutawayState } from '../workspace/useCutaway';
import { CoverageChip, useChipState } from './CoverageChip';
import { CoverageLegend, type CoverageLegendProps } from './CoverageLegend';
import { useRfLayer } from './coverageDisplay';
import { shownGrids, useCoverage } from './coverageStore';
import { useRf } from './rfStore';

/** A run's time of day, as the legend's title tag shows it. */
function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** The legend's props for what the Coverage layer draws now; null when it draws nothing. */
export function useCoverageLegendProps(): CoverageLegendProps | null {
  const visible = useRfLayer((s) => s.visible);
  const dirty = useRf((s) => s.dirty);
  const grids = useCoverage((c) => shownGrids(c, { dirty }));
  const view = useRf((s) => s.view);
  const sectors = useRf((s) => s.sectors);
  const runs = useRf((s) => s.runs);
  const selectedRunId = useRf((s) => s.selectedRunId);
  return useMemo(() => {
    if (!visible || !grids) return null;
    const run =
      grids.source === 'run' ? (runs.find((r) => r.runId === selectedRunId) ?? null) : null;
    // a run is drawn with the study and sector names it ran with; the preview with the edits
    const file = run ? run.inputs.sectors : sectors;
    const names = new Map(file.sectors.map((s) => [s.id, s.name]));
    return {
      view,
      study: file.study,
      // in the drawn grid's sector order, which the best-server colours follow
      sectors: grids.sectorIds.map((id) => ({ id, name: names.get(id) ?? id })),
      // the run's time of day keeps the title on one line (the RF tab names the whole date)
      source: run ? { kind: 'run', at: timeOfDay(run.createdAt) } : { kind: 'preview' },
      reduced: grids.reducedFrom ?? null,
    };
  }, [visible, grids, view, sectors, runs, selectedRunId]);
}

/** The layer kinds whose survey dates the stage's dates pill lists (as `Stage.tsx` asks). */
const DATE_KINDS = ['mesh', 'pointcloud', 'raster', 'vector', 'panoramas'] as const;

/**
 * The stage's panes as `Stage.tsx` draws them, read the same way (`useSplit`, which resolves the
 * remembered split against the panes the project offers).
 */
function useStagePanes() {
  const mode = useShell((s) => s.stageMode);
  const split = useSplit();
  const splitting = mode === 'split';
  const sides = split.sides;
  return {
    splitting,
    show3d: mode === '3d' || (splitting && sidesOf(sides, '3d').length > 0),
    showMap: mode === 'map' || (splitting && sidesOf(sides, 'map').length > 0),
    videoPane: splitting && sideOf(sides, 'video') !== undefined,
    // two survey dates compared: one kind of pane twice, one date each (CompareControls `twin`)
    compared: splitting && isTwin(split),
  };
}

/**
 * Before a run the card is only the chip's prompt, so it does not take a corner the survey dates
 * pill or the 3D view's coordinates readout would lose. `Stage.tsx` serves the card before both
 * and tells RF nothing about the other overlays, so the rule is the conservative one, from what RF
 * can read:
 * - no card while the dates pill shows beside a status chip (the compare notice, the cut-away
 *   chip or the road measuring bar take the top start corner) or a floating video;
 * - no card while a 3D view shows its readout beside the volumes hint or a floating video (either
 *   takes the foot corner the card would have, leaving it the readout's);
 * - no card in a split with a 3D view while a status chip is up (with the map on the start side
 *   the Map menu chip takes the start foot once the status has the top start corner).
 * A video shown as a split pane does not float. The island reaching across the top corners is not
 * known here. Auto-plan stays reachable from the Coverage panel's status line and Ctrl+K.
 */
function useCornersCrowded(panes: ReturnType<typeof useStagePanes>): boolean {
  const { splitting, show3d, showMap, videoPane } = panes;
  const docked = useShell((s) => s.videoDocked);
  const videoHidden = useShell((s) => s.videoHidden);
  const activeClip = useWorkspace((s) => s.activeClip);
  const index = useTimeline((s) => s.index);
  const hidden = useWorkspace((s) => s.hidden);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const notice = useCompareNotice();
  const cutawayEngaged = useCutawayState((s) => s.engaged);
  const inside = useCutawayState((s) => s.inside);
  const { mode: cutawayMode } = useCutawayPref();
  const measuring = useRoad((s) => Boolean(s.measure.mode));
  const volHint = useVolumeHint();
  const dates = useMemo(
    () =>
      !splitting &&
      !!index &&
      !!layers &&
      datesOnScreen(index, hidden, layers, DATE_KINDS).length >= 2,
    [splitting, index, hidden, layers],
  );
  const video = activeClip !== null && !videoHidden && !docked && !videoPane;
  const cutaway = show3d && ((cutawayEngaged && cutawayMode !== 'off') || inside);
  const status = notice !== null || cutaway || (showMap && measuring);
  return (
    (dates && (status || video)) ||
    (show3d && (volHint || video)) ||
    (splitting && show3d && status)
  );
}

// ---------------------------------------------------------------- beside the antenna card

/**
 * The selected unit's floating card (telecom/AntennaCard): it stands beside its box wherever the
 * box is on screen and keeps clear of the antennas' Labels control only, so the coverage card
 * keeps clear of it. Read from the page: the card is drawn in the 3D view's own box.
 */
const ANTENNA_CARD = '[data-testid="antenna-card"]';
/** The room kept between the coverage card and the antenna card, px. */
const CLEAR_PX = 4;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const boxOf = (el: Element): Box | null => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
};

const hits = (a: Box, b: Box) =>
  a.left < b.right + CLEAR_PX &&
  b.left < a.right + CLEAR_PX &&
  a.top < b.bottom + CLEAR_PX &&
  b.top < a.bottom + CLEAR_PX;

/**
 * The coverage card's box as last drawn (kept while the card is off the stage, where it would
 * stand), and whether the antenna card is over it now (`useAntennaCardWatch`).
 */
const cardSpot: { el: HTMLElement | null; box: Box | null } = { el: null, box: null };
const clashStore = createStore<{ clash: boolean }>()(() => ({ clash: false }));

/** The coverage card's root element: measured where it stands. */
function spotRef(el: HTMLElement | null): void {
  cardSpot.el = el;
  if (el) cardSpot.box = boxOf(el) ?? cardSpot.box;
}

/** Whether a selected unit's card is up: the antennas drawn in a 3D view on screen (AntennaRunner). */
function useAntennaCardUp(): boolean {
  const selected = useAntennas((a) => a.selected !== null && a.file !== null);
  const clouds = useAntennaClouds().length > 0;
  const onScene = useShell((s) => s.screen === 'scene' && s.stageMode !== 'map');
  return selected && clouds && onScene;
}

/**
 * While a unit's card is up, follows it frame by frame (it moves with the camera) and tells
 * whether it is over the coverage card, or over where the card stood before it stepped aside.
 */
function useAntennaCardWatch(): boolean {
  const up = useAntennaCardUp();
  const clash = useStore(clashStore, (s) => s.clash);
  useEffect(() => {
    const set = (v: boolean) => {
      if (clashStore.getState().clash !== v) clashStore.setState({ clash: v });
    };
    if (!up) {
      set(false);
      return;
    }
    let frame = 0;
    const tick = () => {
      if (cardSpot.el?.isConnected) cardSpot.box = boxOf(cardSpot.el) ?? cardSpot.box;
      const card = document.querySelector(ANTENNA_CARD);
      const at = card ? boxOf(card) : null;
      set(at !== null && cardSpot.box !== null && hits(cardSpot.box, at));
      frame = requestAnimationFrame(tick);
    };
    tick();
    // the stage resized while the card was off it: where it stood is no longer known, so it
    // comes back and is measured afresh (and steps aside again if the card is still over it)
    const onResize = () => {
      if (!cardSpot.el?.isConnected) cardSpot.box = null;
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [up]);
  return up && clash;
}

/**
 * Whether the stage gives the coverage card a corner. After a run (the layer is on and draws
 * something) the legend keeps its place before the dates and the readout; a selected antenna's
 * card over it hides it in place (`StageCoverageLegend`). Before one, the card is the chip alone
 * (the project has antennas, spec F1 revised), and it shows only where it costs the dates pill
 * and the readout nothing (`useCornersCrowded`) and where a selected antenna's card is not over
 * it: the prompt gives its corner up to the antenna review. Never while two dates are compared:
 * the comparison has the stage.
 */
export function useCoverageLegendShown(): boolean {
  const chip = useChipState().kind !== 'hidden';
  const drawn = useCoverageLegendProps() !== null;
  const panes = useStagePanes();
  const crowded = useCornersCrowded(panes);
  const underCard = useAntennaCardWatch();
  if (panes.compared) return false;
  return drawn || (chip && !crowded && !underCard);
}

/**
 * The coverage card in its stage corner: the Coverage chip as its header, and under it the legend
 * while the layer draws something. While dates are compared the stage gives it no corner. A
 * selected antenna's card over the legend hides it in place, the corner kept.
 */
export function StageCoverageLegend() {
  const t = useT();
  const p = useCoverageLegendProps();
  const chip = useChipState().kind !== 'hidden';
  const clash = useStore(clashStore, (s) => s.clash);
  const up = useAntennaCardUp();
  // as the watcher reads it: only while a unit's card can be up
  const covered = up && clash;
  if (p)
    return (
      <CoverageLegend
        {...p}
        header={chip ? <CoverageChip /> : null}
        boxRef={spotRef}
        covered={covered}
      />
    );
  if (!chip) return null;
  return (
    <section
      ref={spotRef}
      className="rf-card overlay-box"
      data-surface="dark"
      aria-label={t('rf.chip.label')}
      data-testid="rf-card"
    >
      <CoverageChip />
    </section>
  );
}
