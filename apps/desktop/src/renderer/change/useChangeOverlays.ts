import { changeMarkers, changeStore, orderPair, setsOfPair, useChange } from '@aio/change';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useReducer } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { useShell } from '../shell';
import { compareRuntime, onCompareRuntime } from '../workspace/compare';
import { isTwin, paneCapture, type SplitModel } from '../workspace/SplitPanes';
import { sidesOf } from '../workspace/splitModel';
import { useEngineStage } from '../workspace/StageTools';
import { drawPins3d, drawPinsMap, localToLonLat } from './draw';

/** Asks the right panel to show the Changes tab (bumped by "Show changes"). */
export const changesTab = createStore<{ seq: number }>(() => ({ seq: 0 }));

export function openChangesTab(): void {
  changesTab.setState((s) => ({ seq: s.seq + 1 }));
}

export function useChangesTabSeq(): number {
  return useStore(changesTab, (s) => s.seq);
}

/** Keep the change sets of the open project loaded. */
export function useChangeProject(): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  useEffect(() => {
    if (changeStore.getState().projectId !== projectId) void changeStore.getState().load(projectId);
  }, [projectId]);
}

/** The two dates Compare dates shows, earlier first (null when not comparing). */
export function useComparedPair(split: SplitModel): { from: string; to: string } | null {
  const mode = useShell((s) => s.stageMode);
  if (mode !== 'split' || !isTwin(split) || !split.index) return null;
  const a = paneCapture(split, 'left');
  const b = paneCapture(split, 'right');
  return a && b ? orderPair(split.index, a, b) : null;
}

/**
 * "Show changes": pins of the chosen pair on every 3D view and map of the comparison, each view
 * showing where the items are on its own date. The pair follows the dates Compare dates shows.
 */
export function useChangeOverlays(split: SplitModel): void {
  useChangeProject();
  const mode = useShell((s) => s.stageMode);
  const show = useChange((s) => s.show);
  const sets = useChange((s) => s.sets);
  const pair = useChange((s) => s.pair);
  const filter = useChange((s) => s.filter);
  const selected = useChange((s) => s.selected);
  const issues = useWorkspace((s) => s.issues);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const engine = useEngineStage();
  const [rt, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onCompareRuntime(bump), []);
  const compared = useComparedPair(split);

  // the panel's pair follows the compared dates
  useEffect(() => {
    if (!compared) return;
    const cur = changeStore.getState().pair;
    if (cur?.from !== compared.from || cur.to !== compared.to)
      changeStore.getState().setPair(compared);
  }, [compared?.from, compared?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const splitting = mode === 'split';
  const sides3d = splitting ? sidesOf(split.sides, '3d') : [];
  const sidesMap = splitting ? sidesOf(split.sides, 'map') : [];
  const cap = (side: 'left' | 'right' | undefined) => (side ? paneCapture(split, side) : undefined);
  const main3d = cap(sides3d[0]);
  const second3d = cap(sides3d[1]);
  const mainMap = cap(sidesMap[0]);
  const secondMap = cap(sidesMap[1]);

  useEffect(() => {
    const clear = () => {
      compareRuntime.changes = { main: [], second: [], maps: [[], []] };
    };
    if (!show || !pair || !manifest) {
      clear();
      return;
    }
    const pairSets = setsOfPair(sets, pair);
    const input = { sets: pairSets, filter, selected, issues };
    const pins = (capture: string | undefined) => changeMarkers({ ...input, capture });
    const offs: (() => void)[] = [];
    const summary = (m: ReturnType<typeof pins>) =>
      m.map((x) => ({ id: x.id, verdict: x.verdict, ghost: x.ghost, selected: x.selected }));
    const mainPins = pins(main3d);
    const secondPins = pins(second3d);
    if (engine) offs.push(drawPins3d(engine, mainPins));
    const second = compareRuntime.second;
    if (second && sides3d.length > 1) offs.push(drawPins3d(second, secondPins));
    const toLonLat = localToLonLat(manifest);
    const [m0, m1] = compareRuntime.maps;
    const mapIds: [string[], string[]] = [[], []];
    if (toLonLat) {
      if (m0 && (mode === 'map' || sidesMap.length > 0)) {
        const m = pins(mainMap);
        offs.push(drawPinsMap(m0, m, toLonLat));
        mapIds[0] = m.map((x) => x.id);
      }
      if (m1 && sidesMap.length > 1) {
        const m = pins(secondMap);
        offs.push(drawPinsMap(m1, m, toLonLat));
        mapIds[1] = m.map((x) => x.id);
      }
    }
    compareRuntime.changes = {
      main: engine ? summary(mainPins) : [],
      second: second && sides3d.length > 1 ? summary(secondPins) : [],
      maps: mapIds,
    };
    return () => {
      for (const off of offs) off();
      clear();
    };
    // sides are derived from the split, captures from the sides
  }, [
    show,
    pair,
    sets,
    filter,
    selected,
    issues,
    manifest,
    engine,
    rt,
    mode,
    main3d,
    second3d,
    mainMap,
    secondMap,
    sides3d.length,
    sidesMap.length,
  ]);
}
