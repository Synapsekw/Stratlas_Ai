/**
 * What the Annotate workbench needs of the stage: which views the stage shows, and the map
 * drawing the stage owns (the map's click seam draws from it). The stage publishes both; the
 * bench reads them. The functions the bench calls go to the stage's latest drawing, so they stay
 * the same however often the stage draws again.
 */
import { beginSighting, startSceneTool, type MapDraw, type SceneTool } from '@aio/annotate';
import { getActiveScene, onActiveScene } from '@aio/engine';
import { useEffect, useSyncExternalStore } from 'react';
import { useShell } from '../../../shell';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export interface AnnotateStageState {
  /** The stage shows the 3D view (alone or in a split). */
  show3d: boolean;
  /** The stage shows the map (alone or in a split). */
  showMap: boolean;
  mode: MapDraw['mode'];
  state: MapDraw['state'];
  /** The 3D annotation tool in use; the stage runs it, whatever tab shows. */
  tool: SceneTool | null;
  setTool: (tool: SceneTool | null) => void;
  /** The stage's map drawing, as of its last draw. */
  publish: (draw: MapDraw) => void;
  /** The stage is gone: nothing is drawn. */
  clear: () => void;
}

let current: MapDraw | null = null;

export const annotateStage = createStore<AnnotateStageState>()((set, get) => ({
  show3d: false,
  showMap: false,
  mode: null,
  state: null,
  tool: null,
  setTool: (tool) => {
    set({ tool });
  },
  publish: (draw) => {
    current = draw;
    const s = get();
    if (s.mode !== draw.mode || s.state !== draw.state) set({ mode: draw.mode, state: draw.state });
  },
  clear: () => {
    current = null;
    set({ show3d: false, showMap: false, mode: null, state: null, tool: null });
  },
}));

/** The map drawing, with its actions going to the stage's latest one. */
const FORWARD: Omit<MapDraw, 'mode' | 'state'> = {
  setMode: (m) => {
    current?.setMode(m);
  },
  onClick: (lngLat, client) => {
    current?.onClick(lngLat, client);
  },
  finish: () => {
    current?.finish();
  },
  undo: () => {
    current?.undo();
  },
  cancel: () => {
    current?.cancel();
  },
};

export function useAnnotateStage<T>(selector: (s: AnnotateStageState) => T): T {
  return useStore(annotateStage, selector);
}

/** The stage's map drawing for the bench's map tools. */
export function useMapDrawHandle(): MapDraw {
  const mode = useAnnotateStage((s) => s.mode);
  const state = useAnnotateStage((s) => s.state);
  return { ...FORWARD, mode, state };
}

/** Called by the stage: publish the views it shows and its map drawing. */
export function useAnnotateStageBridge(draw: MapDraw, show3d: boolean, showMap: boolean): void {
  useEffect(() => {
    annotateStage.getState().publish(draw);
  });
  useEffect(() => {
    annotateStage.setState({ show3d, showMap });
  }, [show3d, showMap]);
  useSceneToolRunner(show3d);
  useEffect(
    () => () => {
      annotateStage.getState().clear();
    },
    [],
  );
}

/**
 * Runs the chosen 3D tool on the active scene while annotating in 3D, so it outlives the bench's
 * tab; leaving Annotate or the 3D view drops it.
 */
function useSceneToolRunner(show3d: boolean): void {
  const annotating = useShell((s) => s.annotating);
  const tool = useAnnotateStage((s) => s.tool);
  const scene = useSyncExternalStore(onActiveScene, getActiveScene, getActiveScene);
  const on = annotating && show3d;
  useEffect(() => {
    if (!on && annotateStage.getState().tool) annotateStage.getState().setTool(null);
  }, [on]);
  useEffect(() => {
    if (!on || !scene || !tool) return;
    return startSceneTool(scene, tool, (s, at) => {
      beginSighting(s, at);
    });
  }, [on, scene, tool]);
}
