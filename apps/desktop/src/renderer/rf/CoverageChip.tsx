/**
 * The Coverage chip on the stage (spec F1, "The Coverage chip"): a pill in a row of its own at the
 * top centre of the stage, under the island's date pill, once the project has antennas. It reads
 * the chip state (`selectChipState`) and offers the next step: Review antennas, Auto-plan, Run,
 * or after a run the layer toggle (the Display bench Coverage eye's state) and Re-plan. Clicking
 * the chip opens the Coverage tab pinned. On a narrow stage it keeps the dot, the word Coverage
 * and the buttons. `Stage.tsx` renders it with one line in its RF block; rf.css places the row
 * and moves the top-start corner slot and a split's pane headers below it.
 */
import type { AntennaUnit } from '@aio/schema';
import { Button, useT, type MessageKey } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useAntennas } from '../telecom/antennaStore';
import {
  openAntennaReviewOrFallback,
  selectChipState,
  startAutoplan,
  useAutoplan,
  type ChipState,
} from './autoplan/autoplanStore';
import { setRfLayer, useRfLayer } from './coverageDisplay';
import { openCoverage, startRfRun } from './rfTab';
import { useRf, type RfState, type RfView } from './rfStore';
import './rf.css';

/** Below this row width (the stage less its margins) the chip drops its descriptive text. */
export const NARROW_CHIP_PX = 560;

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
  const classStats = useRf((s) => s.classStats);
  const view = useRf((s) => s.view);
  const sectors = useRf((s) => s.sectors);
  const autoplan = useAutoplan((s) => s);
  return useMemo(() => {
    // selectChipState reads only these fields of the RF state
    const rf = { running, selectedRunId, runs, dirty, classStats, view, sectors } as RfState;
    return selectChipState(rf, units, autoplan);
  }, [units, running, selectedRunId, runs, dirty, classStats, view, sectors, autoplan]);
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

/** The row's width as laid out (0 until it is), kept up to date. */
function useRowWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      setWidth(el.clientWidth);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [el]);
  return [
    useCallback((n: HTMLDivElement | null) => {
      setEl(n);
    }, []),
    width,
  ];
}

export function CoverageChip() {
  const t = useT();
  const s = useChipState();
  const visible = useRfLayer((l) => l.visible);
  const [rowRef, rowWidth] = useRowWidth();
  if (s.kind === 'hidden') return null;
  // not laid out yet (0): the words show
  const narrow = rowWidth > 0 && rowWidth < NARROW_CHIP_PX;

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
      parts.push(t('rf.chip.running'));
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

  return (
    <div ref={rowRef} className="rf-chip-row" data-surface="dark">
      <div
        className="ss-chip rf-chip"
        data-testid="rf-chip"
        data-state={s.kind}
        data-narrow={narrow ? '' : undefined}
      >
        <button
          type="button"
          className="rf-chip-open"
          data-testid="rf-chip-open"
          aria-label={label + desc}
          onClick={() => {
            openCoverage();
          }}
        >
          <span className="rf-chip-dot" aria-hidden="true" />
          <span className="rf-chip-name">{label}</span>
          {!narrow && <span className="rf-chip-desc">{desc}</span>}
        </button>
        {s.kind === 'review-first' && (
          <Button
            className="rf-chip-btn"
            data-testid="rf-chip-review"
            onClick={() => {
              openAntennaReviewOrFallback();
            }}
          >
            {t('rf.chip.review')}
          </Button>
        )}
        {s.kind === 'not-planned' && (
          <Button
            variant="primary"
            className="rf-chip-btn rf-chip-ai"
            data-testid="rf-chip-autoplan"
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
            className="rf-chip-btn"
            data-testid="rf-chip-run"
            icon="play"
            onClick={run}
          >
            {t('rf.chip.run')}
          </Button>
        )}
        {s.kind === 'result' && (
          <>
            <Button
              variant="icon"
              className="rf-chip-btn"
              data-testid="rf-chip-layer"
              icon={visible ? 'eye' : 'eye-off'}
              pressed={visible}
              aria-label={t('rf.chip.layer')}
              tip={t('rf.chip.layer')}
              onClick={() => {
                setRfLayer({ visible: !visible });
              }}
            />
            <Button
              className="rf-chip-btn"
              data-testid="rf-chip-replan"
              tip={t('rf.chip.replanTip')}
              onClick={autoplan}
            >
              {t('rf.chip.replan')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
