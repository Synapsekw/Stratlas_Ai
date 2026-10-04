import type { EngineStage, SectionState } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { videoRig } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { Box3, Vector3 } from 'three';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import {
  clampOpacity,
  cutawayFor,
  DEFAULT_CUTAWAY,
  insideAsset,
  insideViewPose,
  makeSeeThrough,
  sameCut,
  type CutawayMode,
  type CutawayPref,
  type SeeThrough,
} from './cutaway';
import { stagePrefs, useStagePrefs } from './stagePrefs';

export interface CutawayState {
  /** The active clip's drone is inside the asset. */
  inside: boolean;
  /** The chosen mode is applied: the asset is cut open or drawn see-through. */
  engaged: boolean;
}

export const cutaway = createStore<CutawayState>()(() => ({
  inside: false,
  engaged: false,
}));

export function useCutawayState<T>(selector: (s: CutawayState) => T): T {
  return useStore(cutaway, selector);
}

/** The open project's cut-away choice (Off unless the person picked one). */
export function cutawayPref(): CutawayPref {
  const id = workspace.getState().project?.id;
  return (id ? stagePrefs.getState().byProject[id]?.cutaway : undefined) ?? DEFAULT_CUTAWAY;
}

export function useCutawayPref(): CutawayPref {
  const id = useWorkspace((s) => s.project?.id ?? null);
  return useStagePrefs((s) => (id ? s.byProject[id]?.cutaway : undefined)) ?? DEFAULT_CUTAWAY;
}

function updatePref(patch: Partial<CutawayPref>): void {
  const id = workspace.getState().project?.id;
  if (!id) return;
  const next = { ...cutawayPref(), ...patch };
  stagePrefs.getState().update(id, { cutaway: next });
}

/** Choose Off, Cut or Transparent for the open project (remembered per project). */
export function setCutawayMode(mode: CutawayMode): void {
  if (cutawayPref().mode !== mode) updatePref({ mode });
}

export function setCutawayOpacity(opacity: number): void {
  updatePref({ opacity: clampOpacity(opacity) });
}

/** Bounds of the project's mesh layers (the asset), or null before they load. */
function assetBox(stage: EngineStage, layers: readonly Layer[]): Box3 | null {
  const box = new Box3();
  for (const l of layers) {
    if (l.kind !== 'mesh') continue;
    const root = stage.scene.getObjectByName(`layer:${l.id}`);
    if (root?.visible) box.expandByObject(root);
  }
  return box.isEmpty() ? null : box;
}

function dronePose(stage: EngineStage): { pos: Vector3; look: Vector3 } | null {
  const pose = videoRig(stage).currentPose();
  if (!pose) return null;
  return { pos: pose.pos, look: new Vector3(0, 0, -1).applyQuaternion(pose.q) };
}

const set = (patch: Partial<CutawayState>) => {
  const s = cutaway.getState();
  if (Object.entries(patch).some(([k, v]) => s[k as keyof CutawayState] !== v))
    cutaway.setState(patch);
};

/**
 * Applies the cut-away mode the person chose; nothing is cut or faded automatically.
 *
 * - Cut: a vertical section that opens the asset toward the viewer and follows the camera: at the
 *   drone while it is inside the asset (keeping the drone and the walls it films), else through
 *   the middle of the asset. The section the user had comes back when the mode ends; touching the
 *   section by hand turns the mode off and hands the section back.
 * - Transparent: the asset's materials drawn see-through (no depth writes), so the drone, its
 *   flight path and the video projected on the far walls show through; restored exactly after.
 *
 * In both, the point clouds are hidden (their points lie on the walls and cover the view inside)
 * and shown again afterwards.
 */
export function useCutaway(stage: EngineStage | null): void {
  useEffect(() => {
    if (!stage) return;
    let project = workspace.getState().project;
    let box: Box3 | null = null;
    let saved: SectionState | null = null;
    let applied: SectionState | null = null;
    /** See-through mesh layers by layer id. */
    const looks = new Map<string, SeeThrough>();
    let lookOpacity = DEFAULT_CUTAWAY.opacity;
    let hiddenClouds: string[] = [];
    /** The clouds are held hidden (shown again by hand meanwhile: left as the person set them). */
    let cloudsHeld = false;
    let applying = false;
    let last = 0;

    const apply = (s: Partial<SectionState>) => {
      applying = true;
      stage.setSection(s);
      applying = false;
    };
    const hideClouds = () => {
      if (cloudsHeld) return;
      cloudsHeld = true;
      const ws = workspace.getState();
      hiddenClouds = (ws.project?.manifest.layers ?? [])
        .filter((l) => l.kind === 'pointcloud' && !ws.hidden[l.id])
        .map((l) => l.id);
      if (hiddenClouds.length) ws.setLayersVisible(hiddenClouds, false);
    };
    const showClouds = () => {
      if (!cloudsHeld) return;
      cloudsHeld = false;
      const ws = workspace.getState();
      const back = hiddenClouds.filter((id) => ws.hidden[id]);
      hiddenClouds = [];
      if (back.length) ws.setLayersVisible(back, true);
    };
    const releaseCut = () => {
      if (applied && saved) apply(saved);
      applied = null;
      saved = null;
    };
    const releaseLooks = () => {
      if (looks.size === 0) return;
      for (const l of looks.values()) l.restore();
      looks.clear();
      stage.requestRender();
    };
    const releaseAll = () => {
      releaseCut();
      releaseLooks();
      showClouds();
      set({ engaged: false });
    };

    const offState = stage.onStateChange(() => {
      if (applying || !applied || stage.section === applied) return;
      // the section was changed by hand: it is the user's again, and Cut is off
      applied = null;
      saved = null;
      if (looks.size === 0) showClouds();
      if (cutawayPref().mode === 'cut') setCutawayMode('off');
    });

    const seeThrough = (layers: readonly Layer[], opacity: number) => {
      let changed = false;
      for (const l of layers) {
        if (l.kind !== 'mesh' || looks.has(l.id)) continue;
        const root = stage.scene.getObjectByName(`layer:${l.id}`);
        if (!root) continue;
        looks.set(l.id, makeSeeThrough(root, opacity));
        changed = true;
      }
      if (opacity !== lookOpacity) {
        for (const l of looks.values()) l.setOpacity(opacity);
        changed = true;
      }
      lookOpacity = opacity;
      if (changed) stage.requestRender();
    };

    const tick = (force: boolean) => {
      const now = performance.now();
      if (!force && now - last < 100) return;
      last = now;
      const ws = workspace.getState();
      if (ws.project !== project) {
        // another project: nothing of the last one stays applied
        releaseAll();
        project = ws.project;
        box = null;
      }
      if (!project) return;
      const { mode, opacity } = cutawayPref();
      box ??= assetBox(stage, project.manifest.layers);
      const clip = ws.activeClip && !ws.hidden[ws.activeClip] ? ws.activeClip : null;
      const drone = clip && box ? dronePose(stage) : null;
      const inside = drone !== null && box !== null && insideAsset(drone.pos, box);
      set({ inside });

      if (mode === 'transparent') seeThrough(project.manifest.layers, opacity);
      else releaseLooks();

      // drone-eye looks out of the drone: a cut toward that camera would remove what it films
      if (mode === 'cut' && box && videoRig(stage).cameraMode !== 'drone') {
        const at = drone && inside ? drone.pos : box.getCenter(new Vector3());
        const want = cutawayFor(at, stage.camera.position, stage.sectionOrigin(), inside ? 0.6 : 0);
        if (!applied || !sameCut(stage.section, want)) {
          saved ??= { ...stage.section };
          apply(want);
          applied = stage.section;
        }
      } else releaseCut();

      const engaged = applied !== null || looks.size > 0;
      if (engaged) hideClouds();
      else showClouds();
      set({ engaged });
    };

    const offFrame = stage.onFrame(() => {
      tick(false);
    });
    // a new choice applies at once, not on the next throttled frame
    const offPrefs = stagePrefs.subscribe(() => {
      tick(true);
      stage.requestRender();
    });

    return () => {
      offFrame();
      offPrefs();
      offState();
      releaseAll();
      set({ inside: false, engaged: false });
    };
  }, [stage]);
}

/**
 * One click: fly to a view from behind and above the drone, so its video on the walls ahead of it
 * fills the frame, and cut the asset open unless it is already cut or see-through.
 */
export function insideView(stage: EngineStage): void {
  const drone = dronePose(stage);
  if (!drone) return;
  if (cutawayPref().mode === 'off') setCutawayMode('cut');
  const project = workspace.getState().project;
  const box = project ? assetBox(stage, project.manifest.layers) : null;
  const radius = box ? box.getSize(new Vector3()).length() / 2 : 5;
  const pose = insideViewPose(drone.pos, drone.look, Math.min(60, Math.max(3, radius * 1.4)));
  stage.restoreView(
    {
      position: [pose.position.x, pose.position.y, pose.position.z],
      target: [pose.target.x, pose.target.y, pose.target.z],
    },
    true,
  );
  stage.requestRender();
}

/** Back to the solid asset (restores the section, the materials and the clouds). */
export function stopCutaway(): void {
  setCutawayMode('off');
}
