/**
 * The Coverage chip (spec F1, revised 18 Oct): the status line of RF coverage, from the chip state
 * (`selectChipState`), with the next step as a button: Review antennas, Auto-plan, Run, or after a
 * run the layer toggle (the Display bench Coverage eye's state) and Re-plan.
 *
 * - `stage`: the header of the coverage card in the stage's `rfLegend` corner (StageCoverageLegend).
 *   Its words open the Coverage tab pinned. On a narrow stage it keeps the dot, the word Coverage
 *   and the buttons; the words stay in the accessible name.
 * - `panel`: the same line at the top of the Coverage panel, read only, with the same primary
 *   action (no layer toggle: the panel's Display controls have it).
 * - A read-only project gets no Auto-plan or Re-plan (`canAutoplan`): it could not take the plan.
 */
import type { AntennaUnit } from '@aio/schema';
import { Button, useT, type MessageKey } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { jobs } from '../shell';
import { useAntennas } from '../telecom/antennaStore';
import {
  canAutoplan,
  openAntennaReviewOrFallback,
  selectChipState,
  startAutoplan,
  useAutoplan,
  type AutoplanState,
  type ChipState,
} from './autoplan/autoplanStore';
import { setRfLayer, useRfLayer } from './coverageDisplay';
import { openCoverage, startRfRun } from './rfTab';
import { useRf, type RfState, type RfView } from './rfStore';
import './rf.css';

/** Below this width of the stage's views the stage chip drops its descriptive text. */
export const NARROW_STAGE_PX = 640;

const VIEW_KEY: Record<RfView, MessageKey> = {
  rsrp: 'rf.results.view.rsrp',
  bestServer: 'rf.results.view.bestServer',
  overlap: 'rf.results.view.overlap',
};

/** The detected units: the inventory store's when it holds this project, else the RF store's. */
function useAntennaUnits(): readonly AntennaUnit[] | null {
  const rfProject = useRf((s) => s.projectId);
  const rfUnits = useRf((s) => s.antennas?.units ?? null);
  const invProject = useAntennas((s) => s.projectId);
  const invUnits = useAntennas((s) => s.file?.units ?? null);
  if (invUnits && invProject === rfProject) return invUnits;
  return rfUnits;
}

/** The chip's state from the RF store, the detected units and Auto-plan (also Ctrl+K's). */
export function useChipState(): ChipState {
  const units = useAntennaUnits();
  const running = useRf((s) => s.running);
  const selectedRunId = useRf((s) => s.selectedRunId);
  const runs = useRf((s) => s.runs);
  const dirty = useRf((s) => s.dirty);
  const planChangedSinceRun = useRf((s) => s.planChangedSinceRun);
  const classStats = useRf((s) => s.classStats);
  const view = useRf((s) => s.view);
  const sectors = useRf((s) => s.sectors);
  // Auto-plan's phase is all the chip reads of it
  const phase = useAutoplan((s) => s.phase);
  return useMemo(() => {
    const rf = {
      running,
      selectedRunId,
      runs,
      dirty,
      planChangedSinceRun,
      classStats,
      view,
      sectors,
    } as RfState;
    return selectChipState(rf, units, { phase } as AutoplanState);
  }, [
    units,
    running,
    selectedRunId,
    runs,
    dirty,
    planChangedSinceRun,
    classStats,
    view,
    sectors,
    phase,
  ]);
}

/** The running coverage job's progress, 0 to 100; null when unknown. */
function useRunPercent(): number | null {
  const jobId = useRf((s) => s.jobId);
  return useStore(jobs, (s) => {
    const p = jobId ? s.jobs.find((j) => j.id === jobId)?.progress : undefined;
    return p === undefined ? null : Math.round(p * 100);
  });
}

/** A run's time of day, as the stage legend's title shows it. */
function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Auto-plan (or Re-plan): its review dialog lives in the Coverage tab, so the tab opens too. */
function autoplan(): void {
  openCoverage();
  void startAutoplan();
}

function run(): void {
  const root = workspace.getState().project?.root;
  if (!root) return;
  // a refused start leaves the tab open on why (a started run opens it itself)
  void startRfRun(root).then((r) => {
    if (!r.ok) openCoverage();
  });
}

/** The width of the stage's views around `el` (0 until laid out, or outside a stage). */
function useViewsWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const views = el?.closest<HTMLElement>('.stage-views');
    if (!views) return;
    const read = () => {
      setWidth(views.clientWidth);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(views);
    return () => {
      ro.disconnect();
    };
  }, [el]);
  return [
    useCallback((n: HTMLElement | null) => {
      setEl(n);
    }, []),
    width,
  ];
}

export function CoverageChip({ variant = 'stage' }: { variant?: 'stage' | 'panel' }) {
  const t = useT();
  const s = useChipState();
  // a read-only project could not take a plan: no Auto-plan or Re-plan (the panel says why)
  const readOnly = useRf((r) => r.readOnly);
  const plan = canAutoplan(s, readOnly);
  const visible = useRfLayer((l) => l.visible);
  const percent = useRunPercent();
  const [ref, viewsWidth] = useViewsWidth();
  if (s.kind === 'hidden') return null;
  const stage = variant === 'stage';
  // not laid out yet (0): the words show
  const narrow = stage && viewsWidth > 0 && viewsWidth < NARROW_STAGE_PX;

  const parts: string[] = [];
  switch (s.kind) {
    case 'review-first':
      parts.push(t('rf.chip.antennas', { count: s.total }), t('rf.chip.reviewFirst'));
      break;
    case 'not-planned':
      parts.push(t('rf.chip.antennas', { count: s.accepted }), t('rf.chip.notPlanned'));
      break;
    case 'ready':
      parts.push(t('rf.chip.sectors', { count: s.sectors }), t('rf.chip.ready'));
      break;
    case 'planning':
      parts.push(t('rf.chip.planning'));
      break;
    case 'running':
      parts.push(
        percent !== null && percent > 0
          ? t('rf.chip.runningPct', { pct: percent })
          : t('rf.chip.running'),
      );
      break;
    case 'result':
      parts.push(t(VIEW_KEY[s.view]));
      // the share reads the RSRP classes; another view says which one shows instead
      if (s.view === 'rsrp' && s.fairOrBetterPct !== null)
        parts.push(t('rf.chip.fairOrBetter', { pct: s.fairOrBetterPct }));
      parts.push(timeOfDay(s.at));
      break;
  }
  const sep = ' · ';
  const desc = sep + parts.join(sep);
  const label = t('rf.chip.label');
  const words = (
    <>
      <span className="rf-chip-dot" aria-hidden="true" />
      <span className="rf-chip-name">{label}</span>
      {/* planning and running have no button: their few words stay on a narrow stage */}
      {(!narrow || s.kind === 'planning' || s.kind === 'running') && (
        <span className="rf-chip-desc">{desc}</span>
      )}
    </>
  );

  return (
    <div
      ref={ref}
      className="rf-chip"
      data-testid={stage ? 'rf-chip' : 'rf-chip-panel'}
      data-variant={variant}
      data-state={s.kind}
      data-narrow={narrow ? '' : undefined}
      role={stage ? undefined : 'status'}
    >
      {stage ? (
        <button
          type="button"
          className="rf-chip-open"
          data-testid="rf-chip-open"
          aria-label={label + desc}
          onClick={() => {
            openCoverage();
          }}
        >
          {words}
        </button>
      ) : (
        <span className="rf-chip-open">{words}</span>
      )}
      <span className="rf-chip-acts">
        {s.kind === 'review-first' && (
          <Button
            data-testid={stage ? 'rf-chip-review' : 'rf-chip-panel-review'}
            onClick={() => {
              openAntennaReviewOrFallback();
            }}
          >
            {t('rf.chip.review')}
          </Button>
        )}
        {s.kind === 'not-planned' && plan && (
          <Button
            variant="primary"
            className="rf-chip-ai"
            data-testid={stage ? 'rf-chip-autoplan' : 'rf-chip-panel-autoplan'}
            tip={t('rf.chip.autoplanTip')}
            onClick={autoplan}
          >
            <span className="rf-chip-spark" aria-hidden="true">
              ✦
            </span>
            {t('rf.chip.autoplan')}
          </Button>
        )}
        {s.kind === 'ready' && (
          <Button
            variant="primary"
            data-testid={stage ? 'rf-chip-run' : 'rf-chip-panel-run'}
            icon="play"
            onClick={run}
          >
            {t('rf.chip.run')}
          </Button>
        )}
        {s.kind === 'result' && stage && (
          <Button
            variant="icon"
            data-testid="rf-chip-layer"
            icon={visible ? 'eye' : 'eye-off'}
            pressed={visible}
            aria-label={t('rf.chip.layer')}
            tip={t('rf.chip.layer')}
            onClick={() => {
              setRfLayer({ visible: !visible });
            }}
          />
        )}
        {s.kind === 'result' && plan && (
          <Button
            data-testid={stage ? 'rf-chip-replan' : 'rf-chip-panel-replan'}
            tip={t('rf.chip.replanTip')}
            onClick={autoplan}
          >
            {t('rf.chip.replan')}
          </Button>
        )}
      </span>
    </div>
  );
}
