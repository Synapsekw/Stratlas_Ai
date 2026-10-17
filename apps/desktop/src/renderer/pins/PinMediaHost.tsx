import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef } from 'react';
import { shell } from '../shell';
import { PinMapMount } from './PinMapMount';
import { PinMenu } from './PinMenu';
import { PinSceneMount } from './PinSceneMount';
import { PinStrip } from './PinStrip';
import { pinSession } from './placePin';

/*
 * Pinned media in the scene (pinned media design): the placing strip (it arms the clicks its step
 * asks for), the pins in 3D and on the map, and their right-click menu. Mounted once with the
 * scene; a placing session ends with its project or when the scene is left. (Not on unmount: a
 * session started from Media begins just before this mounts, and StrictMode remounts it.)
 */
export function PinMediaHost() {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const last = useRef(projectId);
  useEffect(() => {
    if (last.current === projectId) return;
    last.current = projectId;
    pinSession.getState().cancel();
  }, [projectId]);
  useEffect(
    () =>
      shell.subscribe((s, prev) => {
        if (prev.screen === 'scene' && s.screen !== 'scene') pinSession.getState().cancel();
      }),
    [],
  );
  return (
    <>
      <PinStrip />
      <PinSceneMount />
      <PinMapMount />
      <PinMenu />
    </>
  );
}
