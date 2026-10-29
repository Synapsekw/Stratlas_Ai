/**
 * The five `requests:*` channels over requests.ts. Registered by the main wiring; the dialogs and
 * the project folders are injected so tests open no window.
 */
import { AI_REQUEST_FILE_EXTENSION, type IpcChannel } from '@aio/schema';
import type { Handler } from '../ipc';
import {
  exportRequest,
  importRequest,
  listRequests,
  removeRequest,
  saveRequest,
  type RequestOptions,
  type RequestWhere,
} from './requests';

export interface RequestsIpcDeps {
  handle: <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;
  /** The user data folder (the library lives in `<userData>/requests`). */
  userData: () => string;
  /** The folder of a project, null when the id is unknown. */
  projectDir: (projectId: string) => string | null;
  /** True when the project is a read-only package. */
  isPackage: (projectId: string) => boolean;
  /** Native open dialog for a `.aioreq`; null when closed. */
  chooseOpen: () => Promise<string | null>;
  /** Native save dialog, offered `defaultName`; null when closed. */
  chooseSave: (defaultName: string) => Promise<string | null>;
  assertWritable?: (path: string, op: string) => void;
}

const READ_ONLY = {
  ok: false as const,
  error: 'This project is a read-only package. Requests are not saved into it.',
  code: 'read-only' as const,
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerRequestsIpc(d: RequestsIpcDeps): void {
  /** Options for a call; a project id that is not open is an error only when it is needed. */
  const options = (projectId: string | undefined, where: RequestWhere): RequestOptions => {
    const o: RequestOptions = { userData: d.userData() };
    if (projectId !== undefined) {
      const dir = d.projectDir(projectId);
      if (dir !== null) o.projectDir = dir;
      else if (where === 'project') throw new Error('That project is not open.');
    } else if (where === 'project') {
      throw new Error('This needs a project, and none was given.');
    }
    return o;
  };
  const readOnly = (projectId: string | undefined, where: RequestWhere): boolean =>
    where === 'project' && projectId !== undefined && d.isPackage(projectId);
  const root = (o: RequestOptions, where: RequestWhere) =>
    where === 'project' ? o.projectDir : o.userData;

  d.handle('requests:list', async ({ projectId }) => {
    let o: RequestOptions = { userData: d.userData() };
    if (projectId !== undefined) {
      const dir = d.projectDir(projectId);
      if (dir !== null) o = { ...o, projectDir: dir };
    }
    return listRequests(o);
  });
  d.handle('requests:save', async ({ projectId, where, request }) => {
    try {
      if (readOnly(projectId, where)) return READ_ONLY;
      const o = options(projectId, where);
      const dir = root(o, where);
      if (dir) d.assertWritable?.(dir, 'request save');
      await saveRequest(o, where, request);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('requests:remove', async ({ projectId, where, id }) => {
    try {
      if (readOnly(projectId, where)) return READ_ONLY;
      const o = options(projectId, where);
      const dir = root(o, where);
      if (dir) d.assertWritable?.(dir, 'request remove');
      await removeRequest(o, where, id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('requests:export', async ({ projectId, where, id }) => {
    try {
      const o = options(projectId, where);
      const dest = await d.chooseSave(`${id}${AI_REQUEST_FILE_EXTENSION}`);
      if (dest === null) return { ok: true };
      d.assertWritable?.(dest, 'request export');
      await exportRequest(o, where, id, dest);
      return { ok: true, path: dest };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('requests:import', async ({ projectId, where }) => {
    try {
      if (readOnly(projectId, where)) return READ_ONLY;
      const o = options(projectId, where);
      const file = await d.chooseOpen();
      if (file === null) return { ok: true };
      const dir = root(o, where);
      if (dir) d.assertWritable?.(dir, 'request import');
      return { ok: true, request: await importRequest(o, where, file) };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
}
