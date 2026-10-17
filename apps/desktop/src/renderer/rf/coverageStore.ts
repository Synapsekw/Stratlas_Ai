/**
 * What the Coverage layer shows (spec D15, D16, D18): the selected run's grids, read from its
 * GeoTIFFs, or, while the working copy has changes, a live preview worked out in the preview
 * Worker from the store's resolved carriers. Whichever is shown also gives the Results class
 * table its areas (`setClassStats`). The preview's readiness is the store's `preview` state,
 * which gates Save as new run in the tab.
 *
 * `startCoverage(deps)` follows the stores until its stop function is called (the layer mount).
 */
import { msiToTwoCut, parseMsi, type TwoCutPattern } from '@aio/rf';
import type { RfRun } from '@aio/schema';
import { createStore, useStore } from 'zustand';
import {
  classStatsOf,
  gridsFromPreview,
  gridsFromRun,
  runFile,
  type CoverageGrids,
} from './coverageGrids';
import { previewPlan, patternKey, type PreviewPlan } from './previewInput';
import type { PreviewClient } from './previewClient';
import { rfStore, setClassStats, setPreviewState, type RfState } from './rfStore';

export interface CoverageState {
  /** The selected run's grids once read; null while reading, without a run, or when it failed. */
  run: CoverageGrids | null;
  /** Why the selected run's grids could not be read. */
  runError: string | null;
  /** The live preview's grids, while the working copy has changes and the preview is ready. */
  preview: CoverageGrids | null;
  /** The participants of the shown preview (for the boresight arrows). */
  previewSources: PreviewPlan['sources'];
}

export const coverage = createStore<CoverageState>()(() => ({
  run: null,
  runError: null,
  preview: null,
  previewSources: [],
}));

export function useCoverage<T>(selector: (s: CoverageState) => T): T {
  return useStore(coverage, selector);
}

/** What the layer draws: the preview while there are changes, else the selected run. */
export function shownGrids(c: CoverageState, rf: Pick<RfState, 'dirty'>): CoverageGrids | null {
  return rf.dirty && c.preview ? c.preview : c.run;
}

export interface CoverageDeps {
  /** Bytes of a project file (`assetUrl` and fetch in the app); null when it is missing. */
  bytes(projectId: string, path: string): Promise<Uint8Array | null>;
  /** The preview Worker, started when first needed. */
  client(): PreviewClient;
  /** Debounce of a setting change before the preview runs, ms. */
  debounceMs?: number;
}

/** The selected run, when it finished. */
function selected(s: RfState): RfRun | null {
  const r = s.runs.find((x) => x.runId === s.selectedRunId);
  return r?.status === 'done' ? r : null;
}

let refresh: (() => void) | null = null;

/** Work the preview out again (an input the store does not hold changed: the DSM ground). */
export function refreshPreview(): void {
  refresh?.();
}

export function startCoverage(deps: CoverageDeps): () => void {
  let stopped = false;
  let runToken = 0;
  let previewToken = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const patterns = new Map<string, TwoCutPattern | 'failed'>();
  let patternsProject: string | null = null;

  // ---- the selected run
  let shownRun: string | null = null;
  const readRun = async (s: RfState) => {
    const run = selected(s);
    const key = run && s.projectId ? `${s.projectId}/${run.runId}/${run.createdAt}` : null;
    if (key === shownRun) return;
    shownRun = key;
    const mine = ++runToken;
    coverage.setState({ run: null, runError: null });
    if (!run || !s.projectId) return;
    const projectId = s.projectId;
    try {
      const [rsrp, bestServer, overlap] = await Promise.all(
        [run.outputs.rsrp, run.outputs.bestServer, run.outputs.overlap].map((f) =>
          deps.bytes(projectId, runFile(run, f)),
        ),
      );
      if (mine !== runToken || stopped) return;
      if (!rsrp || !bestServer || !overlap) throw new Error('The run has no coverage grids.');
      coverage.setState({ run: gridsFromRun(run, { rsrp, bestServer, overlap }) });
    } catch (e) {
      if (mine !== runToken || stopped) return;
      coverage.setState({ runError: e instanceof Error ? e.message : String(e) });
    }
    publishStats();
  };

  // ---- the live preview
  const readPatterns = async (projectId: string, plan: PreviewPlan): Promise<boolean> => {
    const missing = plan.patternFiles.filter((f) => !patterns.has(patternKey(f)));
    if (missing.length === 0) return false;
    await Promise.all(
      missing.map(async (f) => {
        try {
          const b = await deps.bytes(projectId, f.path);
          if (!b) throw new Error('missing');
          const text = new TextDecoder('utf-8').decode(b);
          patterns.set(patternKey(f), msiToTwoCut(parseMsi(text), f.capDb));
        } catch {
          // the job falls back to the generic pattern too
          patterns.set(patternKey(f), 'failed');
        }
      }),
    );
    return true;
  };

  const measured = (): Map<string, TwoCutPattern> => {
    const out = new Map<string, TwoCutPattern>();
    for (const [k, v] of patterns) if (v !== 'failed') out.set(k, v);
    return out;
  };

  const runPreview = async () => {
    const s = rfStore.getState();
    const mine = ++previewToken;
    if (!s.dirty || !s.projectId || !s.antennas) {
      coverage.setState({ preview: null, previewSources: [] });
      if (s.preview.status !== 'idle') setPreviewState({ status: 'idle', error: null });
      publishStats();
      return;
    }
    const projectId = s.projectId;
    if (patternsProject !== projectId) {
      patterns.clear();
      patternsProject = projectId;
    }
    const input = {
      rows: s.rows,
      sectors: s.sectors,
      antennas: s.antennas,
      catalogue: s.catalogue.map((c) => c.entry),
    };
    let plan = previewPlan(input, measured());
    if (plan && (await readPatterns(projectId, plan))) {
      if (mine !== previewToken || stopped) return;
      plan = previewPlan(input, measured());
    }
    if (!plan) {
      coverage.setState({ preview: null, previewSources: [] });
      setPreviewState({ status: 'idle', error: null });
      publishStats();
      return;
    }
    setPreviewState({ status: 'computing', error: null });
    const client = deps.client();
    client.pathLoss(plan.grid, plan.radiusM, plan.pathLoss);
    try {
      const r = await client.preview(plan.request);
      if (mine !== previewToken || stopped) return;
      const now = rfStore.getState();
      coverage.setState({
        preview: gridsFromPreview(
          `preview:${String(mine)}`,
          plan.grid,
          r.output,
          now.sectors.study.thresholds,
          now.sectors.sectors.map((x) => x.id),
        ),
        previewSources: plan.sources,
      });
      setPreviewState({ status: 'ready', elapsedMs: r.elapsedMs, error: null });
    } catch (e) {
      if (mine !== previewToken || stopped) return;
      coverage.setState({ preview: null, previewSources: [] });
      setPreviewState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
    publishStats();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runPreview();
    }, deps.debounceMs ?? 120);
  };

  // ---- the class table follows what is shown
  let statsOf: CoverageGrids | null = null;
  function publishStats() {
    const g = shownGrids(coverage.getState(), rfStore.getState());
    if (g === statsOf) return;
    statsOf = g;
    setClassStats(g ? classStatsOf(g) : null);
  }

  const off = rfStore.subscribe((s, prev) => {
    if (stopped) return;
    if (
      s.projectId !== prev.projectId ||
      s.selectedRunId !== prev.selectedRunId ||
      s.runs !== prev.runs
    )
      void readRun(s);
    // changes saved or undone: back to the run at once
    if (!s.dirty && prev.dirty) void runPreview();
    // the preview's inputs (the derived rows are new on every change, so they are not compared;
    // a new DSM ground provider calls `refreshPreview`)
    if (
      s.dirty !== prev.dirty ||
      s.sectors !== prev.sectors ||
      s.antennas !== prev.antennas ||
      s.catalogue !== prev.catalogue ||
      s.includeUnreviewed !== prev.includeUnreviewed ||
      s.projectId !== prev.projectId
    )
      schedule();
    // selectRun clears the stats; give them back for what is still shown
    if (s.classStats === null && prev.classStats !== null) {
      statsOf = null;
      publishStats();
    }
  });
  void readRun(rfStore.getState());
  schedule();
  refresh = schedule;

  return () => {
    refresh = null;
    stopped = true;
    off();
    if (timer) clearTimeout(timer);
    runToken++;
    previewToken++;
    coverage.setState({ run: null, runError: null, preview: null, previewSources: [] });
  };
}
