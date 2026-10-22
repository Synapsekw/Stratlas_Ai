/**
 * The five `detectors:*` channels over detectors.ts. Registered by the job wiring (Task 8); the
 * dialogs, the Analytics pack lookup and the project folder are injected so tests open no window.
 */
import { DETECTOR_FILE_EXTENSION, type IpcChannel } from '@aio/schema';
import type { Handler } from '../ipc';
import {
  exportDetector,
  importDetector,
  listDetectors,
  removeDetector,
  saveDetector,
  type DetectorOptions,
} from './detectors';
import type { AnalyticsPack } from './pack';

export interface DetectorsIpcDeps {
  handle: <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;
  /** The installed Analytics pack, or null. */
  pack: () => Promise<AnalyticsPack | null>;
  /** The user data folder (the library lives in `<userData>/detectors`). */
  userData: () => string;
  /** The folder of a project, null when the id is unknown. */
  projectDir: (projectId: string) => string | null;
  /** Native open dialog for a `.aiodet`; null when closed. */
  chooseOpen: () => Promise<string | null>;
  /** Native save dialog, offered `defaultName`; null when closed. */
  chooseSave: (defaultName: string) => Promise<string | null>;
  assertWritable?: (path: string, op: string) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerDetectorsIpc(d: DetectorsIpcDeps): void {
  const options = async (projectId: string | undefined, needProject: boolean) => {
    const o: DetectorOptions = { pack: await d.pack(), userData: d.userData() };
    if (projectId !== undefined) {
      const dir = d.projectDir(projectId);
      if (dir === null) throw new Error('That project is not open.');
      o.projectDir = dir;
    } else if (needProject) {
      throw new Error('This needs a project, and none was given.');
    }
    return o;
  };

  d.handle('detectors:list', async ({ projectId }) => {
    const o = await options(projectId, false).catch(async () => ({
      pack: await d.pack(),
      userData: d.userData(),
    }));
    return { items: await listDetectors(o) };
  });
  d.handle('detectors:save', async ({ where, projectId, detector }) => {
    try {
      const o = await options(projectId, where === 'project');
      const root = where === 'project' ? o.projectDir : o.userData;
      if (root) d.assertWritable?.(root, 'detector save');
      return { ok: true, version: await saveDetector(o, where, detector) };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('detectors:remove', async ({ where, projectId, id }) => {
    try {
      await removeDetector(await options(projectId, where === 'project'), where, id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('detectors:export', async ({ where, projectId, id, includeSamples, path }) => {
    try {
      const o = await options(projectId, where === 'project');
      const dest = path ?? (await d.chooseSave(`${id}${DETECTOR_FILE_EXTENSION}`));
      if (dest === null) return { ok: false, error: 'Export cancelled.', cancelled: true };
      d.assertWritable?.(dest, 'detector export');
      await exportDetector(o, where, id, dest, includeSamples);
      return { ok: true, path: dest };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('detectors:import', async ({ path, where, projectId, onConflict }) => {
    try {
      const o = await options(projectId, where === 'project');
      const file = path ?? (await d.chooseOpen());
      if (file === null) return { ok: false, error: 'Import cancelled.', cancelled: true };
      const root = where === 'project' ? o.projectDir : o.userData;
      if (root) d.assertWritable?.(root, 'detector import');
      const r = await importDetector(o, file, where, onConflict);
      if ('conflict' in r) {
        return {
          ok: false,
          error: `A detector "${r.conflict.id}" is already here.`,
          conflict: r.conflict,
          path: file,
        };
      }
      return { ok: true, id: r.id };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
}
