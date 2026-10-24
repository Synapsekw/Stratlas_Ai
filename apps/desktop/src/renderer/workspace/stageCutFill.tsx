/**
 * Show, Cut & fill without a selected pile (volumetrics redesign, spec section 6, board 4): in a
 * survey project the whole site's cut and fill between the compare pair is drawn on the 3D
 * terrain and on the map, through the heat map path of the focused measurement (`siteHeat` in
 * `compareStore`, drawn by survey/heatScene.ts when no focused measurement has a heat map of its
 * own), and the cut and fill legend stands in a bottom corner of the stage.
 *
 * The pair is the app's one compare pair (`compareDates`), else the default around the date in
 * focus; the threshold is the Cut & fill pane's "Ignore under" (`cutFillPrefs`). The run is the
 * whole-site engine run the pane and the strip share (`wholeSiteHeat`, survey/volumes/cutFill.ts),
 * so a question already asked is answered from there. Kit projects keep the kit's own Cut & fill
 * (`volumetric.surface`); Photo and Elevation turn the heat map off and with it this drawing.
 */
import type { HeatmapStyle, HeightTiles } from '@aio/schema';
import { heatRamp } from '@aio/survey';
import type { SurfaceMode } from '@aio/volumetric';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { compareStore, engineClient, useCompare } from '../survey/compareStore';
import { HeatLegend, LEGEND_RANGE_M } from '../survey/heatLegend';
import { useMeasure } from '../survey/measureStore';
import { useFocusCapture } from '../survey/qaHelpers';
import {
  captureRef,
  cutFillPrefs,
  pairKey,
  siteCellM,
  useCutFillPrefs,
  wholeSiteHeat,
  type CutFillPair,
} from '../survey/volumes/cutFill';
import { compareDates, pairFor, type ComparePair } from './dates/compareDates';
import { useStageShow } from './StageShow';
import { useKitVolumes } from './workbench/view';

export interface SiteCutFillInput {
  /** The stockpile kit is loaded: it keeps its own Cut & fill. */
  kit: boolean;
  /** The Show control is up (`stageShow.active`). */
  active: boolean;
  /** The Show control's surface (`stageShow.surface`). */
  surface: SurfaceMode;
  /** The comparison heat map is on in either view (Cut & fill turns it on, Photo and Elevation off). */
  heatOn: boolean;
}

/** Show reads Cut & fill in a survey project: the whole site's heat map and legend are wanted. */
export function siteCutFillWanted(x: SiteCutFillInput): boolean {
  return !x.kit && x.active && x.surface === 'change' && x.heatOn;
}

export interface SiteCutFillQuestion {
  pair: ComparePair;
  refs: CutFillPair;
  /** The pair's surfaces with their fingerprints (`pairKey`): the shared cache's key. */
  pk: string;
  thresholdM: number;
  cellM: number;
  /** Everything the run reads: a new key is a new question. */
  key: string;
}

/**
 * The whole-site question to ask the engine, or null: not wanted, no pair, the engine not ready or
 * a date of the pair without a prepared surface yet.
 */
export function siteCutFillQuestion(x: {
  wanted: boolean;
  engineReady: boolean;
  pair: ComparePair | null;
  surfaces: readonly HeightTiles[];
  thresholdM: number;
}): SiteCutFillQuestion | null {
  if (!x.wanted || !x.engineReady || !x.pair) return null;
  const from = captureRef(x.surfaces, x.pair.from);
  const to = captureRef(x.surfaces, x.pair.to);
  if (!from || !to) return null;
  const refs = { from, to };
  const pk = pairKey(x.surfaces, refs);
  const cellM = siteCellM(x.surfaces);
  return {
    pair: x.pair,
    refs,
    pk,
    thresholdM: x.thresholdM,
    cellM,
    key: JSON.stringify([pk, x.thresholdM, cellM]),
  };
}

/** The legend's half span: the largest stop of the site's heat map colours, else ±2 m. */
export function legendRangeM(style: Pick<HeatmapStyle, 'stops' | 'stepped' | 'inverted'>): number {
  const values = heatRamp(style).legend.map((s) => Math.abs(s.value));
  const max = values.length > 0 ? Math.max(...values) : 0;
  return max > 0 ? max : LEGEND_RANGE_M;
}

const cancelled = (e: unknown) =>
  e instanceof Error && (e.name === 'RunCancelled' || e.name === 'AbortError');

/**
 * Keeps `compareStore.siteHeat` to the question: asks the engine when it changes, clears it when
 * Cut & fill is off. Returns the legend's pair and threshold while the heat map is drawn.
 */
export function useSiteCutFill(): { from: string; to: string; thresholdM: number } | null {
  const kit = useKitVolumes();
  const active = useStageShow((s) => s.active);
  const surface = useStageShow((s) => s.surface);
  const heatOn = useCompare((s) => s.heat.show3d || s.heat.show2d);
  const engineReady = useCompare((s) => s.status === 'ready');
  const surfaces = useCompare((s) => s.surfaces);
  const drawn = useCompare((s) => s.siteHeat !== null);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  const focus = useFocusCapture();
  const chosenFrom = useStore(compareDates, (s) => s.from);
  const chosenTo = useStore(compareDates, (s) => s.to);
  const thresholdM = useCutFillPrefs((s) => s.thresholdM);

  useEffect(() => {
    cutFillPrefs.getState().load(projectId);
  }, [projectId]);

  const wanted = siteCutFillWanted({ kit, active, surface, heatOn });
  const pair = useMemo(
    () =>
      pairFor(
        { from: chosenFrom, to: chosenTo },
        focus,
        (captures ?? []).map((c) => {
          const t = c.date ? Date.parse(c.date) : NaN;
          return { capture: c.id, t: Number.isFinite(t) ? t : null };
        }),
      ),
    [chosenFrom, chosenTo, focus, captures],
  );
  const question = siteCutFillQuestion({ wanted, engineReady, pair, surfaces, thresholdM });
  const key = question?.key ?? null;

  useEffect(() => {
    if (!question) {
      if (compareStore.getState().siteHeat) compareStore.setState({ siteHeat: null });
      return;
    }
    const ac = new AbortController();
    void wholeSiteHeat(
      question.refs,
      question.thresholdM,
      question.cellM,
      // its own engine key: the Cut & fill pane's run of the same question is shared, not cancelled
      (req) => engineClient().site(req, 'stage-cutfill-site'),
      { pair: question.pk, signal: ac.signal },
    ).then(
      (grid) => {
        if (!ac.signal.aborted) compareStore.setState({ siteHeat: grid });
      },
      (e: unknown) => {
        if (ac.signal.aborted || cancelled(e)) return;
        compareStore.setState({ siteHeat: null });
      },
    );
    return () => {
      ac.abort();
      compareStore.setState({ siteHeat: null });
    };
    // the key names every input the run reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!question || !drawn) return null;
  const dateOf = (id: string) => captures?.find((c) => c.id === id)?.date ?? '';
  return {
    from: dateOf(question.pair.from),
    to: dateOf(question.pair.to),
    thresholdM: question.thresholdM,
  };
}

/** The cut and fill legend on the stage, its ramp in the site's heat map colours. */
export function StageCutFillLegend(p: {
  from: string;
  to: string;
  thresholdM: number;
}): ReactElement {
  const style = useMeasure((s) => s.settings.heatmap);
  return (
    <HeatLegend
      className="cf-legend-stage"
      from={p.from}
      to={p.to}
      thresholdM={p.thresholdM}
      rangeM={legendRangeM(style)}
      style={style}
    />
  );
}
