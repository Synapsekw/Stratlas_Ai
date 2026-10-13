import { workspace } from '@aio/workspace';
import { bridge, jobs } from '../shell';
import { finishedPanoStitch } from './panoModel';

let watching = false;

/** Reload the open manifest when a stitch of it failed, stopped or was cancelled. */
export function watchPanoStitches(): void {
  if (watching) return;
  watching = true;
  jobs.subscribe((s, prev) => {
    const project = workspace.getState().project;
    if (!project || s.jobs === prev.jobs || !finishedPanoStitch(prev.jobs, s.jobs, project.root))
      return;
    void bridge.call('project:open', { path: project.root }).then((r) => {
      const ws = workspace.getState();
      if (r.ok && r.value.ok && ws.project?.id === project.id) ws.replaceManifest(r.value.manifest);
    });
  });
}
