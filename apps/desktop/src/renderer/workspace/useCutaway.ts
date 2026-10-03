import type { EngineStage, SectionState } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { videoRig } from '@aio/video';
import { workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { Box3, Vector3 } from 'three';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { cutawayFor, insideAsset, insideViewPose, sameCut } from './cutaway';

export interface CutawayState {
  /** The active clip's drone is inside the asset. */
  inside: boolean;
  /** The automatic cut-away currently owns the section. */
  engaged: boolean;
  /** Cut the asset open while a clip inside it plays (the user can turn it off). */
  auto: boolean;
  /** Engage even while paused (asked for with Inside view), until the clip changes. */
  requested: boolean;
}

export const cutaway = createStore<CutawayState>()(() => ({
  inside: false,
  engaged: false,
  auto: true,
  requested: false,
}));

export function useCutawayState<T>(selector: (s: CutawayState) => T): T {
  return useStore(cutaway, selector);
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
 * While the active clip's drone is inside the asset and the clip plays, cut the asset open toward
 * the viewer (a vertical section that follows the camera and the drone) and hide the point clouds
 * (their points lie on the walls, over the projected video), so the drone and its video on the
 * walls are visible from outside. The section the user had is restored when
 * the drone leaves; touching the section by hand hands it back to the user.
 */
export function useCutaway(stage: EngineStage | null): void {
  useEffect(() => {
    if (!stage) return;
    let box: Box3 | null = null;
    let saved: SectionState | null = null;
    let applied: SectionState | null = null;
    // point clouds hidden while cut open: their points sit on the walls and cover the video
    let hiddenClouds: string[] = [];
    let applying = false;
    let userOwned = false;
    let clip = workspace.getState().activeClip;
    let last = 0;

    const apply = (s: Partial<SectionState>) => {
      applying = true;
      stage.setSection(s);
      applying = false;
    };
    const hideClouds = () => {
      const ws = workspace.getState();
      hiddenClouds = (ws.project?.manifest.layers ?? [])
        .filter((l) => l.kind === 'pointcloud' && !ws.hidden[l.id])
        .map((l) => l.id);
      for (const id of hiddenClouds) ws.setLayerVisible(id, false);
    };
    const showClouds = () => {
      const ws = workspace.getState();
      for (const id of hiddenClouds) if (ws.hidden[id]) ws.setLayerVisible(id, true);
      hiddenClouds = [];
    };
    const release = () => {
      if (applied && saved) apply(saved);
      applied = null;
      saved = null;
      showClouds();
      set({ engaged: false });
    };

    const offState = stage.onStateChange(() => {
      if (applying || !applied || stage.section === applied) return;
      // the section was changed by hand: it is the user's again
      applied = null;
      saved = null;
      showClouds();
      userOwned = true;
      set({ engaged: false });
    });

    const offFrame = stage.onFrame(() => {
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      const ws = workspace.getState();
      if (ws.activeClip !== clip) {
        clip = ws.activeClip;
        userOwned = false;
        set({ requested: false });
      }
      const project = ws.project;
      if (!project || !ws.activeClip || ws.hidden[ws.activeClip]) {
        set({ inside: false });
        if (applied) release();
        return;
      }
      box ??= assetBox(stage, project.manifest.layers);
      const drone = box ? dronePose(stage) : null;
      const inside = drone !== null && box !== null && insideAsset(drone.pos, box);
      set({ inside });
      const s = cutaway.getState();
      const want =
        inside &&
        s.auto &&
        !userOwned &&
        videoRig(stage).cameraMode !== 'drone' &&
        (ws.playing || s.requested || applied !== null);
      if (!want) {
        if (applied) release();
        return;
      }
      const cut = cutawayFor(drone.pos, stage.camera.position, stage.sectionOrigin());
      if (applied && sameCut(stage.section, cut)) return;
      if (!applied) {
        saved = { ...stage.section };
        hideClouds();
      }
      apply(cut);
      applied = stage.section;
      set({ engaged: true });
    });

    return () => {
      offFrame();
      offState();
      if (applied) release();
      else showClouds();
      set({ inside: false, engaged: false });
    };
  }, [stage]);
}

/**
 * One click: cut the asset open and fly to a view from behind and above the drone, so its video on
 * the walls ahead of it fills the frame.
 */
export function insideView(stage: EngineStage): void {
  const drone = dronePose(stage);
  if (!drone) return;
  cutaway.setState({ auto: true, requested: true });
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

/** Turn the automatic cut-away off (restores the section) until Inside view is used again. */
export function stopCutaway(): void {
  cutaway.setState({ auto: false, requested: false });
}
