import { t } from '@aio/ui';
import { volumetric } from '@aio/volumetric';
import { assetUrl, workspace } from '@aio/workspace';
import { alignTo } from '../builder/alignSession';
import { dropToGround } from '../builder/dropSession';
import { builder } from '../builder/state';
import { waitForJob } from '../jobs';
import { bridge, jobs, shell } from '../shell';
import { updateCapture } from '../shell/dateFolders';
import type { Box } from '../shell/layerBounds';
import { measureStore } from '../survey/measureStore';
import { volumeHints } from '../workspace/compare';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpPreview, readLineUpExtents } from './lineUpPreview';
import { createLineUpSession, linkNotices, writersFor } from './lineUpSession';

/** The project file `path` as JSON, through the project's own protocol (as the producers read). */
async function readJson(path: string): Promise<unknown> {
  const project = workspace.getState().project;
  if (!project) throw new Error(t('lineUp.read.noProject'));
  const res = await fetch(assetUrl(project.id, { path }));
  if (!res.ok) throw new Error(t('lineUp.read.failed', { path, status: res.status }));
  return res.json();
}

/** Each layer's box in the local frame, as placed now (a lined-up date's shift is in it). */
async function extents(): Promise<Record<string, Box>> {
  const project = workspace.getState().project;
  if (!project) return {};
  return readLineUpExtents(bridge, project.id);
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** One tile as an image; null when it cannot be loaded. */
async function loadTile(path: string): Promise<CanvasImageSource | null> {
  const project = workspace.getState().project;
  if (!project) return null;
  try {
    const res = await fetch(assetUrl(project.id, { path }));
    return res.ok ? await createImageBitmap(await res.blob()) : null;
  } catch {
    return null;
  }
}

/** Start the line-up step and its background check; returns the stop. Called once at start. */
export function startLineUpSession(): () => void {
  const session = createLineUpSession({
    workspace,
    root: () => (shell.getState().pkg ? null : (workspace.getState().project?.root ?? null)),
    // background work: it takes no Processing selection and its end is not announced
    start: (pipeline, project, params) => jobs.getState().startQuiet({ pipeline, project, params }),
    finished: (jobId, signal) => waitForJob(jobs, jobId, signal),
    cancel: (jobId) => {
      void jobs.getState().cancel(jobId);
    },
    readJson,
    extents,
    // the pipeline pack the Processing screens need: no pack, no check and no notice
    hasPython: () => jobs.getState().runtime?.found === true,
    onReady: (cb) =>
      jobs.subscribe((s, prev) => {
        if (s.runtime?.found === true && prev.runtime?.found !== true) cb();
      }),
    preview: createLineUpPreview({
      manifest: () => workspace.getState().project?.manifest,
      extents,
      readJson,
      loadTile,
      stitch: (level, tiles) => {
        const canvas = document.createElement('canvas');
        canvas.width = level.cols * level.tileSize;
        canvas.height = level.rows * level.tileSize;
        const ctx = canvas.getContext('2d');
        tiles.forEach((tile, i) => {
          if (tile)
            ctx?.drawImage(
              tile,
              (i % level.cols) * level.tileSize,
              Math.floor(i / level.cols) * level.tileSize,
              level.tileSize,
              level.tileSize,
            );
        });
        return canvas;
      },
    }),
    ...writersFor({
      updateCapture,
      saveLayers: (layerIds, patch) => builder.getState().saveLayers(layerIds, patch),
    }),
    hints: () => volumeHints(volumetric.getState()),
    issues: () => workspace.getState().issues,
    measurements: () => measureStore.getState().file.measurements,
    memory: createLineUpMemory(storage()),
    now: () => new Date().toISOString(),
  });
  // one Ctrl+Z owner, as Align to and Drop to ground
  const unlink = linkNotices(session.store, [alignTo, dropToGround]);
  return () => {
    unlink();
    session.stop();
  };
}
