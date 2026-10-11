/**
 * The bounds of the tagged assets are measured in the live 3D scene and remembered per project
 * (`assetIndex` of @aio/ai). Nothing measures them until a tool asks, so a question about an asset
 * typed on Media, where the 3D view is not mounted, would find none and be told the model is still
 * loading. This asks for the index as soon as the model is there, so the bounds are remembered by
 * the time the person leaves Scene.
 *
 * The engine says when the 3D view is mounted, not when a model has loaded, so the index is asked
 * once a second while the view is there, until it has bounds.
 */
import { assetIndex, defaultToolContext, type AssetIndex } from '@aio/ai';
import { getActiveScene, onActiveScene } from '@aio/engine';
import { workspace, type OpenProject } from '@aio/workspace';

const EVERY_MS = 1000;
/** A minute for the model to load; after that the asset tools measure when they are used. */
const MAX_TRIES = 60;

/** The timers and the index, so a test turns the clock itself. */
export interface AssetWarmDeps<Timer> {
  setInterval(run: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
  index(): Pick<AssetIndex, 'status'>;
}

const APP_DEPS: AssetWarmDeps<ReturnType<typeof globalThis.setInterval>> = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (timer) => {
    globalThis.clearInterval(timer);
  },
  index: () => assetIndex(defaultToolContext('scene3d')),
};

/**
 * The project and how many assets it has tagged: what the remembered bounds are good for (the
 * index drops them when the count changes). Null without a project or without a tagged asset.
 */
function warmKey(project: OpenProject | null): string | null {
  if (!project) return null;
  let tags = 0;
  for (const l of project.manifest.layers) if (l.kind === 'mesh') tags += l.tags?.length ?? 0;
  return tags > 0 ? `${project.id}/${String(tags)}` : null;
}

function warm<Timer>(deps: AssetWarmDeps<Timer>): () => void {
  let timer: { id: Timer } | null = null;
  /** The key whose bounds are known: not asked again. */
  let known: string | null = null;

  const stop = () => {
    if (!timer) return;
    deps.clearInterval(timer.id);
    timer = null;
  };
  const start = () => {
    stop();
    const key = warmKey(workspace.getState().project);
    // without the 3D view there is nothing to measure: its mounting starts this again
    if (key === null || key === known || !getActiveScene()) return;
    let tries = 0;
    const id = deps.setInterval(() => {
      tries += 1;
      let status: AssetIndex['status'];
      try {
        status = deps.index().status;
      } catch {
        // no project any more, or a scene half torn down: the next project or view starts anew
        stop();
        return;
      }
      if (status === 'ready') known = key;
      if (status !== 'loading' || tries >= MAX_TRIES) stop();
    }, EVERY_MS);
    timer = { id };
  };

  start();
  const offProject = workspace.subscribe((s, prev) => {
    // another project, or the same one with its assets tagged anew; a manifest that is saved
    // again with the same tags leaves a running count alone
    if (s.project !== prev.project && warmKey(s.project) !== warmKey(prev.project)) start();
  });
  const offScene = onActiveScene((scene) => {
    if (scene) start();
    else stop();
  });
  return () => {
    offProject();
    offScene();
    stop();
  };
}

/**
 * Fill the asset bounds of the open project as soon as its model has loaded, and again for every
 * project opened after it. Returns a stop function.
 */
export function startAssetWarm(): () => void;
export function startAssetWarm<Timer>(deps: AssetWarmDeps<Timer>): () => void;
export function startAssetWarm<Timer>(deps?: AssetWarmDeps<Timer>): () => void {
  return deps ? warm(deps) : warm(APP_DEPS);
}
