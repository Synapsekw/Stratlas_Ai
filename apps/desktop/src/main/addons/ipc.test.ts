import type { AddonCatalogueEntry, AddonProgress } from '@aio/schema';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import type { FetchLike } from '../update/download';
import { fakeAddonArchive, fakeCatalogue, fakeCatalogueEntry, type FakeAddon } from './addon.fakes';
import { addonBaseUrl, archiveUrl, parseCatalogue, readCatalogue } from './catalogue';
import { installAddonArchive, readInstalledAddon } from './install';
import { archiveNameId, progressThrottle, registerAddonsIpc } from './ipc';

let base: string;
let dataRoot: string;
let server: Server;
let url: string;
/** What the fake server answers, by path. */
let routes: Map<string, Buffer | string>;
let requests: string[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-addons-ipc-'));
  dataRoot = join(base, 'data');
  routes = new Map();
  requests = [];
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const body = routes.get(req.url ?? '');
    if (body === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-length', String(Buffer.byteLength(body)));
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/addons/`;
});
afterEach(async () => {
  await new Promise<void>((r) =>
    server.close(() => {
      r();
    }),
  );
  await rm(base, { recursive: true, force: true });
});

const fetchLike: FetchLike = (u, init) => fetch(u, init);

function serve(addons: readonly FakeAddon[], tweak?: (e: AddonCatalogueEntry) => void) {
  const entries = addons.map((a) => {
    const e = fakeCatalogueEntry(a);
    tweak?.(e);
    routes.set(`/addons/${a.fileName}`, a.bytes);
    return e;
  });
  routes.set('/addons/catalogue.json', JSON.stringify(fakeCatalogue(entries)));
}

function setup(o: { offline?: boolean; baseUrl?: string; pack?: string | null } = {}) {
  const progress: AddonProgress[] = [];
  const picked = { path: null as string | null };
  let ipc: ReturnType<typeof registerAddonsIpc> | null = null;
  const h = collectHandlers((handle) => {
    ipc = registerAddonsIpc({
      handle,
      dataRoot: () => dataRoot,
      env: {},
      settings: () => ({ offlineOnly: o.offline ?? false, baseUrl: o.baseUrl ?? url }),
      fetch: fetchLike,
      chooseFile: () => Promise.resolve(picked.path),
      emit: (p) => progress.push(p),
      packVersion: () => Promise.resolve(o.pack === undefined ? '0.35.0' : o.pack),
    });
  });
  return { ...h, progress, picked, ipc };
}

const road = (version = '1.0.0', extra: Partial<Parameters<typeof fakeAddonArchive>[0]> = {}) =>
  fakeAddonArchive({
    id: 'road-defects',
    kind: 'detector',
    version,
    name: 'Road defects',
    ...extra,
  });

describe('catalogue', () => {
  it('takes the address from the environment, then Settings, and only https or loopback', () => {
    expect(
      addonBaseUrl({ QUADRION_ADDONS_URL: 'https://a.example/x' }, 'https://b.example'),
    ).toEqual({ url: 'https://a.example/x/' });
    expect(addonBaseUrl({}, 'https://b.example/addons/')).toEqual({
      url: 'https://b.example/addons/',
    });
    expect(addonBaseUrl({}, undefined)).toEqual({ url: null });
    expect(addonBaseUrl({}, 'http://b.example/')).toMatchObject({ url: null, error: /https/ });
    expect(addonBaseUrl({}, 'http://localhost:8080')).toEqual({ url: 'http://localhost:8080/' });
  });

  it('resolves archive addresses against the base and refuses plain http elsewhere', () => {
    const e = fakeCatalogueEntry(road());
    expect(archiveUrl('https://a.example/addons/', e)).toEqual({
      ok: true,
      url: 'https://a.example/addons/road-defects-1.0.0.aioaddon',
    });
    expect(
      archiveUrl('https://a.example/addons/', {
        ...e,
        archive: { ...e.archive, url: 'http://evil.example/x.aioaddon' },
      }),
    ).toMatchObject({ ok: false });
  });

  it('says why a catalogue is not one', async () => {
    expect(parseCatalogue({ schema: 'x' })).toMatchObject({ ok: false });
    const e = fakeCatalogueEntry(road());
    expect(parseCatalogue(fakeCatalogue([e, e]))).toMatchObject({
      ok: false,
      error: /twice/,
    });
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({
      ok: false,
      error: /HTTP 404/,
    });
    routes.set('/addons/catalogue.json', 'not json');
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({
      ok: false,
      error: /not JSON/,
    });
  });
});

describe('addons:list', () => {
  it('lists the known add-ons with the catalogue, an update and a pack problem', async () => {
    serve([road('1.1.0', { minPipelinePack: '0.36.0' })]);
    const old = road('1.0.0');
    await writeFile(join(base, old.fileName), old.bytes);
    await installAddonArchive(join(base, old.fileName), { dataRoot });
    const { call } = setup();
    const r = await call('addons:list', {});
    expect(r.catalogueError).toBeUndefined();
    expect(r.baseUrl).toBe(url);
    expect(r.addons.map((a) => a.id)).toEqual([
      'road-defects',
      'segmentation',
      'ground-classifier',
    ]);
    const row = r.addons[0];
    expect(row).toMatchObject({
      installed: { manifest: { version: '1.0.0' } },
      available: { manifest: { version: '1.1.0' } },
      update: true,
      problem:
        'Road defects needs processing tools 0.36.0 or later (these are 0.35.0). Update them in Settings, Processing tools.',
    });
    expect(r.addons[1]).toMatchObject({ installed: null, available: null, update: false });
  });

  it('never reads the catalogue offline, and says so', async () => {
    serve([road()]);
    const { call } = setup({ offline: true });
    const r = await call('addons:list', {});
    expect(r.catalogueError).toMatch(/Offline only/);
    expect(requests).toEqual([]);
    const none = await setup({ baseUrl: '' }).call('addons:list', {});
    expect(none).toMatchObject({ baseUrl: null, catalogueError: /No add-on address/ });
  });
});

describe('addons:install', () => {
  it('downloads, checks and installs, with progress', async () => {
    serve([road()]);
    const { call, progress } = setup();
    const r = await call('addons:install', { id: 'road-defects' });
    expect(r).toMatchObject({ ok: true, manifest: { id: 'road-defects' } });
    expect(progress.some((p) => p.phase === 'download')).toBe(true);
    expect(progress.at(-1)).toMatchObject({ id: 'road-defects', phase: 'done' });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).not.toBeNull();
    // the download is gone once installed
    expect(await readdir(join(dataRoot, 'runtime', 'addons', '.download'))).toEqual([]);
  });

  it('refuses a size or SHA-256 that does not match the catalogue', async () => {
    serve([road()], (e) => {
      e.archive.sizeBytes -= 10;
    });
    const short = await setup().call('addons:install', { id: 'road-defects' });
    expect(short).toMatchObject({
      ok: false,
      code: 'network',
      error: /larger than the add-on list says/,
    });
    serve([road()], (e) => {
      e.archive.sha256 = 'd'.repeat(64);
    });
    const { call, progress } = setup();
    const bad = await call('addons:install', { id: 'road-defects' });
    expect(bad).toMatchObject({ ok: false, error: /does not match the add-on list \(SHA-256\)/ });
    expect(progress.at(-1)).toMatchObject({ phase: 'failed' });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
  });

  it('refuses a tampered archive the catalogue vouches for', async () => {
    const tampered = road('1.0.0', { override: { 'model.onnx': 'not the model' } });
    serve([tampered]);
    const r = await setup().call('addons:install', { id: 'road-defects' });
    expect(r).toMatchObject({ ok: false, code: 'refused' });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
  });

  it('refuses offline, an unknown id, an old pack and a second install at once', async () => {
    serve([road('1.0.0', { minPipelinePack: '0.40.0' })]);
    expect(
      await setup({ offline: true }).call('addons:install', { id: 'road-defects' }),
    ).toMatchObject({ ok: false, code: 'offline' });
    expect(requests).toEqual([]);
    expect(await setup().call('addons:install', { id: 'segmentation' })).toMatchObject({
      ok: false,
      error: /does not offer "segmentation"/,
    });
    expect(
      await setup({ pack: null }).call('addons:install', { id: 'road-defects' }),
    ).toMatchObject({
      ok: false,
      error: /needs processing tools 0.40.0 or later. Install them/,
    });
    serve([road()]);
    const { call } = setup();
    const [a, b] = await Promise.all([
      call('addons:install', { id: 'road-defects' }),
      call('addons:install', { id: 'road-defects' }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ code: 'busy' });
  });
});

describe('addons:installFile and addons:remove', () => {
  it('installs only a file main picked, offline too', async () => {
    const a = road();
    const path = join(base, a.fileName);
    await writeFile(path, a.bytes);
    const { call, picked, progress } = setup({ offline: true });
    expect(await call('addons:installFile', { path })).toMatchObject({
      ok: false,
      error: /Choose file first/,
    });
    picked.path = path;
    expect(await call('addons:choose', {})).toEqual({ path });
    expect(await call('addons:installFile', { path })).toMatchObject({ ok: true });
    expect(progress.at(-1)).toMatchObject({ id: 'road-defects', phase: 'done' });
    expect(await call('addons:remove', { id: 'road-defects' })).toEqual({ ok: true });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
    expect(await call('addons:remove', { id: 'road-defects' })).toMatchObject({ ok: false });
  });

  it('compares a chosen file with the catalogue when it lists that version', async () => {
    const listed = road();
    serve([listed]);
    const other = road('1.0.0', { name: 'Road defects (rebuilt)' });
    const path = join(base, other.fileName);
    await writeFile(path, other.bytes);
    const { call, picked } = setup();
    picked.path = path;
    await call('addons:choose', {});
    expect(await call('addons:installFile', { path })).toMatchObject({
      ok: false,
      error: /the add-on catalogue lists \(SHA-256\)/,
    });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
  });
});

describe('helpers', () => {
  it('reads the id from an archive name', () => {
    expect(archiveNameId('road-defects-1.2.0.aioaddon')).toBe('road-defects');
    expect(archiveNameId('road-defects-1.2.0 (1).aioaddon')).toBe('road-defects');
    expect(archiveNameId('road.zip')).toBeNull();
  });

  it('throttles progress but keeps phase changes and the end', () => {
    const out: AddonProgress[] = [];
    let t = 0;
    const p = progressThrottle(
      'x',
      (e) => out.push(e),
      () => t,
    );
    p({ phase: 'download', bytesDone: 0, bytesTotal: 10 });
    t = 10;
    p({ phase: 'download', bytesDone: 5, bytesTotal: 10 });
    t = 20;
    p({ phase: 'download', bytesDone: 10, bytesTotal: 10 });
    p({ phase: 'unpack', bytesDone: 0, bytesTotal: 10 });
    expect(out.map((e) => `${e.phase}:${String(e.bytesDone)}`)).toEqual([
      'download:0',
      'download:10',
      'unpack:0',
    ]);
  });
});
