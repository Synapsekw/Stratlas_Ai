/**
 * The frame the measurements are drawn, picked and read out in: the active space's (`spaceFrameOf`).
 * A confined-space drone's local space reads plain metres from its origin, with X, Y and Z axes;
 * the main space of a georeferenced project keeps the project frame.
 */
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { activeSpace, useActiveSpace } from '../spaces/activeSpace';
import { activeSpaceOf } from '../spaces/spaceModel';
import { spaceFrameOf, type Frame } from './measureScene';

/** The open project's measuring frame, following the active space. */
export function useMeasureFrame(): Frame | null {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const { spaceId } = useActiveSpace();
  return useMemo(() => (manifest ? spaceFrameOf(manifest, spaceId) : null), [manifest, spaceId]);
}

/** The measuring frame read now (for an action outside React). */
export function measureFrameNow(): Frame | null {
  const project = workspace.getState().project;
  if (!project) return null;
  const pref = activeSpace().getState().byProject[project.id];
  return spaceFrameOf(project.manifest, activeSpaceOf(project.manifest, pref));
}
