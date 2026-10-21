import { describe, it, expect, vi } from 'vitest';
import { createWebsiteUpdater, type WebsiteStage, type WebsiteUpdaterDeps } from './websiteUpdater';
import { createUpdateWorkGate } from './workGate';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const artifact = {
  releaseId: '00000000-0000-4000-8000-000000000001',
  artifactId: '00000000-0000-4000-8000-000000000002',
  version: '0.25.0',
  platform: 'win-x64' as const,
  filename: 'Setup.exe',
  bytes: 3,
  sha256: 'a'.repeat(64),
  notes: 'App notes',
};
const feed = {
  schema: 'quadrion.updates/1' as const,
  targetAppVersion: '0.25.0',
  app: artifact,
  pipeline: { ...artifact, version: '0.20.0', filename: 'kit.tar.gz', appRange: '>=0.25.0 <2.0.0' },
};
function fixture() {
  let stage: WebsiteStage | null = null;
  let offline = false;
  let downloads = 0;
  const gate = createUpdateWorkGate();
  const undo = vi.fn(() => Promise.resolve());
  const install = vi.fn(() => Promise.resolve({ ok: true }));
  const d: WebsiteUpdaterDeps = {
    currentVersion: '0.24.0',
    unsupportedReason: null,
    policy: () => ({ enabled: true, offline }),
    pipelineVersion: () => Promise.resolve(null),
    client: {
      restore: () => Promise.resolve('member@example.com'),
      signIn: () => Promise.resolve('member@example.com'),
      signOut: () => undefined,
      forgetAccess: () => undefined,
      check: () => Promise.resolve(feed),
    },
    store: {
      read: () => Promise.resolve(stage),
      write: (s) => {
        stage = s;
        return Promise.resolve();
      },
    },
    download: () => {
      downloads++;
      return Promise.resolve();
    },
    verify: () => Promise.resolve(),
    activate: () => Promise.resolve(undo),
    recover: () => Promise.resolve(false),
    recoveryAvailable: () => Promise.resolve(false),
    rollbackKit: () => Promise.resolve(),
    install,
    relaunch: () => undefined,
    gate,
    emit: () => undefined,
    schedule: () => () => undefined,
  };
  return {
    d,
    gate,
    undo,
    install,
    getStage: () => stage,
    setStage: (s: WebsiteStage) => {
      stage = s;
    },
    offline: () => {
      offline = true;
    },
    downloads: () => downloads,
  };
}
describe('website update transaction', () => {
  it.each(['deleted', 'corrupt'])(
    'allows a fresh download after a %s ready artifact fails restart verification',
    async (damage) => {
      const dir = await mkdtemp(join(tmpdir(), 'website-retry-'));
      const file = join(dir, 'artifact');
      try {
        const f = fixture();
        let downloads = 0;
        f.d.download = async () => {
          downloads++;
          await writeFile(file, 'verified bytes');
        };
        f.d.verify = async () => {
          if ((await readFile(file, 'utf8')) !== 'verified bytes')
            throw new Error('Integrity failure');
        };
        const u = createWebsiteUpdater(f.d);
        await u.startup();
        expect(u.status().phase).toBe('ready');
        if (damage === 'deleted') await rm(file);
        else await writeFile(file, 'tampered');
        expect((await u.restart()).ok).toBe(false);
        expect(u.status().phase).toBe('error');
        expect(u.status().restartAvailable).toBe(false);
        expect(u.status().app?.verified).toBe(false);
        expect(f.getStage()?.phase).toBe('download');
        expect(f.install).not.toHaveBeenCalled();
        expect(await u.check()).toEqual({ ok: true });
        expect(downloads).toBe(4);
        expect(u.status().phase).toBe('ready');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('stages both components without installation then applies under the work gate', async () => {
    const f = fixture();
    const u = createWebsiteUpdater(f.d);
    await u.startup();
    expect(u.status().phase).toBe('ready');
    expect(f.downloads()).toBe(2);
    expect(f.install).not.toHaveBeenCalled();
    const release = f.gate.enter();
    expect((await u.restart()).ok).toBe(false);
    release();
    expect((await u.restart()).ok).toBe(true);
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(() => f.gate.enter()).toThrow();
  });
  it('keeps selection and releases work after installer failure', async () => {
    const f = fixture();
    f.install.mockResolvedValue({ ok: false });
    const u = createWebsiteUpdater(f.d);
    await u.startup();
    expect((await u.restart()).ok).toBe(false);
    expect(f.undo).toHaveBeenCalledOnce();
    expect(() => f.gate.enter()).not.toThrow();
    expect(f.getStage()?.phase).toBe('ready');
  });
  it('applies an already-ready stage offline with no auth or downloads', async () => {
    const f = fixture();
    f.setStage({
      schema: 'quadrion.website-stage/1',
      sourceAppVersion: '0.24.0',
      phase: 'ready',
      check: feed,
    });
    f.offline();
    f.d.client.restore = vi.fn(() => Promise.reject(new Error('network')));
    const u = createWebsiteUpdater(f.d);
    await u.startup();
    expect(u.status().restartAvailable).toBe(true);
    expect((await u.restart()).ok).toBe(true);
    expect(f.downloads()).toBe(0);
    expect(f.d.client.restore).not.toHaveBeenCalled();
  });
  it('aborts synchronous policy changes and ignores a stale check result', async () => {
    const f = fixture();
    let finish: (v: typeof feed) => void = () => undefined;
    f.d.client.check = () =>
      new Promise((r) => {
        finish = r;
      });
    const u = createWebsiteUpdater(f.d);
    const start = u.startup();
    await vi.waitFor(() => {
      expect(u.status().phase).toBe('checking');
    });
    f.offline();
    u.policyChanged();
    finish(feed);
    await start;
    expect(f.downloads()).toBe(0);
    expect(u.status().phase).toBe('paused');
    expect(f.getStage()).toBeNull();
  });
  it('never advertises a partly verified set as ready', async () => {
    const f = fixture();
    f.d.verify = () => Promise.reject(new Error('bad artifact'));
    const u = createWebsiteUpdater(f.d);
    await u.startup();
    expect(u.status().restartAvailable).toBe(false);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.getStage()?.phase).toBe('download');
  });
});

describe('website update recovery and account cancellation', () => {
  it('keeps the applying journal until the target renderer and kit confirm readiness', async () => {
    const f = fixture();
    f.d.currentVersion = '0.25.0';
    f.d.recover = () => Promise.resolve(true);
    f.setStage({
      schema: 'quadrion.website-stage/1',
      sourceAppVersion: '0.24.0',
      phase: 'applying',
      check: feed,
    });
    const u = createWebsiteUpdater(f.d);
    await u.startup();
    expect(f.getStage()?.phase).toBe('applying');
    await u.rendererReady();
    expect(f.getStage()).toBeNull();
    expect(f.install).not.toHaveBeenCalled();
  });
  it('keeps recovery evidence and does not confirm a corrupt target kit', async () => {
    const f = fixture();
    f.d.currentVersion = '0.25.0';
    f.d.recover = () => Promise.reject(new Error('corrupt kit'));
    f.setStage({
      schema: 'quadrion.website-stage/1',
      sourceAppVersion: '0.24.0',
      phase: 'applying',
      check: feed,
    });
    const u = createWebsiteUpdater(f.d);
    await expect(u.startup()).resolves.toBeUndefined();
    expect(u.status().phase).toBe('error');
    expect(f.getStage()?.phase).toBe('applying');
    await expect(u.rendererReady()).rejects.toThrow();
    expect(f.getStage()?.phase).toBe('applying');
  });
  it('does not restore signed-in state after sign-out cancels a delayed sign-in', async () => {
    const f = fixture();
    let complete: (email: string) => void = () => undefined;
    f.d.client.signIn = () =>
      new Promise((r) => {
        complete = r;
      });
    const u = createWebsiteUpdater(f.d);
    const signing = u.signIn('member@example.com', 'password');
    u.signOut();
    complete('member@example.com');
    expect((await signing).ok).toBe(false);
    expect(u.status().accountEmail).toBeNull();
    expect(f.downloads()).toBe(0);
  });
  it('never reports restored selection if rollback persistence fails', async () => {
    const f = fixture();
    f.install.mockResolvedValue({ ok: false });
    f.d.activate = () => Promise.resolve(() => Promise.reject(new Error('disk failed')));
    const u = createWebsiteUpdater(f.d);
    await u.startup();
    expect((await u.restart()).ok).toBe(false);
    expect(u.status().error).toContain('could not be restored');
    expect(u.status().restartAvailable).toBe(false);
    expect(f.getStage()?.phase).toBe('applying');
  });
});
