import { MapPackInfo, PackJob, type PackRegion } from '@aio/schema';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { readJson, writeJsonAtomic } from '../fsutil';
import { listPacks } from '../library';
import {
  EXTRACT_SCHEMA,
  planExtract,
  runExtract,
  StartOverError,
  type ExtractPlan,
  type RangeSource,
} from './extract';
import { checkPack } from './header';

/** Protomaps daily planet builds (https://docs.protomaps.com/basemaps/downloads). */
export const BUILD_BASE = 'https://build.protomaps.com/';

export interface PackManagerOptions {
  packsDir: () => string;
  offlineOnly: () => boolean;
  emit: (job: PackJob) => void;
  /**
   * The planet archive at `url` read by HTTP ranges; `identity` (ETag) is set when continuing a
   * download, so a changed file is noticed.
   */
  source: (url: string, identity?: string) => RangeSource;
  /** Where planet builds live (default Protomaps); a local server in tests. */
  buildBase?: string;
  /** Key of the newest planet build, e.g. `20261003` (an online lookup). */
  latestBuild: (signal: AbortSignal) => Promise<string>;
  now?: () => Date;
  /** Pause before retrying a dropped connection (default 1 s, doubling). */
  retryDelayMs?: number;
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

async function sizeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
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

/** The verified result does not match what was asked for: the partial file is not kept. */
class VerifyError extends Error {}

/**
 * Installed map packs, downloads of new regions from the Protomaps daily build (the only network
 * path besides cloud AI, and only when the person starts it), file imports and removal.
 *
 * A download is a PMTiles extract over HTTP ranges (`extract.ts`): its plan (`<id>.plan.json`,
 * the source ETag and the byte runs to copy) and the partial file `<id>.pmtiles.part` live in
 * `<packs>/.downloads` beside the job record `<id>.json`. A dropped connection is retried; a
 * download cut off by an error, a crash or quitting the app stays `interrupted` with its partial
 * file, and Resume continues from the last byte with a Range request against the same planet
 * build. Cancel and Dismiss delete the partial file. A finished pack is checked (size, every
 * gzip tile's CRC-32, header zoom and area) before it is installed.
 */
export function createPackManager(o: PackManagerOptions) {
  const now = o.now ?? (() => new Date());
  const base = o.buildBase ?? BUILD_BASE;
  const entries = new Map<string, Entry>();
  const downloads = () => join(o.packsDir(), '.downloads');
  const recordPath = (id: string) => join(downloads(), `${id}.json`);
  const planPath = (id: string) => join(downloads(), `${id}.plan.json`);
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

  async function clearPartial(id: string): Promise<void> {
    await rm(partPath(id), { force: true });
    await rm(planPath(id), { force: true });
  }

  async function savedPlan(id: string): Promise<ExtractPlan | null> {
    try {
      const p = (await readJson(planPath(id))) as ExtractPlan | undefined;
      return p?.schema === EXTRACT_SCHEMA ? p : null;
    } catch {
      return null;
    }
  }

  async function run(entry: Entry): Promise<void> {
    const ac = new AbortController();
    entry.abort = ac;
    const { id } = entry.job;
    const part = partPath(id);
    let lastStep = -1;
    try {
      if (!entry.job.build) {
        entry.job = { ...entry.job, build: await o.latestBuild(ac.signal) };
        await persist(entry.job);
      }
      const url = `${base}${entry.job.build ?? ''}.pmtiles`;
      await mkdir(downloads(), { recursive: true });

      const copy = async (plan: ExtractPlan, source: RangeSource, head?: Buffer) => {
        await runExtract({
          source,
          plan,
          ...(head ? { head } : {}),
          out: part,
          signal: ac.signal,
          ...(o.retryDelayMs !== undefined ? { retryDelayMs: o.retryDelayMs } : {}),
          onProgress: (done, total) => {
            const progress = total > 0 ? done / total : 1;
            const step = Math.floor(progress * 200);
            if (step === lastStep || entry.job.state !== 'running') return;
            lastStep = step;
            update(entry, { progress, bytes: plan.headBytes + done });
            if (done === total) update(entry, { state: 'verifying' });
          },
        });
        return plan;
      };
      const fresh = async () => {
        await clearPartial(id);
        const source = o.source(url);
        const { plan, head } = await planExtract(source, {
          bbox: entry.job.bbox,
          maxZoom: entry.job.maxZoom,
          signal: ac.signal,
        });
        await writeJsonAtomic(planPath(id), plan);
        return copy(plan, source, head);
      };

      const saved = await savedPlan(id);
      let plan: ExtractPlan;
      if (saved) {
        try {
          plan = await copy(saved, o.source(url, saved.identity));
        } catch (e) {
          // The build changed on the server or the partial file is unusable: start the region again.
          if (!(e instanceof StartOverError)) throw e;
          plan = await fresh();
        }
      } else plan = await fresh();

      if (ac.signal.aborted) throw new Error('Cancelled');
      if (entry.job.state !== 'verifying') update(entry, { state: 'verifying' });
      try {
        await checkPack(part, { maxZoom: plan.maxZoom, bbox: entry.job.bbox });
      } catch (e) {
        throw new VerifyError(message(e));
      }
      if (await installed(id)) throw new VerifyError(`A map pack "${id}" was installed meanwhile.`);
      const size = (await stat(part)).size;
      await rename(part, packPath(id));
      const info: MapPackInfo = {
        id,
        label: entry.job.label,
        bbox: [...entry.job.bbox],
        maxZoom: plan.maxZoom,
        sizeBytes: size,
        builtAt: now().toISOString(),
        source: 'download',
        ...(entry.job.build ? { build: entry.job.build } : {}),
      };
      await writeJsonAtomic(infoPath(id), info);
      await rm(planPath(id), { force: true });
      await rm(recordPath(id), { force: true });
      update(entry, { state: 'done', progress: 1, bytes: size });
    } catch (e) {
      const partial = await sizeOf(part);
      if (ac.signal.aborted) {
        await clearPartial(id).catch(() => undefined);
        update(entry, { state: 'cancelled', error: undefined, progress: 0, bytes: 0 });
      } else if (partial > 0 && !(e instanceof VerifyError) && (await savedPlan(id))) {
        // Kept for Resume: the next run continues from the partial file.
        update(entry, { state: 'interrupted', error: message(e), bytes: partial });
      } else {
        await clearPartial(id).catch(() => undefined);
        update(entry, { state: 'failed', error: message(e) });
      }
      await persist(entry.job).catch(() => undefined);
    } finally {
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

    /**
     * Load job records left by an earlier session; running ones become interrupted and keep their
     * partial file for Resume.
     */
    async restore(): Promise<void> {
      let names: string[];
      try {
        names = (await readdir(downloads())).filter(
          (n) => n.endsWith('.json') && !n.endsWith('.plan.json'),
        );
      } catch {
        return;
      }
      for (const name of names) {
        try {
          const r = PackJob.safeParse(await readJson(join(downloads(), name)));
          if (!r.success || entries.has(r.data.id)) continue;
          let job = r.data;
          if (job.state === 'running' || job.state === 'verifying') {
            const bytes = await sizeOf(partPath(job.id));
            const plan = await savedPlan(job.id);
            job = {
              ...job,
              state: 'interrupted',
              bytes,
              progress:
                plan && plan.dataBytes > 0
                  ? Math.max(0, Math.min(1, (bytes - plan.headBytes) / plan.dataBytes))
                  : 0,
            };
            await persist(job);
          }
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
        await clearPartial(job.id);
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
      update(entry, { state: 'running', error: undefined });
      await persist(entry.job);
      start(entry);
      return { ok: true };
    },

    /** Stop a running download and delete its partial file. */
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
      await clearPartial(id);
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
