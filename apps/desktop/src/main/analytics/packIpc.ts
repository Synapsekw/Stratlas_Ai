/**
 * The six `analyticsPack:*` channels: what is installed, archives worth offering, the file dialog,
 * install, cancel and remove. Modelled on `registerPipelinePackIpc` (jobs/packInstall.ts) and
 * served by the same installer with `ANALYTICS_PACK`. An install reports its progress through
 * `d.emit` (`analyticsPack:progress`, the same `PackInstallProgress`).
 */
import type { IpcResponse } from '@aio/schema';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compareVersions } from '../jobs/pack';
import {
  ANALYTICS_PACK,
  findPackArchives,
  installPackArchive,
  listPacks,
  PackRefused,
  type ArchivePlace,
  type PipelinePackIpcDeps,
} from '../jobs/packInstall';
import { findAnalyticsPack, unusablePacks, type PackPlace } from './pack';
import { VLM_PACK_IN_USE } from './server';

export interface AnalyticsPackIpcDeps extends PipelinePackIpcDeps {
  /**
   * Keep the model server off a pack folder (every pack when `dir` is left out) while it is
   * removed or replaced: the release, or null when the server runs from it now (`VlmServer.hold`).
   * Windows file locks are not relied on.
   */
  hold?: (dir?: string) => (() => void) | null;
}

export function registerAnalyticsPackIpc(d: AnalyticsPackIpcDeps): void {
  let running: AbortController | null = null;
  const places = (): ArchivePlace[] => [
    ...d.places(),
    { dir: join(d.dataRoot(), 'runtime'), where: 'runtime' },
  ];
  const archives = () =>
    findPackArchives({ places: places(), platform: d.platform, app: d.app, kind: ANALYTICS_PACK });
  const here = (): PackPlace => ({
    dataRoot: d.dataRoot(),
    env: d.env,
    app: d.app,
    platform: d.platform,
  });
  const installed = async () => {
    const pack = await findAnalyticsPack(here());
    return pack ? { version: pack.version, dir: pack.dir } : null;
  };
  const status = async (): Promise<IpcResponse<'analyticsPack:status'>> => {
    const [have, found, unusable] = await Promise.all([
      installed(),
      archives(),
      unusablePacks(here()),
    ]);
    const newest = found[0];
    const offer =
      newest && (have === null || compareVersions(newest.version, have.version) > 0)
        ? { path: newest.path, version: newest.version }
        : null;
    return { installed: have, offer, unusable };
  };

  d.handle('analyticsPack:status', status);
  d.handle('analyticsPack:find', async () => ({
    archives: (await archives()).map((a) => ({ path: a.path, version: a.version })),
  }));
  d.handle('analyticsPack:choose', async () => {
    const newest = (await archives())[0];
    return {
      path: await d.chooseFile(newest ? dirname(newest.path) : (d.places().at(-1)?.dir ?? null)),
    };
  });
  /** An install that replaces a pack: no server may run from any of them while it moves in. */
  const holdAll = (): Promise<() => void> => {
    const release = d.hold ? d.hold() : () => undefined;
    return release === null
      ? Promise.reject(new PackRefused(VLM_PACK_IN_USE))
      : Promise.resolve(release);
  };
  d.handle('analyticsPack:install', async ({ path, replace }) => {
    if (running) {
      return { ok: false, error: 'The Analytics pack is being installed already.', code: 'busy' };
    }
    running = new AbortController();
    try {
      const r = await installPackArchive(path, {
        kind: ANALYTICS_PACK,
        dataRoot: d.dataRoot(),
        app: d.app,
        platform: d.platform,
        ...(replace === true ? { replace } : {}),
        signal: running.signal,
        onProgress: d.emit,
        // replacing the installed version: not under a running server
        ...(replace === true ? { beforeActivate: holdAll } : {}),
        ...(d.assertWritable ? { assertWritable: d.assertWritable } : {}),
        ...(d.freeBytes ? { freeBytes: d.freeBytes } : {}),
        // the one publisher key: only signed packs install; without it, the person confirms
        ...(d.packKey ? { packKey: d.packKey } : {}),
        ...(d.confirmUnsigned ? { confirmUnsigned: d.confirmUnsigned } : {}),
      });
      return r.ok ? { ok: true, version: r.version } : r;
    } finally {
      running = null;
    }
  });
  d.handle('analyticsPack:cancel', () => {
    running?.abort();
    return { ok: running !== null };
  });
  d.handle('analyticsPack:remove', async ({ version }) => {
    const runtimeDir = join(d.dataRoot(), 'runtime');
    const name = `${ANALYTICS_PACK.prefix}-${version}`;
    const pack = (await listPacks(d.dataRoot(), ANALYTICS_PACK)).find((p) => p.name === name);
    if (!pack) return { ok: false, error: `There is no ${name} in ${runtimeDir}.` };
    const release = d.hold ? d.hold(pack.dir) : () => undefined;
    if (release === null) return { ok: false, error: VLM_PACK_IN_USE };
    try {
      d.assertWritable?.(pack.dir, 'analytics pack remove');
      // a real folder of runtime, never what a link there points at
      if (!(await lstat(pack.dir)).isDirectory()) throw new Error('it is not a folder');
      await d.trash(pack.dir);
    } catch (e) {
      return {
        ok: false,
        error: `${name} could not be moved to the bin: ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      release();
    }
    return { ok: true };
  });
}
