import type { IpcEvent } from '@aio/schema';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Handle } from './notYet';
import { readOrientation } from './orientation';

const lib = () => import('@aio/project/builder');
const PACKAGE = 'This is a package: its files stay inside it.';
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface LayerIpcDeps {
  handle: Handle;
  projects: { root(id: string): string | undefined; package(id: string): unknown };
  /** Electron `shell.showItemInFolder`. */
  reveal(path: string): void;
  emit(e: IpcEvent<'export:progress'>): void;
}

/** `layer:info`, `layer:reveal` and `layer:export`; the returned `cancel` serves `export:cancel`. */
export function registerLayerIpc(deps: LayerIpcDeps): { cancel(jobId: string): boolean } {
  const { handle, projects } = deps;
  const running = new Map<string, AbortController>();
  const open = async (projectId: string, layerId: string) => {
    if (projects.package(projectId) !== undefined) return { error: PACKAGE } as const;
    const root = projects.root(projectId);
    if (root === undefined) return { error: `Project "${projectId}" is not open.` } as const;
    const l = await lib();
    const m = await l.readManifestFile(root);
    const layer = m.layers.find((x) => x.id === layerId);
    if (!layer) return { error: `Dataset "${layerId}" is not in this project.` } as const;
    return { root, m, layer, l } as const;
  };

  handle('layer:info', async ({ projectId, layerId }) => {
    try {
      const o = await open(projectId, layerId);
      if ('error' in o) return { ok: false, error: o.error };
      const or = await readOrientation(o.root);
      return {
        ok: true,
        info: await o.l.readLayerInfo(o.root, o.m, o.layer, or.ok ? or.file : null),
      };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  });

  handle('layer:reveal', async ({ projectId, layerId }) => {
    try {
      const o = await open(projectId, layerId);
      if ('error' in o) return { ok: false, error: o.error };
      const file = o.l.mainFile(o.layer);
      const none = { ok: false as const, error: `${o.layer.name} has no file in the project.` };
      if (!file || !o.l.insideRef(file)) return none;
      const path = join(o.root, ...file.split('/'));
      if (
        !(await stat(path).then(
          () => true,
          () => false,
        ))
      )
        return none;
      deps.reveal(path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  });

  handle('layer:export', async ({ projectId, jobId, layerIds, dir }) => {
    if (projects.package(projectId) !== undefined) return { ok: false, error: PACKAGE };
    const root = projects.root(projectId);
    if (root === undefined) return { ok: false, error: `Project "${projectId}" is not open.` };
    if (!isAbsolute(dir)) return { ok: false, error: 'Choose a full folder path.' };
    if (running.has(jobId)) return { ok: false, error: 'That export is already running.' };
    const ac = new AbortController();
    running.set(jobId, ac);
    try {
      const l = await lib();
      const m = await l.readManifestFile(root);
      const r = await l.exportLayers(root, m, layerIds, dir, {
        signal: ac.signal,
        progress: (done, total, file) => {
          deps.emit({ jobId, phase: file, done, total });
        },
      });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    } finally {
      running.delete(jobId);
    }
  });

  return {
    cancel: (jobId) => {
      const ac = running.get(jobId);
      ac?.abort();
      return ac !== undefined;
    },
  };
}
