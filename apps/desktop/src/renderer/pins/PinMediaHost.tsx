import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef } from 'react';
import { PinMapMount } from './PinMapMount';
import { PinMenu } from './PinMenu';
import { PinSceneMount } from './PinSceneMount';
import { PinStrip } from './PinStrip';
import { pinSession } from './placePin';

/*
 * Pinned media in the scene (pinned media design): the placing strip (it arms the clicks its step
 * asks for), the pins in 3D and on the map, and their right-click menu. Mounted once with the
 * scene; an open placing session ends when its project changes or the host goes (the scene is
 * left).
 */

/** Hosts mounted now. */
let mounted = 0;

export function PinMediaHost() {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const last = useRef(projectId);
  useEffect(() => {
    if (last.current === projectId) return;
    last.current = projectId;
    pinSession.getState().cancel();
  }, [projectId]);
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      // checked after the commit: StrictMode's test unmount mounts the host again at once, and
      // a session started from Media began just before the host mounted
      queueMicrotask(() => {
        if (mounted === 0) pinSession.getState().cancel();
      });
    };
  }, []);
  return (
    <>
      <PinStrip />
      <PinSceneMount />
      <PinMapMount />
      <PinMenu />
    </>
  );
}
