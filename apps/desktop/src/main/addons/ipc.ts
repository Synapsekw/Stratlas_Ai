/**
 * Settings, Models and detection, Add-ons: `addons:list|install|choose|installFile|cancel|remove`
 * and the `addons:progress` event. One install at a time; Cancel stops the download or the
 * unpack. Offline only blocks the catalogue and downloads, never Choose file. `addons:installFile`
 * takes only a path main's own dialog returned, never one the window made up.
 */
import {
  type AddonCatalogue,
  type AddonCatalogueEntry,
  type AddonInstallResult,
  type AddonKind,
  type AddonListResponse,
  type AddonManifest,
  type AddonProgress,
  type AddonStatus,
  type IpcChannel,
  KNOWN_ADDONS,
} from '@aio/schema';
import { rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Handler } from '../ipc';
import { compareVersions } from '../jobs/pack';
import { downloadVerified, type FetchLike } from '../update/download';
import { freeBytesOf } from '../jobs/packInstall';
import { addonBaseUrl, archiveUrl, guardedFetch, readCatalogue } from './catalogue';
import { packProblem } from './gates';
import {
  addonFolders,
  addonsRoot,
  downloadPath,
  inspectInstalledAddon,
  installAddonArchive,
  removeAddon,
  sweepAddons,
} from './install';

export type AddonsChannel = Extract<IpcChannel, `addons:${string}`>;

export interface AddonsIpcDeps {
  handle: <C extends AddonsChannel>(channel: C, handler: Handler<C>) => void;
  dataRoot: () => string;
  env: Record<string, string | undefined>;
  /** Settings `offlineOnly` and `addons.baseUrl`. */
  settings: () => { offlineOnly: boolean; baseUrl?: string | undefined };
  /** Fetch through the add-ons' own session (the default one blocks the network). */
  fetch: FetchLike;
  /**
   * The catalogue read, when it is not `fetch`: in the app, `netCatalogueFetch` over
   * `net.request`, which checks each redirect before following it (`net.fetch` with
   * `redirect: 'manual'` refuses every redirect instead).
   */
  catalogueFetch?: FetchLike;
  /** The native open dialog for a `.aioaddon`; null when the person closed it. */
  chooseFile: () => Promise<string | null>;
  emit: (p: AddonProgress) => void;
  /** The installed pipeline pack's version (`dev` for a checkout), or null. */
  packVersion: () => Promise<string | null>;
  freeBytes?: (dir: string) => Promise<number | null>;
  now?: () => number;
  /**
   * Choose file, for an archive the add-on list does not vouch for: the "carries no publisher
   * signature" question (index.ts `confirmUnsignedPack`). False: nothing is installed.
   */
  confirmUnlisted?: (m: AddonManifest) => Promise<boolean>;
  /** What the start sweep tidied (`sweepAddons`), for the log. */
  log?: (line: string) => void;
}

/** The names the Add-ons list shows before the catalogue is read. */
export const ADDON_NAMES: Record<string, string> = {
  'road-defects': 'Road defects',
  segmentation: 'Segmentation',
  'ground-classifier': 'Ground classifier',
};

export const OFFLINE_ERROR =
  'Offline only is on in Settings, so add-ons are not downloaded. Choose file installs one from a file.';
export const NO_ADDRESS_ERROR =
  'No add-on address is set, so the add-on list cannot be read. Choose file installs one from a file.';
const PROGRESS_EVERY_MS = 150;
/** Left free on the disk beyond the add-on itself (as install.ts). */
const SPARE_BYTES = 64 * 1024 * 1024;
const mb = (bytes: number) =>
  bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GB`
    : `${String(Math.max(1, Math.ceil(bytes / 2 ** 20)))} MB`;

/** The add-on id in an archive's file name (`road-defects-1.0.0.aioaddon`, a browser's ` (1)`). */
export function archiveNameId(name: string): string | null {
  const m = /^([a-z0-9][a-z0-9-]{0,47}?)-\d+\.\d+\.\d+(?: \(\d+\))?\.aioaddon$/i.exec(name);
  return m?.[1]?.toLowerCase() ?? null;
}

const pathKey = (p: string) =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);

export { packProblem };

/** Progress for one install: every phase change and the last bytes, else at most every 150 ms. */
export function progressThrottle(
  id: string,
  emit: (p: AddonProgress) => void,
  now: () => number = Date.now,
): (p: Omit<AddonProgress, 'id'>) => void {
  let last = -Infinity;
  let phase: AddonProgress['phase'] | null = null;
  return (p) => {
    const t = now();
    if (p.phase === phase && p.bytesDone < p.bytesTotal && t - last < PROGRESS_EVERY_MS) return;
    last = t;
    phase = p.phase;
    emit({ id, ...p });
  };
}

/** downloadVerified speaks of the update file and the feed; here it is the add-on and its list. */
const downloadWords = (message: string) =>
  message.replace(/the update file/g, 'the add-on file').replace(/the feed/g, 'the add-on list');

export function registerAddonsIpc(d: AddonsIpcDeps): {
  /** The app quits: stop a running install. */
  stopAll(): void;
} {
  let running: { ctl: AbortController; id: string | null } | null = null;
  /** The archives main's own dialog returned: `addons:installFile` must name one of them. */
  const named = new Set<string>();
  const now = d.now ?? Date.now;
  // what an interrupted install or removal left is tidied before anything else runs
  const ready = sweepAddons(d.dataRoot()).then(
    (lines) => {
      for (const l of lines) d.log?.(`add-ons: ${l}`);
    },
    (e: unknown) => {
      d.log?.(`add-ons: the start tidy failed: ${String(e)}`);
    },
  );
  const fetch = guardedFetch(d.fetch);

  const catalogue = async (
    timeoutMs?: number,
  ): Promise<
    | { ok: true; base: string; catalogue: AddonCatalogue }
    | { ok: false; base: string | null; error: string; code: 'offline' | 'refused' | 'network' }
  > => {
    const s = d.settings();
    const base = addonBaseUrl(d.env, s.baseUrl);
    if (s.offlineOnly) return { ok: false, base: base.url, error: OFFLINE_ERROR, code: 'offline' };
    if (base.url === null)
      return { ok: false, base: null, error: base.error ?? NO_ADDRESS_ERROR, code: 'refused' };
    const r = await readCatalogue({
      base: base.url,
      fetch: d.catalogueFetch ?? d.fetch,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    return r.ok
      ? { ok: true, base: base.url, catalogue: r.catalogue }
      : { ok: false, base: base.url, error: r.error, code: 'network' };
  };

  d.handle('addons:list', async (): Promise<AddonListResponse> => {
    await ready;
    const [cat, packVersion, folders] = await Promise.all([
      catalogue(),
      d.packVersion(),
      addonFolders(d.dataRoot()),
    ]);
    const offered = new Map<string, AddonCatalogueEntry>(
      cat.ok ? cat.catalogue.addons.map((a) => [a.manifest.id, a]) : [],
    );
    const ids = [...KNOWN_ADDONS.map((k) => k.id)];
    for (const id of [...folders, ...offered.keys()]) if (!ids.includes(id)) ids.push(id);
    const addons: AddonStatus[] = [];
    for (const id of ids) {
      const inspected = await inspectInstalledAddon(d.dataRoot(), id);
      const installed = inspected && 'addon' in inspected ? inspected.addon : null;
      const available = offered.get(id) ?? null;
      const kind: AddonKind | undefined =
        installed?.manifest.kind ??
        available?.manifest.kind ??
        KNOWN_ADDONS.find((k) => k.id === id)?.kind;
      if (!kind) continue; // a damaged folder nobody knows
      const problem =
        (inspected && 'damaged' in inspected ? inspected.damaged : null) ??
        (installed ? packProblem(installed.manifest, packVersion) : null) ??
        (available ? packProblem(available.manifest, packVersion) : null);
      addons.push({
        id,
        kind,
        installed: installed
          ? {
              manifest: installed.manifest,
              dir: installed.dir,
              sizeBytes: installed.manifest.sizeBytes,
            }
          : null,
        available,
        update:
          installed !== null &&
          available !== null &&
          compareVersions(available.manifest.version, installed.manifest.version) > 0,
        ...(problem ? { problem } : {}),
      });
    }
    return {
      addons,
      baseUrl: cat.base,
      ...(cat.ok ? {} : { catalogueError: cat.error }),
    };
  });

  const busy = (): AddonInstallResult => ({
    ok: false,
    error: 'An add-on is already being installed. Wait for it to finish.',
    code: 'busy',
  });

  d.handle('addons:install', async ({ id }) => {
    if (running) return busy();
    const ctl = new AbortController();
    running = { ctl, id };
    const progress = progressThrottle(id, d.emit, now);
    const failed = (r: Extract<AddonInstallResult, { ok: false }>) => {
      progress({
        phase: r.code === 'cancelled' ? 'cancelled' : 'failed',
        bytesDone: 0,
        bytesTotal: 0,
        error: r.error,
      });
      return r;
    };
    try {
      await ready;
      const cat = await catalogue();
      if (!cat.ok) return failed({ ok: false, error: cat.error, code: cat.code });
      const entry = cat.catalogue.addons.find((a) => a.manifest.id === id);
      if (!entry)
        return failed({
          ok: false,
          error: `The add-on list does not offer "${id}".`,
          code: 'refused',
        });
      const packVersion = await d.packVersion();
      const problem = packProblem(entry.manifest, packVersion);
      if (problem) return failed({ ok: false, error: problem, code: 'refused' });
      const url = archiveUrl(cat.base, entry);
      if (!url.ok) return failed({ ok: false, error: url.error, code: 'refused' });
      const dest = downloadPath(d.dataRoot(), id, entry.manifest.version);
      const size = entry.archive.sizeBytes;
      // room for the archive and what it unpacks to, before a byte is downloaded
      const root = addonsRoot(d.dataRoot());
      const free = await (d.freeBytes ?? freeBytesOf)(root);
      const need = size + entry.manifest.sizeBytes + SPARE_BYTES;
      if (free !== null && free < need)
        return failed({
          ok: false,
          code: 'refused',
          error: `${entry.manifest.name} needs ${mb(need)} free in ${root} to download and install; there is ${mb(free)}. Free some space, then try again.`,
        });
      try {
        await downloadVerified({
          url: url.url,
          sha256: entry.archive.sha256,
          size,
          dest,
          fetch,
          signal: ctl.signal,
          onProgress: (done) => {
            progress({ phase: 'download', bytesDone: done, bytesTotal: size });
          },
        });
      } catch (e) {
        if (ctl.signal.aborted)
          return failed({
            ok: false,
            error: 'The download was cancelled. Install again to continue where it stopped.',
            code: 'cancelled',
          });
        return failed({
          ok: false,
          error: downloadWords(e instanceof Error ? e.message : String(e)),
          code: 'network',
        });
      }
      const r = await installAddonArchive(dest, {
        dataRoot: d.dataRoot(),
        signal: ctl.signal,
        onProgress: progress,
        needBytes: entry.manifest.sizeBytes,
        expect: { id, version: entry.manifest.version },
        catalogueSha256: (i, v) =>
          i === id && v === entry.manifest.version ? entry.archive.sha256 : null,
        usable: (m) => packProblem(m, packVersion),
        ...(d.freeBytes ? { freeBytes: d.freeBytes } : {}),
      });
      // a refused archive is never tried again; a cancelled unpack keeps the verified download
      if (r.ok || r.code === 'refused') await rm(dest, { force: true }).catch(() => undefined);
      return r.ok ? r : failed(r);
    } finally {
      running = null;
    }
  });

  d.handle('addons:choose', async () => {
    const path = await d.chooseFile();
    if (path) named.add(pathKey(path));
    return { path };
  });

  d.handle('addons:installFile', async ({ path }) => {
    if (!named.has(pathKey(path)))
      return {
        ok: false,
        error: 'Choose the add-on file with Choose file first: only a file picked there installs.',
        code: 'refused',
      };
    if (running) return busy();
    const ctl = new AbortController();
    running = { ctl, id: null };
    try {
      await ready;
      const packVersion = await d.packVersion();
      // the catalogue, when it can be read, also vouches for the archive as a whole
      const cat = await catalogue(5000).catch(() => null);
      const listed = cat?.ok ? cat.catalogue.addons : [];
      // progress under the id the file name gives (`<id>-<version>.aioaddon`), else the manifest's
      const guess = archiveNameId(basename(path));
      const state = { progress: guess ? progressThrottle(guess, d.emit, now) : null };
      const r = await installAddonArchive(path, {
        dataRoot: d.dataRoot(),
        signal: ctl.signal,
        catalogueSha256: (id, version) =>
          listed.find((a) => a.manifest.id === id && a.manifest.version === version)?.archive
            .sha256 ?? null,
        onProgress: (p) => state.progress?.(p),
        onId: (id) => {
          if (running) running.id = id;
          if (id !== guess) state.progress = progressThrottle(id, d.emit, now);
        },
        usable: (m) => packProblem(m, packVersion),
        ...(d.confirmUnlisted ? { confirmUnlisted: d.confirmUnlisted } : {}),
        ...(d.freeBytes ? { freeBytes: d.freeBytes } : {}),
      });
      if (r.ok) named.delete(pathKey(path));
      else
        state.progress?.({
          phase: r.code === 'cancelled' ? 'cancelled' : 'failed',
          bytesDone: 0,
          bytesTotal: 0,
          error: r.error,
        });
      return r;
    } finally {
      running = null;
    }
  });

  d.handle('addons:cancel', () => {
    if (!running) return { ok: false };
    running.ctl.abort();
    return { ok: true };
  });

  d.handle('addons:remove', async ({ id }) => {
    await ready;
    if (running && (running.id === id || running.id === null))
      return {
        ok: false,
        error: 'An add-on is being installed. Wait for it to finish, then remove it.',
      };
    return removeAddon(d.dataRoot(), id);
  });

  return {
    stopAll: () => {
      running?.ctl.abort();
    },
  };
}
