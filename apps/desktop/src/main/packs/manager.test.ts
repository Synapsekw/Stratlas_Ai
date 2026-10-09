import type { PackJob, PackRegion } from '@aio/schema';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  noise,
  pmtilesArchive,
  pmtilesFile,
  rangeServer,
  tilesOver,
  type RangeServer,
} from '../testing';
import { createSettingsStore, defaultSettings } from '../settings';
import { httpSource } from './extract';
import { createPackManager } from './manager';

/** Asymmetric matcher typed as unknown, so object literals stay type-safe. */
const matching = (re: RegExp): unknown => expect.stringMatching(re);

let base: string;
let packsDir: string;
let server: RangeServer;
let build: Buffer;

const QATAR_BOX: [number, number, number, number] = [50.74, 24.47, 51.65, 26.2];
const qatar: PackRegion = { id: 'qatar-z10', label: 'Qatar', bbox: QATAR_BOX, maxZoom: 10 };
/** Only tile data requests are longer than this; directory reads stay untouched by faults. */
const DATA = 20_000;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-packs-'));
  packsDir = join(base, 'packs');
  await mkdir(packsDir, { recursive: true });
  // A planet build stand-in over Qatar to zoom 10, served from 127.0.0.1 (no internet).
  build = pmtilesArchive({
    tiles: tilesOver(QATAR_BOX, 0, 10, (z, x, y) =>
      noise(`${String(z)}/${String(x)}/${String(y)}`, 4000),
    ),
    bbox: QATAR_BOX,
    leafSize: 16,
  });
  server = await rangeServer(() => build, '/20261003.pmtiles');
});
afterEach(async () => {
  await server.close();
  await rm(base, { recursive: true, force: true });
});

function manager(over: Partial<Parameters<typeof createPackManager>[0]> = {}) {
  const events: PackJob[] = [];
  const waiters: { test: (j: PackJob) => boolean; done: (j: PackJob) => void }[] = [];
  let builds = 0;
  const m = createPackManager({
    packsDir: () => packsDir,
    offlineOnly: () => false,
    emit: (j) => {
      events.push(j);
      for (const w of waiters.filter((x) => x.test(j))) {
        waiters.splice(waiters.indexOf(w), 1);
        w.done(j);
      }
    },
    source: (url, identity) => httpSource(url, (u, init) => fetch(u, init), identity),
    buildBase: server.url.replace('20261003.pmtiles', ''),
    latestBuild: () => {
      builds++;
      return Promise.resolve('20261003');
    },
    now: () => new Date('2026-10-04T08:00:00.000Z'),
    retryDelayMs: 1,
    ...over,
  });
  /** The first job event (from now on) that passes `test`; no timers involved. */
  const until = (test: (j: PackJob) => boolean) =>
    new Promise<PackJob>((done) => waiters.push({ test, done }));
  return { m, events, until, builds: () => builds };
}

const part = () => join(packsDir, '.downloads', 'qatar-z10.pmtiles.part');

describe('pack downloads', () => {
  it('refuses to go online on an offline-only workstation', async () => {
    const { m } = manager({ offlineOnly: () => true });
    const r = await m.download(qatar);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/offline-only/i);
    expect(m.jobs()).toEqual([]);
    expect(server.ranges).toEqual([]);
  });

  // Privacy: offline-only turned on, then a download asked for at once, while the setting is
  // still being written. The settings store must answer with the change already.
  it('refuses a download asked for right after offline-only is turned on', async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), 'aio-offline-'));
    try {
      const store = createSettingsStore(
        join(settingsDir, 'settings.json'),
        defaultSettings(settingsDir),
      );
      await store.get();
      const { m } = manager({ offlineOnly: () => store.current().offlineOnly === true });
      const writing = store.set({ offlineOnly: true });
      const r = await m.download(qatar);
      await writing;
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/offline-only/i);
      expect(server.ranges).toEqual([]);
    } finally {
      await rm(settingsDir, { recursive: true, force: true });
    }
  });

  it('extracts the region from the newest build over ranges and installs a verified pack', async () => {
    const { m, events, builds } = manager();
    expect(await m.download(qatar)).toEqual({ ok: true });
    await m.settled(qatar.id);

    expect(builds()).toBe(1);
    expect(server.ranges[0]).toBe('bytes=0-16383');
    const job = m.jobs().find((j) => j.id === qatar.id);
    expect(job).toMatchObject({ state: 'done', progress: 1, build: '20261003' });
    expect(events.map((e) => e.state)).toContain('verifying');
    expect(events.some((e) => e.state === 'running' && e.progress > 0 && e.progress < 1)).toBe(
      true,
    );

    const packs = await m.list();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      id: 'qatar-z10',
      label: 'Qatar',
      maxZoom: 10,
      source: 'download',
      build: '20261003',
      builtAt: '2026-10-04T08:00:00.000Z',
    });
    expect(packs[0]?.sizeBytes).toBe((await stat(join(packsDir, 'qatar-z10.pmtiles'))).size);
    // No partial files, plans or job records are left behind.
    expect(await readdir(join(packsDir, '.downloads'))).toEqual([]);
  });

  it('refuses a region whose id is already installed', async () => {
    await writeFile(join(packsDir, 'qatar-z10.pmtiles'), pmtilesFile());
    const { m } = manager();
    const r = await m.download(qatar);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already installed/);
  });

  it('fails the job and keeps no partial file when the server has no such build', async () => {
    const { m } = manager({ latestBuild: () => Promise.resolve('19990101') });
    await m.download(qatar);
    await m.settled(qatar.id);
    expect(m.jobs()[0]).toMatchObject({ state: 'failed', error: matching(/404/) });
    expect(await m.list()).toEqual([]);
    expect(await readdir(join(packsDir, '.downloads'))).toEqual(['qatar-z10.json']);
  });

  it('keeps the partial file when the link keeps dropping and resumes it with a Range request', async () => {
    const { m, events } = manager();
    // The first data request and all three retries are cut short: the run ends interrupted.
    server.cutAfter(5000, 4, DATA);
    await m.download(qatar);
    await m.settled(qatar.id);
    const job = m.jobs()[0];
    expect(job?.state).toBe('interrupted');
    expect(job?.error).toBeTruthy();
    const partial = (await stat(part())).size;
    expect(partial).toBeGreaterThan(0);
    expect(job?.bytes).toBe(partial);

    server.ranges.length = 0;
    expect(await m.resume(qatar.id)).toEqual({ ok: true });
    await m.settled(qatar.id);
    expect(m.jobs()[0]?.state).toBe('done');
    expect(events.at(-1)?.state).toBe('done');
    // No directory reads again: the resume asked straight for the missing tile data.
    expect(server.ranges).not.toContain('bytes=0-16383');
    expect(Number(/^bytes=(\d+)-/.exec(server.ranges[0] ?? '')?.[1])).toBeGreaterThan(16_384);

    // The resumed pack is byte for byte what a clean download gives.
    const resumed = await readFile(join(packsDir, 'qatar-z10.pmtiles'));
    const clean = manager();
    expect(await clean.m.remove('qatar-z10')).toEqual({ ok: true });
    await clean.m.download(qatar);
    await clean.m.settled(qatar.id);
    expect(await readFile(join(packsDir, 'qatar-z10.pmtiles'))).toEqual(resumed);
  });

  it('marks a download cut off by a restart as interrupted and resumes it from the partial file', async () => {
    const first = manager();
    server.cutAfter(8000, 4, DATA);
    await first.m.download(qatar);
    await first.m.settled(qatar.id);
    const partial = (await stat(part())).size;
    expect(partial).toBeGreaterThan(0);
    // The record as a killed app leaves it: still running.
    const record = join(packsDir, '.downloads', 'qatar-z10.json');
    const saved = JSON.parse(await readFile(record, 'utf8')) as PackJob;
    await writeFile(record, JSON.stringify({ ...saved, state: 'running', error: undefined }));

    // A new app session reads the job record and the plan left on disk.
    const second = manager({
      latestBuild: () => Promise.reject(new Error('must not look up the build again')),
    });
    await second.m.restore();
    expect(second.m.jobs()[0]).toMatchObject({
      id: qatar.id,
      state: 'interrupted',
      bytes: partial,
    });
    expect(second.m.jobs()[0]?.progress).toBeGreaterThan(0);
    server.ranges.length = 0;
    expect(await second.m.resume(qatar.id)).toEqual({ ok: true });
    await second.m.settled(qatar.id);
    expect(second.m.jobs()[0]?.state).toBe('done');
    expect(server.ranges).not.toContain('bytes=0-16383');
  });

  it('starts the region again when the build changed on the server', async () => {
    const { m } = manager();
    server.cutAfter(4000, 4, DATA);
    await m.download(qatar);
    await m.settled(qatar.id);
    expect(m.jobs()[0]?.state).toBe('interrupted');
    server.setEtag('"v2"');
    server.ranges.length = 0;
    await m.resume(qatar.id);
    await m.settled(qatar.id);
    expect(m.jobs()[0]?.state).toBe('done');
    expect(server.ranges).toContain('bytes=0-16383');
  });

  it('cancels a running download and deletes its partial file', async () => {
    const { m, until } = manager();
    // The server sends some tile data, then nothing: the job stays running until cancelled.
    server.stallAfter(6000, DATA);
    const progressed = until((j) => j.state === 'running' && (j.bytes ?? 0) > 0);
    await m.download(qatar);
    await progressed;
    expect(await m.cancel(qatar.id)).toEqual({ ok: true });
    expect(m.jobs()[0]).toMatchObject({ state: 'cancelled', bytes: 0 });
    expect(await readdir(join(packsDir, '.downloads'))).toEqual(['qatar-z10.json']);
    expect(await m.list()).toEqual([]);
  });

  it('dismisses a job with its partial file', async () => {
    const { m } = manager();
    server.cutAfter(4000, 4, DATA);
    await m.download(qatar);
    await m.settled(qatar.id);
    expect(m.jobs()[0]?.state).toBe('interrupted');
    expect(await m.dismiss(qatar.id)).toEqual({ ok: true });
    expect(m.jobs()).toEqual([]);
    expect(await readdir(join(packsDir, '.downloads'))).toEqual([]);
  });
});

describe('pack files', () => {
  it('imports a .pmtiles file, reading its area and zoom from the header', async () => {
    const src = join(base, 'Riyadh City.pmtiles');
    await writeFile(src, pmtilesFile({ maxZoom: 14, bbox: [46.4, 24.4, 47.0, 25.0] }));
    const { m } = manager();
    const r = await m.importFile(src);
    expect(r).toMatchObject({
      ok: true,
      pack: {
        id: 'riyadh-city',
        label: 'Riyadh City',
        maxZoom: 14,
        source: 'import',
        builtAt: '2026-10-04T08:00:00.000Z',
      },
    });
    expect(r.ok && r.pack.bbox[0]).toBeCloseTo(46.4, 5);
    expect(await readFile(join(packsDir, 'riyadh-city.pmtiles'))).toEqual(await readFile(src));
    expect((await m.list()).map((p) => p.id)).toEqual(['riyadh-city']);
  });

  it('keeps the id, label and build date from a MapPackInfo file beside the pack', async () => {
    const src = join(base, 'oman.pmtiles');
    await writeFile(src, pmtilesFile({ maxZoom: 13 }));
    await writeFile(
      join(base, 'oman.json'),
      JSON.stringify({
        id: 'oman-streets',
        label: 'Oman streets',
        bbox: [51.9, 16.6, 59.85, 26.4],
        maxZoom: 13,
        sizeBytes: 1,
        builtAt: '2026-09-01T00:00:00.000Z',
        build: '20260901',
      }),
    );
    const { m } = manager();
    const r = await m.importFile(src);
    expect(r).toMatchObject({
      ok: true,
      pack: { id: 'oman-streets', label: 'Oman streets', build: '20260901', source: 'import' },
    });
    expect(r.ok && r.pack.builtAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('refuses files that are not vector PMTiles and packs that are already installed', async () => {
    const { m } = manager();
    const zip = join(base, 'x.pmtiles');
    await writeFile(zip, 'PK not a pack');
    expect(await m.importFile(zip)).toMatchObject({ ok: false, error: /not a PMTiles/ });
    const txt = join(base, 'notes.txt');
    await writeFile(txt, 'x');
    expect(await m.importFile(txt)).toMatchObject({ ok: false, error: /\.pmtiles/ });

    const good = join(base, 'kuwait.pmtiles');
    await writeFile(good, pmtilesFile());
    expect((await m.importFile(good)).ok).toBe(true);
    expect(await m.importFile(good)).toMatchObject({ ok: false, error: /already installed/ });
  });

  it('removes a pack and its description', async () => {
    const { m } = manager();
    const src = join(base, 'bahrain.pmtiles');
    await writeFile(src, pmtilesFile());
    await m.importFile(src);
    expect(await m.remove('bahrain')).toEqual({ ok: true });
    expect(await readdir(packsDir)).toEqual([]);
    expect(await m.remove('bahrain')).toMatchObject({ ok: false });
  });

  it('dates packs without a build date by their file', async () => {
    await writeFile(join(packsDir, 'gcc.pmtiles'), pmtilesFile());
    await writeFile(
      join(packsDir, 'gcc.json'),
      JSON.stringify({
        id: 'gcc',
        label: 'GCC',
        bbox: [34, 12, 60, 32],
        maxZoom: 15,
        sizeBytes: 9,
      }),
    );
    const { m } = manager();
    const [gcc] = await m.list();
    expect(gcc?.builtAt).toBe((await stat(join(packsDir, 'gcc.pmtiles'))).mtime.toISOString());
  });
});
