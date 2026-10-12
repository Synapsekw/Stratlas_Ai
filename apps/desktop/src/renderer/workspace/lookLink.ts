import { PANO_FOV, type PanoLook } from '@aio/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * One look shared by two look-around views (two panoramas of two dates; later two 360 walks).
 * The shared look is a compass bearing; each member turns it by its own yaw offset (0 for
 * panoramas, which carry their heading; a walk's alignment for W5). Linking is the caller's
 * choice: an unlinked view keeps its own look and never writes here.
 */
const wrap = (a: number) => ((a % 360) + 360) % 360;
const clamp = (l: PanoLook): PanoLook => ({
  yawDeg: wrap(l.yawDeg),
  pitchDeg: Math.max(-89, Math.min(89, l.pitchDeg)),
  fovDeg: Math.max(PANO_FOV.min, Math.min(PANO_FOV.max, l.fovDeg)),
});
export const toShared = (local: PanoLook, offsetDeg: number): PanoLook =>
  clamp({ ...local, yawDeg: local.yawDeg + offsetDeg });
export const fromShared = (shared: PanoLook, offsetDeg: number): PanoLook =>
  clamp({ ...shared, yawDeg: shared.yawDeg - offsetDeg });

export interface LookLinkState {
  look: PanoLook;
  set(look: PanoLook): void;
}
export function createLookLink(initial: PanoLook): StoreApi<LookLinkState> {
  return createStore<LookLinkState>()((set) => ({
    look: clamp(initial),
    set: (look) => {
      set({ look: clamp(look) });
    },
  }));
}
export const panoLookLink = createLookLink({ yawDeg: 0, pitchDeg: 0, fovDeg: PANO_FOV.start });
