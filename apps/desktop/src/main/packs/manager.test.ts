import type { PackJob, PackRegion } from '@aio/schema';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pmtilesFile, type PmtilesFixture } from '../testing';
import { createPackManager, type Extract, type ExtractRequest } from './manager';

/** Asymmetric matcher typed as unknown, so object literals stay type-safe. */
const matching = (re: RegExp): unknown => expect.stringMatching(re);

let base: string;
let packsDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-packs-'));
  packsDir = join(base, 'packs');
  await mkdir(packsDir, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const qatar: PackRegion = {
  id: 'qatar-z12',
  label: 'Qatar',
  bbox: [50.74, 24.47, 51.65, 26.2],
  maxZoom: 12,
};

/** An extract tool stand-in that writes a valid (or deliberately broken) archive. */
function fakeExtract(fixture: Partial<PmtilesFixture> = {}, calls: ExtractRequest[] = []): Extract {
  return async (req) => {
    calls.push(req);
    req.onProgress(0.5);
    await writeFile(
      req.out,
      pmtilesFile({ maxZoom: req.maxZoom, bbox: [...req.bbox], ...fixture }),
    );
    req.onProgress(1);
  };
}

function manager(over: Partial<Parameters<typeof createPackManager>[0]> = {}) {
  const events: PackJob[] = [];
  let builds = 0;
  const m = createPackManager({
    packsDir: () => packsDir,
    offlineOnly: () => false,
    emit: (j) => events.push(j),
    extract: fakeExtract(),
    latestBuild: () => {
      builds++;
      return Promise.resolve('20261003');
    },
    now: () => new Date('2026-10-04T08:00:00.000Z'),
    ...over,
  });
  return { m, events, builds: () => builds };
}

describe('pack downloads', () => {
  it('refuses to go online on an offline-only workstation', async () => {
    const { m } = manager({ offlineOnly: () => true });
    const r = await m.download(qatar);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/offline-only/i);
    expect(m.jobs()).toEqual([]);
  });

  it('explains when the download tool is missing from the build', async () => {
    const { m } = manager({ extract: null });
    const r = await m.download(qatar);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/download tool/);
  });

  it('extracts the region from the newest Protomaps build and installs a verified pack', async () => {
    const calls: ExtractRequest[] = [];
    const { m, events } = manager({ extract: fakeExtract({}, calls) });
    expect(await m.download(qatar)).toEqual({ ok: true });
    await m.settled(qatar.id);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe('https://build.protomaps.com/20261003.pmtiles');
    expect(calls[0]?.bbox).toEqual(qatar.bbox);
    expect(calls[0]?.maxZoom).toBe(12);

    const job = m.jobs().find((j) => j.id === qatar.id);
    expect(job).toMatchObject({ state: 'done', progress: 1, build: '20261003' });
    expect(events.map((e) => e.state)).toContain('verifying');
    expect(events.some((e) => e.state === 'running' && e.progress === 0.5)).toBe(true);

    const packs = await m.list();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      id: 'qatar-z12',
      label: 'Qatar',
      maxZoom: 12,
      source: 'download',
      build: '20261003',
      builtAt: '2026-10-04T08:00:00.000Z',
    });
    expect(packs[0]?.sizeBytes).toBe((await stat(join(packsDir, 'qatar-z12.pmtiles'))).size);
    // No partial files or job records are left behind.
    expect(await readdir(join(packsDir, '.downloads'))).toEqual([]);
  });

  it('refuses a region whose id is already installed or downloading', async () => {
    await writeFile(join(packsDir, 'qatar-z12.pmtiles'), pmtilesFile());
    const { m } = manager();
    const r = await m.download(qatar);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already installed/);
  });

  it('fails the job and installs nothing when the result does not verify', async () => {
    const { m } = manager({ extract: fakeExtract({ truncate: 5 }) });
    await m.download(qatar);
    await m.settled(qatar.id);
    const job = m.jobs()[0];
    expect(job?.state).toBe('failed');
    expect(job?.error).toMatch(/incomplete/);
    expect(await m.list()).toEqual([]);
    expect(await readdir(packsDir)).toEqual(['.downloads']);
  });

  it('reports a failing extract tool', async () => {
    const { m } = manager({
      extract: () => Promise.reject(new Error('pmtiles exited with code 1: 404 Not Found')),
    });
    await m.download(qatar);
    await m.settled(qatar.id);
    expect(m.jobs()[0]).toMatchObject({ state: 'failed', error: matching(/404/) });
  });

  it('cancels a running download and keeps the job so it can be resumed', async () => {
    let seen: AbortSignal | undefined;
    const { m } = manager({
      extract: (req) =>
        new Promise((_ok, fail) => {
          seen = req.signal;
          req.signal.addEventListener('abort', () => {
            fail(new Error('aborted'));
          });
        }),
    });
    await m.download(qatar);
    await new Promise((r) => setTimeout(r, 10));
    expect(m.jobs()[0]?.state).toBe('running');
    expect(await m.cancel(qatar.id)).toEqual({ ok: true });
    await m.settled(qatar.id);
    expect(seen?.aborted).toBe(true);
    expect(m.jobs()[0]?.state).toBe('cancelled');
    expect(await m.list()).toEqual([]);
  });

  it('marks a download cut off by a restart as interrupted and resumes it on the same build', async () => {
    const first = manager({ extract: () => new Promise(() => undefined) });
    await first.m.download(qatar);
    await new Promise((r) => setTimeout(r, 10));
    expect(first.builds()).toBe(1);

    // A new app session reads the job record left on disk.
    const calls: ExtractRequest[] = [];
    const second = manager({
      extract: fakeExtract({}, calls),
      latestBuild: () => Promise.reject(new Error('must not look up the build again')),
    });
    await second.m.restore();
    expect(second.m.jobs()[0]).toMatchObject({ id: qatar.id, state: 'interrupted' });
    expect(await second.m.resume(qatar.id)).toEqual({ ok: true });
    await second.m.settled(qatar.id);
    expect(calls[0]?.source).toContain('20261003');
    expect(second.m.jobs()[0]?.state).toBe('done');
  });

  it('dismisses a finished job', async () => {
    const { m } = manager({ extract: fakeExtract({ truncate: 5 }) });
    await m.download(qatar);
    await m.settled(qatar.id);
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
