import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { useScene } from '../builder/activeViews';
import { pinSession } from './placePin';
import { drawnPins, keyString, type MediaKey } from './pinModel';
import { attachPinScene, type PinSceneView } from './pinScene';

/*
 * Pins in the 3D view: the pinned photos and 360s of the shown layers, drawn by `pinScene.ts`.
 * Dropping the heading arrow re-aims the pin through the placing session (a Set direction
 * session that saves the heading at once).
 */

function onArrowDrop(key: MediaKey, headingDeg: number): void {
  const s = pinSession.getState();
  s.begin(key, 'direction');
  void pinSession.getState().setHeading(headingDeg);
}

export function PinSceneMount(): null {
  // a store read, not a state set in an effect: a 3D view that comes up with this mount is seen
  const scene = useScene();
  const view = useRef<PinSceneView | null>(null);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const hiddenMap = useWorkspace((s) => s.hidden);
  const hidden = useMemo(() => new Set(Object.keys(hiddenMap)), [hiddenMap]);
  const target = useStore(pinSession, (s) => s.target);
  const selected = target ? keyString(target) : null;

  useEffect(() => {
    if (!scene) return;
    const v = attachPinScene(scene, { onArrowDrop });
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
  }, [scene]);

  useEffect(() => {
    view.current?.update(manifest ? drawnPins(manifest, hidden) : [], selected);
  }, [scene, manifest, hidden, selected]);

  return null;
}
