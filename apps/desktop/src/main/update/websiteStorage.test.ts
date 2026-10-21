import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PipelinePackManifest } from '@aio/schema';
import { writeFileSync } from 'node:fs';
import { createWebsiteStorage } from './websiteStorage';
import { fakePackArchive } from '../jobs/packArchive.fakes';
import { findPack } from '../jobs/pack';
import { managedKitDirectory, readManagedSelection, selectManagedKit } from './managedKits';
import { createWebsiteUpdater } from './websiteUpdater';
import { createUpdateWorkGate } from './workGate';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const meta = (bytes: Buffer) => ({
  releaseId: '00000000-0000-4000-8000-000000000001',
  artifactId: '00000000-0000-4000-8000-000000000002',
  version: '0.20.0',
  platform: 'win-x64' as const,
  filename: 'pipeline-pack.tar.gz',
  bytes: bytes.length,
  sha256: hash(bytes),
  notes: 'kit',
  appRange: '>=0.24.0 <2.0.0',
});

function retryFixture(root: string) {
  const bytes = fakePackArchive('0.20.0', { appRange: '>=0.24.0 <2.0.0' });
  const artifact = meta(bytes);
  const check = {
    schema: 'quadrion.updates/1' as const,
    targetAppVersion: '0.24.0',
    app: null,
    pipeline: artifact,
  };
  const ref = { version: artifact.version, sha256: artifact.sha256, appRange: artifact.appRange };
  let active = false;
  let repairHook: () => void = () => undefined;
  const gate = createUpdateWorkGate(() => active);
  const binary = vi.fn(() => Promise.resolve(new Response(new Uint8Array(bytes))));
  const storage = createWebsiteStorage({
    dir: join(root, 'stage'),
    dataRoot: () => root,
    currentVersion: '0.24.0',
    acquireRepair: () => {
      const release = gate.acquire();
      if (release) repairHook();
      return release;
    },
    verifyInstaller: () => Promise.resolve({ ok: true }),
    client: { grant: () => Promise.resolve('https://storage.example/url'), binary },
  });
  const updater = createWebsiteUpdater({
    currentVersion: '0.24.0',
    unsupportedReason: null,
    policy: () => ({ enabled: true, offline: false }),
    pipelineVersion: () => Promise.resolve(null),
    client: {
      restore: () => Promise.resolve('member@example.com'),
      signIn: () => Promise.resolve('member@example.com'),
      signOut: () => undefined,
      forgetAccess: () => undefined,
      check: () => Promise.resolve(check),
    },
    store: storage.store,
    download: (a, s, p) => storage.download(a, s, p),
    verify: storage.verify,
    activate: (c) => storage.activate(c),
    recover: (s) => storage.recover(s),
    recoveryAvailable: () => Promise.resolve(false),
    rollbackKit: () => Promise.resolve(),
    install: () => Promise.resolve({ ok: false }),
    relaunch: () => undefined,
    gate,
    emit: () => undefined,
    schedule: () => () => undefined,
  });
  return {
    storage,
    updater,
    check,
    ref,
    binary,
    gate,
    python: join(managedKitDirectory(root, ref), 'python', 'python.exe'),
    setActive: () => {
      active = true;
    },
    beforeRepair: (callback: () => void) => {
      repairHook = callback;
    },
  };
}
describe('website artifact storage', () => {
  it('rechecks all selections under the shared work gate immediately before replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'website-repair-race-'));
    try {
      const f = retryFixture(root);
      await f.updater.startup();
      await writeFile(f.python, 'tampered');
      f.beforeRepair(() => {
        expect(() => f.gate.enter()).toThrow(/restart/);
        writeFileSync(
          join(root, 'runtime', '.website-kits', 'selection-v1.json'),
          JSON.stringify({
            schema: 'quadrion.kit-selection/1',
            apps: { '0.25.0': { current: f.ref } },
          }),
        );
      });
      await expect(f.storage.verify(f.check, new AbortController().signal, true)).rejects.toThrow();
      expect(await readFile(f.python, 'utf8')).toBe('tampered');
      expect(await readManagedSelection(root, '0.25.0')).toEqual(f.ref);
      const release = f.gate.enter();
      release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('repairs an inactive extracted kit on check after real restart verification rejects its corrupt bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'website-repair-'));
    try {
      const f = retryFixture(root);
      await f.updater.startup();
      expect(f.updater.status().phase).toBe('ready');
      await writeFile(f.python, 'tampered');
      expect((await f.updater.restart()).ok).toBe(false);
      expect(f.updater.status().phase).toBe('error');
      expect(await readFile(f.python, 'utf8')).toBe('tampered');
      expect(await f.updater.check()).toEqual({ ok: true });
      expect(f.updater.status().phase).toBe('ready');
      expect(await readFile(f.python, 'utf8')).toBe('fake python of pack 0.20.0');
      expect(f.binary).toHaveBeenCalledTimes(1);
      expect(await readManagedSelection(root, '0.24.0')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['current', 'previous', 'active-work', 'invalid-selector'])(
    'does not replace corrupt bytes protected by %s during staging retry',
    async (protection) => {
      const root = await mkdtemp(join(tmpdir(), 'website-protect-'));
      try {
        const f = retryFixture(root);
        await f.updater.startup();
        await writeFile(f.python, 'tampered');
        if (protection === 'current' || protection === 'previous')
          await selectManagedKit(root, '0.25.0', f.ref);
        if (protection === 'previous')
          await selectManagedKit(root, '0.25.0', {
            ...f.ref,
            version: '0.21.0',
            sha256: 'b'.repeat(64),
          });
        if (protection === 'active-work') f.setActive();
        if (protection === 'invalid-selector')
          await writeFile(join(root, 'runtime', '.website-kits', 'selection-v1.json'), '{}');
        await expect(
          f.storage.verify(f.check, new AbortController().signal, true),
        ).rejects.toThrow();
        expect(await readFile(f.python, 'utf8')).toBe('tampered');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('reacquires a bounded grant and resumes partial bytes without bearer headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'website-storage-'));
    try {
      const bytes = Buffer.from('abcdef');
      const artifact = meta(bytes);
      let grants = 0;
      const calls: Record<string, string>[] = [];
      const storage = createWebsiteStorage({
        dir: root,
        dataRoot: () => root,
        currentVersion: '0.24.0',
        verifyInstaller: () => Promise.resolve({ ok: true }),
        client: {
          grant: () => Promise.resolve(`https://storage.example/signed/${String(++grants)}`),
          binary: (_url, init) => {
            calls.push(init?.headers ?? {});
            if (calls.length === 1)
              return Promise.resolve(
                new Response(
                  new ReadableStream({
                    start(c) {
                      c.enqueue(bytes.subarray(0, 2));
                    },
                    pull(c) {
                      c.error(new Error('connection lost'));
                    },
                  }),
                ),
              );
            return Promise.resolve(
              new Response(bytes.subarray(2), {
                status: 206,
                headers: { 'content-range': 'bytes 2-5/6' },
              }),
            );
          },
        },
      });
      await storage.download(artifact, new AbortController().signal, () => undefined);
      expect(grants).toBe(2);
      expect(calls).toEqual([{}, { Range: 'bytes=2-' }]);
      expect(await readFile(storage.path(artifact))).toEqual(bytes);
      const disk = await readFile(storage.path(artifact));
      expect(disk.toString()).not.toContain('signed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('verifies and stages an actual synthetic archive invisibly until activation; tamper blocks reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'website-storage-'));
    try {
      const bytes = fakePackArchive('0.20.0', { appRange: '>=0.24.0 <2.0.0' });
      const artifact = meta(bytes);
      const check = {
        schema: 'quadrion.updates/1' as const,
        targetAppVersion: '0.24.0',
        app: null,
        pipeline: artifact,
      };
      const storage = createWebsiteStorage({
        dir: join(root, 'stage'),
        dataRoot: () => root,
        currentVersion: '0.24.0',
        verifyInstaller: vi.fn(() => Promise.resolve({ ok: true })),
        client: {
          grant: () => Promise.resolve('https://storage.example/url'),
          binary: () => Promise.resolve(new Response(new Uint8Array(bytes))),
        },
      });
      await storage.download(artifact, new AbortController().signal, () => undefined);
      await storage.verify(check, new AbortController().signal);
      expect(
        (await findPack({ dataRoot: root, env: {}, app: { version: '0.24.0' } })).pack,
      ).toBeNull();
      const undo = await storage.activate(check);
      expect(
        (await findPack({ dataRoot: root, env: {}, app: { version: '0.24.0' } })).pack?.version,
      ).toBe('0.20.0');
      await undo();
      expect(await readManagedSelection(root, '0.24.0')).toBeNull();
      const dir = managedKitDirectory(root, {
        version: artifact.version,
        sha256: artifact.sha256,
        appRange: artifact.appRange,
      });
      await writeFile(join(dir, 'python', 'python.exe'), 'tampered');
      await expect(storage.verify(check, new AbortController().signal)).rejects.toThrow(
        /verification/,
      );
      const manifestPath = join(dir, 'manifest.json');
      const manifest = PipelinePackManifest.parse(
        JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
      );
      manifest.files['python/python.exe'] = { size: 8, sha256: hash(Buffer.from('tampered')) };
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(storage.verify(check, new AbortController().signal)).rejects.toThrow(/manifest/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects a data-root race between verification and selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'website-storage-'));
    try {
      let selected = root;
      const storage = createWebsiteStorage({
        dir: root,
        dataRoot: () => selected,
        currentVersion: '0.24.0',
        verifyInstaller: () => Promise.resolve({ ok: true }),
        client: { grant: () => Promise.resolve(''), binary: () => Promise.resolve(new Response()) },
      });
      const check = {
        schema: 'quadrion.updates/1' as const,
        targetAppVersion: '0.24.0',
        app: null,
        pipeline: null,
      };
      await storage.verify(check, new AbortController().signal);
      selected = join(root, 'new');
      await mkdir(selected);
      await expect(storage.activate(check)).rejects.toThrow(/data folder/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
