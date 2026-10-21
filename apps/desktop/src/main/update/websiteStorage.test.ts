import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createWebsiteStorage } from './websiteStorage';
import { fakePackArchive } from '../jobs/packArchive.fakes';
import { findPack } from '../jobs/pack';
import { managedKitDirectory, readManagedSelection } from './managedKits';
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
describe('website artifact storage', () => {
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
