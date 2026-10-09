import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOnlineUpdater, type OnlineDeps, type Progress } from './online';

/** Asymmetric matcher typed as unknown, so object literals stay type-safe. */
const matching = (re: RegExp): unknown => expect.stringMatching(re);

const installer = Buffer.from('MZ pretend installer '.repeat(500));
const sha = createHash('sha256').update(installer).digest('hex');

let server: Server;
let base: string;
let dir: string;
let requests: string[];
let feed: unknown;

beforeEach(async () => {
  requests = [];
  feed = {
    schema: 'aio.update-feed/1',
    version: '0.8.0',
    notes: '# Quadrion AI 0.8.0\n\n## New\n\n- Faster maps\n',
    files: {
      'win-x64': { url: 'QuadrionAI-0.8.0-win-x64-setup.exe', sha256: sha, size: installer.length },
      'mac-arm64': { url: 'QuadrionAI-0.8.0-mac-arm64.dmg', sha256: sha, size: installer.length },
    },
  };
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/feed/stratlas-update.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(feed));
    } else if (req.url?.startsWith('/feed/QuadrionAI-0.8.0')) {
      res.end(installer);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  dir = await mkdtemp(join(tmpdir(), 'online-'));
});

afterEach(async () => {
  await new Promise<void>((ok) => {
    server.close(() => {
      ok();
    });
  });
  await rm(dir, { recursive: true, force: true });
});

const on = { offlineOnly: false, updateCheck: true, updateUrl: '' };

function make(settings: Partial<typeof on> = {}, over: Partial<OnlineDeps> = {}) {
  const installed: string[] = [];
  const progress: Progress[] = [];
  let fetches = 0;
  const updater = createOnlineUpdater({
    settings: () => ({ ...on, updateUrl: `${base}/feed/`, ...settings }),
    currentVersion: '0.7.0',
    platform: 'win32',
    arch: 'x64',
    fetch: (url, init) => {
      fetches++;
      return fetch(url, init);
    },
    downloadsDir: dir,
    verify: () => Promise.resolve({ ok: true }),
    install: (path, version) => {
      installed.push(`${version} ${path}`);
      return Promise.resolve({ ok: true });
    },
    onProgress: (p) => progress.push(p),
    ...over,
  });
  return { updater, installed, progress, fetches: () => fetches };
}

describe('online update', () => {
  // updates.spec.ts:35, flaky on Windows CI: Check now came right after the switch and the
  // address were saved, and read the settings before they were written ("switched off").
  it('reads the settings once the changes asked for before the check are written', async () => {
    let current: typeof on = { ...on, updateCheck: false, updateUrl: '' };
    let written = (): void => undefined;
    const settled = new Promise<void>((done) => {
      written = () => {
        current = { ...on, updateUrl: `${base}/feed/` };
        done();
      };
    });
    const { updater, fetches } = make({}, { settings: () => current, settled: () => settled });
    const checking = updater.check();
    written();
    const r = await checking;
    expect(r.ok).toBe(true);
    expect(fetches()).toBe(1);
  });

  it('makes no request when offline-only, switched off or without an address', async () => {
    for (const s of [{ offlineOnly: true }, { updateCheck: false }, { updateUrl: '' }]) {
      const { updater, fetches } = make(s);
      expect((await updater.check()).ok).toBe(false);
      expect((await updater.downloadAndInstall()).ok).toBe(false);
      expect(fetches()).toBe(0);
    }
    expect(await make({ offlineOnly: true }).updater.check()).toMatchObject({
      error: matching(/offline-only/),
    });
    expect(requests).toEqual([]);
  });

  it('reads the feed, offers the newer version with notes and size, and does not download', async () => {
    const { updater, installed } = make();
    expect(await updater.check()).toEqual({
      ok: true,
      available: true,
      version: '0.8.0',
      notes: '# Quadrion AI 0.8.0\n\n## New\n\n- Faster maps\n',
      size: installer.length,
    });
    expect(requests).toEqual(['/feed/stratlas-update.json']);
    expect(installed).toEqual([]);
  });

  it('says when this is the newest version', async () => {
    feed = { ...(feed as object), version: '0.7.0' };
    expect(await make().updater.check()).toEqual({ ok: true, available: false, version: '0.7.0' });
  });

  it('downloads, checks the hash, verifies and installs', async () => {
    const { updater, installed, progress } = make();
    await updater.check();
    expect(await updater.downloadAndInstall()).toEqual({ ok: true });
    const path = join(dir, 'QuadrionAI-0.8.0-win-x64-setup.exe');
    expect(installed).toEqual([`0.8.0 ${path}`]);
    expect(await readFile(path)).toEqual(installer);
    expect(progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['download', 'verify', 'keep']),
    );
    expect(progress.at(-1)?.phase).toBe('keep');
  });

  it('stops when the verify step refuses the file', async () => {
    const { updater, installed } = make(
      {},
      { verify: () => Promise.resolve({ ok: false, error: 'This installer is not signed.' }) },
    );
    await updater.check();
    expect(await updater.downloadAndInstall()).toEqual({
      ok: false,
      error: 'This installer is not signed.',
    });
    expect(installed).toEqual([]);
  });

  it('refuses a download whose hash differs from the feed', async () => {
    const files = (feed as { files: Record<string, { sha256: string }> }).files;
    const win = files['win-x64'];
    if (win) win.sha256 = '0'.repeat(64);
    const { updater, installed } = make();
    await updater.check();
    expect(await updater.downloadAndInstall()).toMatchObject({
      ok: false,
      error: matching(/SHA-256/),
    });
    expect(installed).toEqual([]);
  });

  it('reports a feed without an installer for this computer', async () => {
    const r = await make({}, { platform: 'darwin', arch: 'x64' }).updater.check();
    expect(r).toMatchObject({
      ok: false,
      error: matching(/no installer for this computer \(mac-x64\)/),
    });
  });

  it('reports a missing or invalid feed', async () => {
    expect(await make({ updateUrl: `${base}/nothing/` }).updater.check()).toMatchObject({
      ok: false,
      error: matching(/HTTP 404/),
    });
    feed = { schema: 'something-else' };
    expect(await make().updater.check()).toMatchObject({ ok: false, error: matching(/not valid/) });
  });

  it('needs a check before downloading', async () => {
    expect(await make().updater.downloadAndInstall()).toEqual({
      ok: false,
      error: 'Check for updates first.',
    });
  });
});
