import { layerDisplay, useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
import { useStagePrefs } from '../workspace/stagePrefs';
import { loadPlaced, pictureDrawings } from './importFlow';
import { drawings, resetDrawings } from './store';
import './drawings.css';

/**
 * Keeps the drawings of the open project in step: which are placed (from their placement files)
 * and how each lies over the 3D view and the map (this computer's choice, mirrored into
 * `layerDisplay` for both views). Draws nothing itself.
 */
export function DrawingsLayer() {
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const display = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.drawings : undefined));

  // a tool, a page question and the flags belong to their project
  useEffect(() => {
    resetDrawings();
  }, [projectId]);

  useEffect(() => {
    layerDisplay.getState().replace(display ?? {});
  }, [display]);

  // read the placement files again when a drawing arrives or is placed (its corners change)
  const key = project
    ? pictureDrawings(project.manifest)
        .map((d) => {
          const l = project.manifest.layers.find((x) => x.id === d.id);
          return `${d.id}:${JSON.stringify(l?.kind === 'raster' ? l.corners : null)}`;
        })
        .join('|')
    : '';
  useEffect(() => {
    if (!project) return;
    let live = true;
    void loadPlaced(project).then((placed) => {
      if (live) drawings.setState({ placed });
    });
    return () => {
      live = false;
    };
    // the manifest changes on every edit; only the drawings matter here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);

  return null;
}
