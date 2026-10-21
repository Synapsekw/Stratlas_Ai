import {
  type WebsiteArtifact,
  type WebsiteUpdateCheck,
  PipelinePackManifest,
  packRangeRefusal,
} from '@aio/schema';
import { mkdir, stat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { readJson, writeJsonAtomic } from '../fsutil';
import { installPackArchive } from '../jobs/packInstall';
import { downloadVerified, sha256Of } from './download';
import type { WebsiteClient } from './websiteClient';
import {
  managedKitDataRoot,
  managedKitDirectory,
  readManagedSelection,
  selectManagedKit,
  managedKitSnapshot,
  restoreManagedKitSnapshot,
  type ManagedKit,
} from './managedKits';
import type { WebsiteStage } from './websiteUpdater';
const kitRef = (p: NonNullable<WebsiteUpdateCheck['pipeline']>): ManagedKit => ({
  version: p.version,
  sha256: p.sha256,
  appRange: p.appRange,
});
/** Persistent stage contains only validated metadata. Every local path is derived from a digest. */
export function createWebsiteStorage(d: {
  dir: string;
  dataRoot: () => string;
  currentVersion: string;
  client: Pick<WebsiteClient, 'grant' | 'binary'>;
  verifyInstaller: (path: string, version: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  let verifiedRoot: string | null = null;
  let writes: Promise<void> = Promise.resolve();
  const path = (a: WebsiteArtifact) =>
    join(d.dir, 'artifacts', a.sha256 + (a.filename.endsWith('.exe') ? '.exe' : '.tar.gz'));
  async function verifyBytes(a: WebsiteArtifact) {
    const st = await stat(path(a));
    if (!st.isFile() || st.size !== a.bytes || (await sha256Of(path(a))) !== a.sha256)
      throw new Error('The staged artifact failed verification.');
  }
  async function verifyKit(root: string, ref: ManagedKit, target: string) {
    const dir = managedKitDirectory(root, ref);
    const realRoot = await realpath(dir);
    const m = PipelinePackManifest.parse(await readJson(join(dir, 'manifest.json')));
    if (
      m.version !== ref.version ||
      m.platform !== 'win32-x64' ||
      m.appRange !== ref.appRange ||
      packRangeRefusal(m.appRange, target) ||
      !m.files[m.python.executable]
    )
      throw new Error('The processing kit manifest does not match its published metadata.');
    for (const [name, want] of Object.entries(m.files)) {
      if (
        name.includes('\\') ||
        name.startsWith('/') ||
        name.split('/').some((p) => !p || p === '..' || p === '.') ||
        isAbsolute(name)
      )
        throw new Error('Unsafe kit file path.');
      const file = join(dir, ...name.split('/'));
      const rel = relative(realRoot, await realpath(file));
      if (rel.startsWith('..') || isAbsolute(rel))
        throw new Error('The processing kit file escapes its directory.');
      const st = await stat(file);
      if (!st.isFile() || st.size !== want.size || (await sha256Of(file)) !== want.sha256)
        throw new Error('A processing kit file failed verification.');
    }
  }
  async function verify(check: WebsiteUpdateCheck, signal: AbortSignal) {
    const root = d.dataRoot();
    for (const artifact of [check.app, check.pipeline]) {
      signal.throwIfAborted();
      if (artifact) await verifyBytes(artifact);
    }
    if (check.app) {
      const result = await d.verifyInstaller(path(check.app), check.app.version);
      if (!result.ok) throw new Error('The installer publisher or version could not be verified.');
    }
    if (check.pipeline) {
      const ref = kitRef(check.pipeline);
      const dir = managedKitDirectory(root, ref);
      if (!(await stat(dir).catch(() => null))) {
        const result = await installPackArchive(path(check.pipeline), {
          dataRoot: managedKitDataRoot(root, ref),
          app: { version: check.targetAppVersion },
          platform: 'win32-x64',
          signal,
        });
        if (!result.ok || result.version !== ref.version)
          throw new Error('The processing kit archive could not be verified.');
      }
      signal.throwIfAborted();
      await verifyKit(root, ref, check.targetAppVersion);
    }
    signal.throwIfAborted();
    if (root !== d.dataRoot()) throw new Error('The data folder changed during verification.');
    verifiedRoot = root;
  }
  return {
    path,
    store: {
      read: () => readJson(join(d.dir, 'stage-v1.json')).catch(() => null),
      write: (stage: WebsiteStage | null) => {
        const write = async () => {
          await mkdir(d.dir, { recursive: true });
          await writeJsonAtomic(join(d.dir, 'stage-v1.json'), stage);
        };
        const next = writes.then(write, write);
        writes = next.catch(() => undefined);
        return next;
      },
    },
    async download(
      artifact: WebsiteArtifact,
      signal: AbortSignal,
      progress: (received: number, total: number) => void,
    ) {
      try {
        await verifyBytes(artifact);
        progress(artifact.bytes, artifact.bytes);
        return;
      } catch {
        /* A partial or absent artifact resumes below. */
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        try {
          const url = await d.client.grant(artifact, signal);
          await downloadVerified({
            url,
            sha256: artifact.sha256,
            size: artifact.bytes,
            dest: path(artifact),
            fetch: d.client.binary,
            signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60 * 1000)]),
            onProgress: progress,
          });
          signal.throwIfAborted();
          return;
        } catch {
          signal.throwIfAborted();
          if (attempt === 1) throw new Error('The artifact download failed after two attempts.');
        }
      }
    },
    verify,
    async activate(check: WebsiteUpdateCheck) {
      const root = d.dataRoot();
      if (verifiedRoot !== root) throw new Error('The data folder changed after verification.');
      const snapshot = await managedKitSnapshot(root);
      if (check.pipeline)
        await selectManagedKit(root, check.targetAppVersion, kitRef(check.pipeline), !check.app);
      return () => restoreManagedKitSnapshot(root, snapshot);
    },
    async recover(stage: WebsiteStage) {
      if (stage.check.targetAppVersion !== d.currentVersion) return false;
      await verify(stage.check, new AbortController().signal);
      if (stage.check.pipeline) {
        const ref = kitRef(stage.check.pipeline);
        const current = await readManagedSelection(d.dataRoot(), d.currentVersion);
        if (stage.sourceAppVersion === d.currentVersion && current?.sha256 !== ref.sha256)
          return false;
        if (current?.sha256 !== ref.sha256)
          await selectManagedKit(d.dataRoot(), d.currentVersion, ref, !stage.check.app);
      }
      return true;
    },
  };
}
