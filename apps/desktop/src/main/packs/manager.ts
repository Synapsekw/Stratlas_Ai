import { MapPackInfo, PackJob, type PackRegion } from '@aio/schema';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { readJson, writeJsonAtomic } from '../fsutil';
import { listPacks } from '../library';
import { checkPack } from './header';

/** Protomaps daily planet builds (https://docs.protomaps.com/basemaps/downloads). */
export const BUILD_BASE = 'https://build.protomaps.com/';

export interface ExtractRequest {
  /** Remote planet archive, e.g. https://build.protomaps.com/20261003.pmtiles. */
  source: string;
  /** Output file (a partial file in the downloads folder). */
  out: string;
  bbox: readonly [number, number, number, number];
  maxZoom: number;
  signal: AbortSignal;
  /** Fraction done, 0 to 1. */
  onProgress(fraction: number): void;
}

/** Runs `pmtiles extract`; resolves when the output file is complete. */
export type Extract = (req: ExtractRequest) => Promise<void>;

export interface PackManagerOptions {
  packsDir: () => string;
  offlineOnly: () => boolean;
  emit: (job: PackJob) => void;
  /** null when this build has no extract tool. */
  extract: Extract | null;
  /** Key of the newest planet build, e.g. `20261003` (an online lookup). */
  latestBuild: (signal: AbortSignal) => Promise<string>;
  now?: () => Date;
}

interface Result {
  ok: boolean;
  error?: string;
}
type ImportResult = { ok: true; pack: MapPackInfo } | { ok: false; error: string };

interface Entry {
  job: PackJob;
  abort?: AbortController | undefined;
  done?: Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A pack id from a file name: lowercase ASCII words joined by dashes. */
export function slugId(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'pack';
}

/**
 * Installed map packs, downloads of new regions from the Protomaps daily build (the only network
 * path besides cloud AI, and only when the person starts it), file imports and removal.
 *
 * Downloads write `<packs>/.downloads/<id>.pmtiles.part` and keep a job record
 * `<packs>/.downloads/<id>.json`, so a download cut off by a restart shows as interrupted and
 * can be resumed against the same planet build. `pmtiles extract` cannot continue a partial
 * file, so resuming starts that region's extract again.
 */
export function createPackManager(o: PackManagerOptions) {
  const now = o.now ?? (() => new Date());
  const entries = new Map<string, Entry>();
  const downloads = () => join(o.packsDir(), '.downloads');
  const recordPath = (id: string) => join(downloads(), `${id}.json`);
  const partPath = (id: string) => join(downloads(), `${id}.pmtiles.part`);
  const packPath = (id: string) => join(o.packsDir(), `${id}.pmtiles`);
  const infoPath = (id: string) => join(o.packsDir(), `${id}.json`);

  const running = (id: string) => {
    const s = entries.get(id)?.job.state;
    return s === 'running' || s === 'verifying';
  };

  async function persist(job: PackJob): Promise<void> {
    await mkdir(downloads(), { recursive: true });
    await writeJsonAtomic(recordPath(job.id), job);
  }

  function update(entry: Entry, patch: Partial<PackJob>): void {
    entry.job = { ...entry.job, ...patch };
    o.emit(entry.job);
  }

  async function installed(id: string): Promise<boolean> {
    return (await exists(packPath(id))) || (await exists(infoPath(id)));
  }

  async function run(entry: Entry): Promise<void> {
    const ac = new AbortController();
    entry.abort = ac;
    const { id } = entry.job;
    const part = partPath(id);
    let lastStep = -1;
    const sizer = setInterval(() => {
      void stat(part).then(
        (s) => {
          if (running(id) && s.size !== entry.job.bytes) update(entry, { bytes: s.size });
        },
        () => undefined,
      );
    }, 1000);
    try {
      const extract = o.extract;
      if (!extract) throw new Error('This build does not include the map download tool.');
      if (!entry.job.build) {
        entry.job = { ...entry.job, build: await o.latestBuild(ac.signal) };
        await persist(entry.job);
      }
      await mkdir(downloads(), { recursive: true });
      await rm(part, { force: true });
      await extract({
        source: `${BUILD_BASE}${entry.job.build ?? ''}.pmtiles`,
        out: part,
        bbox: entry.job.bbox,
        maxZoom: entry.job.maxZoom,
        signal: ac.signal,
        onProgress: (f) => {
          const progress = Math.max(0, Math.min(1, f));
          const step = Math.floor(progress * 200);
          if (step === lastStep || entry.job.state !== 'running') return;
          lastStep = step;
          update(entry, { progress });
        },
      });
      if (ac.signal.aborted) throw new Error('Cancelled');
      update(entry, { state: 'verifying' });
      await checkPack(part, { maxZoom: entry.job.maxZoom, bbox: entry.job.bbox });
      if (await installed(id)) throw new Error(`A map pack "${id}" was installed meanwhile.`);
      const size = (await stat(part)).size;
      await rename(part, packPath(id));
      const info: MapPackInfo = {
        id,
        label: entry.job.label,
        bbox: [...entry.job.bbox],
        maxZoom: entry.job.maxZoom,
        sizeBytes: size,
        builtAt: now().toISOString(),
        source: 'download',
        ...(entry.job.build ? { build: entry.job.build } : {}),
      };
      await writeJsonAtomic(infoPath(id), info);
      await rm(recordPath(id), { force: true });
      update(entry, { state: 'done', progress: 1, bytes: size });
    } catch (e) {
      await rm(part, { force: true }).catch(() => undefined);
      if (ac.signal.aborted) update(entry, { state: 'cancelled', error: undefined });
      else update(entry, { state: 'failed', error: message(e) });
      await persist(entry.job).catch(() => undefined);
    } finally {
      clearInterval(sizer);
      entry.abort = undefined;
    }
  }

  function start(entry: Entry): void {
    entry.done = run(entry);
  }

  function refuse(): string | null {
    if (o.offlineOnly()) {
      return 'This workstation is set to offline-only. Turn that off in Settings, Privacy to download map data.';
    }
    if (!o.extract) {
      return 'This build does not include the map download tool (go-pmtiles). Import a pack file instead.';
    }
    return null;
  }

  return {
    async list(): Promise<MapPackInfo[]> {
      const packs = await listPacks(o.packsDir());
      return Promise.all(
        packs.map(async (p) => {
          if (p.builtAt) return p;
          try {
            return { ...p, builtAt: (await stat(packPath(p.id))).mtime.toISOString() };
          } catch {
            return p;
          }
        }),
      );
    },

    jobs(): PackJob[] {
      return [...entries.values()].map((e) => e.job);
    },

    /** Load job records left by an earlier session; running ones become interrupted. */
    async restore(): Promise<void> {
      let names: string[];
      try {
        names = (await readdir(downloads())).filter((n) => n.endsWith('.json'));
      } catch {
        return;
      }
      for (const name of names) {
        try {
          const r = PackJob.safeParse(await readJson(join(downloads(), name)));
          if (!r.success || entries.has(r.data.id)) continue;
          let job = r.data;
          if (job.state === 'running' || job.state === 'verifying') {
            job = { ...job, state: 'interrupted' };
            await persist(job);
          }
          await rm(partPath(job.id), { force: true });
          entries.set(job.id, { job });
        } catch (e) {
          console.warn(`Map pack job ${name} is unreadable: ${message(e)}`);
        }
      }
    },

    async download(region: PackRegion): Promise<Result> {
      const why = refuse();
      if (why) return { ok: false, error: why };
      if (running(region.id)) {
        return { ok: false, error: `"${region.label}" is already downloading.` };
      }
      if (await installed(region.id)) {
        return {
          ok: false,
          error: `A map pack "${region.id}" is already installed. Remove it first or pick another area or zoom.`,
        };
      }
      const job: PackJob = {
        ...region,
        state: 'running',
        progress: 0,
        bytes: 0,
        startedAt: now().toISOString(),
      };
      const entry: Entry = { job };
      entries.set(job.id, entry);
      try {
        await persist(job);
      } catch (e) {
        entries.delete(job.id);
        return { ok: false, error: `The packs folder is not writable: ${message(e)}` };
      }
      o.emit(job);
      start(entry);
      return { ok: true };
    },

    async resume(id: string): Promise<Result> {
      const entry = entries.get(id);
      if (!entry) return { ok: false, error: `No download "${id}" to resume.` };
      if (running(id)) return { ok: false, error: `"${entry.job.label}" is already downloading.` };
      if (entry.job.state === 'done') return { ok: false, error: 'That download has finished.' };
      const why = refuse();
      if (why) return { ok: false, error: why };
      update(entry, { state: 'running', progress: 0, bytes: 0, error: undefined });
      await persist(entry.job);
      start(entry);
      return { ok: true };
    },

    async cancel(id: string): Promise<Result> {
      const entry = entries.get(id);
      if (!entry?.abort || !running(id)) {
        return { ok: false, error: `No download "${id}" is running.` };
      }
      entry.abort.abort();
      await entry.done;
      return { ok: true };
    },

    async dismiss(id: string): Promise<Result> {
      if (running(id)) return { ok: false, error: 'Cancel the download first.' };
      if (!entries.delete(id)) return { ok: false, error: `No download "${id}".` };
      await rm(recordPath(id), { force: true });
      await rm(partPath(id), { force: true });
      return { ok: true };
    },

    /** Resolves when the job's current run has finished (tests, shutdown). */
    async settled(id: string): Promise<void> {
      await entries.get(id)?.done;
    },

    async remove(id: string): Promise<Result> {
      if (running(id))
        return { ok: false, error: 'That pack is still downloading. Cancel it first.' };
      if (!(await installed(id))) return { ok: false, error: `No map pack "${id}" is installed.` };
      try {
        await rm(packPath(id), { force: true });
        await rm(infoPath(id), { force: true });
      } catch (e) {
        return {
          ok: false,
          error: `The pack could not be removed (close any map using it and try again): ${message(e)}`,
        };
      }
      return { ok: true };
    },

    async importFile(path: string, label?: string): Promise<ImportResult> {
      if (extname(path).toLowerCase() !== '.pmtiles') {
        return { ok: false, error: 'Choose a .pmtiles map pack file.' };
      }
      let header;
      try {
        header = await checkPack(path);
      } catch (e) {
        return { ok: false, error: message(e) };
      }
      const stem = basename(path, extname(path));
      let side: MapPackInfo | undefined;
      try {
        const r = MapPackInfo.safeParse(await readJson(join(dirname(path), `${stem}.json`)));
        if (r.success) side = r.data;
      } catch {
        side = undefined;
      }
      const id = side?.id ?? slugId(stem);
      if (await installed(id)) {
        return { ok: false, error: `A map pack "${id}" is already installed. Remove it first.` };
      }
      const dir = o.packsDir();
      const part = join(dir, `${id}.pmtiles.part`);
      try {
        await mkdir(dir, { recursive: true });
        await copyFile(path, part);
        await rename(part, packPath(id));
        const info: MapPackInfo = {
          id,
          label: label ?? side?.label ?? stem,
          bbox: header.bbox,
          maxZoom: header.maxZoom,
          sizeBytes: (await stat(packPath(id))).size,
          builtAt: side?.builtAt ?? now().toISOString(),
          source: 'import',
          ...(side?.build ? { build: side.build } : {}),
        };
        await writeJsonAtomic(infoPath(id), info);
        return { ok: true, pack: info };
      } catch (e) {
        await rm(part, { force: true }).catch(() => undefined);
        return { ok: false, error: `The pack could not be copied: ${message(e)}` };
      }
    },
  };
}

export type PackManager = ReturnType<typeof createPackManager>;
