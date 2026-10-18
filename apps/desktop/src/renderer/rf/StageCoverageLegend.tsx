/**
 * The coverage card on the stage (d-ba ruling I3, option b; spec F1 revised): `Stage.tsx` gives it
 * one corner slot (`rfLegend`, a foot corner away from the readout) while `useCoverageLegendShown()`
 * holds, and renders `<StageCoverageLegend />` there: the Coverage chip, and the legend under it.
 * Everything the card shows is read here, from the RF stores, so the stage's block stays small.
 */
import { useT } from '@aio/ui';
import { useVolumeHint } from '@aio/volumetric';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useRoad } from '../road/store';
import { useShell } from '../shell';
import { useCaptureIndex, useCompareNotice, useSplitDates } from '../workspace/compare';
import { datesOnScreen } from '../workspace/DatesOnScreen';
import { DEFAULT_SPLIT, twinAllowed } from '../workspace/splitModel';
import { useStagePrefs } from '../workspace/stagePrefs';
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

/** Two survey dates are compared: the split shows one kind of pane twice, one date each. */
function useDatesCompared(): boolean {
  const mode = useShell((s) => s.stageMode);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const saved = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.split : undefined));
  const dates = useSplitDates(useCaptureIndex());
  const pref = saved ?? DEFAULT_SPLIT;
  return mode === 'split' && pref.left === pref.right && twinAllowed(pref.left, dates);
}

/**
 * Before a run the card is only the chip's prompt, so it does not take a corner the survey dates
 * pill or the 3D view's coordinates readout would lose. `Stage.tsx` serves the card before both
 * and tells RF nothing about the other overlays, so the rule is the conservative one, from what RF
 * can read: no card while the dates pill shows beside a status chip (the compare notice, the
 * cut-away chip or the road measuring bar take the top start corner) or a floating video, and no
 * card while a 3D view shows its readout beside the volumes hint or a floating video (either takes
 * the foot corner the card would have, leaving it the readout's). The island reaching across the
 * top corners is not known here. Auto-plan stays reachable from the Coverage panel's status line
 * and Ctrl+K.
 */
function useCornersCrowded(): boolean {
  const mode = useShell((s) => s.stageMode);
  const docked = useShell((s) => s.videoDocked);
  const videoHidden = useShell((s) => s.videoHidden);
  const activeClip = useWorkspace((s) => s.activeClip);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const saved = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.split : undefined));
  const index = useTimeline((s) => s.index);
  const hidden = useWorkspace((s) => s.hidden);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const notice = useCompareNotice();
  const cutawayEngaged = useCutawayState((s) => s.engaged);
  const inside = useCutawayState((s) => s.inside);
  const { mode: cutawayMode } = useCutawayPref();
  const measuring = useRoad((s) => Boolean(s.measure.mode));
  const volHint = useVolumeHint();
  const splitting = mode === 'split';
  const pref = saved ?? DEFAULT_SPLIT;
  const show3d = mode === '3d' || (splitting && (pref.left === '3d' || pref.right === '3d'));
  const showMap = mode === 'map' || (splitting && (pref.left === 'map' || pref.right === 'map'));
  const dates = useMemo(
    () =>
      !splitting &&
      !!index &&
      !!layers &&
      datesOnScreen(index, hidden, layers, DATE_KINDS).length >= 2,
    [splitting, index, hidden, layers],
  );
  const video = activeClip !== null && !videoHidden && !docked;
  const cutaway = show3d && ((cutawayEngaged && cutawayMode !== 'off') || inside);
  const status = notice !== null || cutaway || (showMap && measuring);
  return (dates && (status || video)) || (show3d && (volHint || video));
}

/**
 * Whether the stage gives the coverage card a corner. After a run (the layer is on and draws
 * something) the legend keeps its place before the dates and the readout. Before one, the card is
 * the chip alone (the project has antennas, spec F1 revised), and it shows only where it costs
 * the dates pill and the readout nothing (`useCornersCrowded`). Never while two dates are
 * compared: the comparison has the stage.
 */
export function useCoverageLegendShown(): boolean {
  const chip = useChipState().kind !== 'hidden';
  const drawn = useCoverageLegendProps() !== null;
  const compared = useDatesCompared();
  const crowded = useCornersCrowded();
  if (compared) return false;
  return drawn || (chip && !crowded);
}

/**
 * The coverage card in its stage corner: the Coverage chip as its header, and under it the legend
 * while the layer draws something. While dates are compared the stage gives it no corner.
 */
export function StageCoverageLegend() {
  const t = useT();
  const p = useCoverageLegendProps();
  const chip = useChipState().kind !== 'hidden';
  if (p) return <CoverageLegend {...p} header={chip ? <CoverageChip /> : null} />;
  if (!chip) return null;
  return (
    <section
      className="rf-card overlay-box"
      data-surface="dark"
      aria-label={t('rf.chip.label')}
      data-testid="rf-card"
    >
      <CoverageChip />
    </section>
  );
}
