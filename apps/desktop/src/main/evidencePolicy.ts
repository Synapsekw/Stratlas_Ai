import type { EngineerRuntimeHost } from '@aio/ai/main';
import {
  ENGINEER_MEASUREMENT_ALGORITHM,
  type AiPolicy,
  type ProjectManifest,
  type EngineerSetup,
} from '@aio/schema';
import { requireInside } from '@aio/project/fs';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readAiPolicy } from './aiProjects';
import type { ModelProjects } from './modelBuilder';
import type { Handle } from './notYet';

/**
 * What the engineering model's AI step may send to a cloud model for a folder project, read from
 * the manifest on disk at the moment of sending (never from what the renderer says): the project
 * AI policy, and the separate consents for ordinary photos (`aiCloudPhotos`) and scan renders
 * (`aiCloudScans`). A flag is on only when the manifest is valid and the flag is exactly `true`;
 * drawing consent (`aiCloudDrawings`) does not count for either.
 */
export interface EvidencePolicy {
  ai: AiPolicy;
  photos: boolean;
  scans: boolean;
}

/** Local cache identity, including exactly the offsets/transforms used by the scene. */
export async function engineeringSourceStamp(root: string, setup: EngineerSetup): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(root, 'manifest.json'), 'utf8'),
  ) as ProjectManifest;
  const ids = new Set([...setup.sources.clouds, ...setup.sources.meshes].map((s) => s.layer));
  const layers = manifest.layers.filter((l) => ids.has(l.id));
  if (layers.length !== ids.size)
    throw new Error(
      'A selected source layer is no longer in this project. Choose the sources again.',
    );
  const files = [
    ...setup.sources.photos,
    ...(setup.sources.drawings ?? []),
    ...(setup.sources.cameraPoses ? [setup.sources.cameraPoses] : []),
  ].map((s) => s.path);
  for (const layer of layers) {
    if ('src' in layer && 'path' in layer.src) files.push(layer.src.path);
    if (layer.kind === 'pointcloud' && layer.format === 'png-packed' && 'path' in layer.src) {
      const index = JSON.parse(
        await readFile(await requireInside(root, layer.src.path), 'utf8'),
      ) as {
        chunks?: { file?: unknown }[];
      };
      for (const chunk of index.chunks ?? []) {
        if (typeof chunk.file !== 'string') throw new Error('Invalid point cloud chunk index.');
        files.push(chunk.file);
      }
    }
  }
  const identity = await Promise.all(
    [...new Set(files)].sort().map(async (path) => {
      const s = await stat(await requireInside(root, path));
      return [path, s.size, s.mtimeMs, s.ctimeMs];
    }),
  );
  const frames = layers.map((l) => ({
    id: l.id,
    src: 'src' in l ? l.src : null,
    transform: 'transform' in l ? l.transform : null,
    offset: 'heightOffsetM' in l ? l.heightOffsetM : 0,
  }));
  return createHash('sha256')
    .update(
      JSON.stringify({
        algorithm: ENGINEER_MEASUREMENT_ALGORITHM,
        origin: manifest.origin,
        crs: manifest.crs,
        frames,
        identity,
      }),
    )
    .digest('hex');
}

/** The builder library loads on first use, as in builder.ts and modelBuilder.ts. */
const lib = () => import('@aio/project/builder');

/** Shown when the manifest cannot be read: nothing goes to a cloud model then. */
export const MANIFEST_UNREADABLE =
  "The project's manifest could not be read, so its AI sharing settings are unknown and nothing is sent to a cloud model. Check the project folder, then try again.";

/**
 * The policy from the manifest on disk, or `error` when the manifest cannot be read or is not
 * valid (never "allow" by default on this path).
 */
export async function evidencePolicy(
  projectRoot: string,
): Promise<EvidencePolicy | { error: string }> {
  let m: ProjectManifest;
  try {
    m = await (await lib()).readManifestFile(projectRoot);
  } catch {
    return { error: MANIFEST_UNREADABLE };
  }
  // the package-style `aiPolicy` key is read from the raw file (the schema strips it)
  const ai = await readAiPolicy(projectRoot);
  return { ai, photos: m.aiCloudPhotos === true, scans: m.aiCloudScans === true };
}

/** The part of Electron's `NativeImage` the downscale uses. */
export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(o: {
    width: number;
    height: number;
    quality?: 'good' | 'better' | 'best';
  }): NativeImageLike;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

/**
 * Downscale an image so its long side is at most `maxPx`, re-encoded explicitly: a PNG stays PNG
 * (transparency), anything else (JPEG, WebP, which Electron cannot write) becomes JPEG at 90.
 */
export function resizeDataUrl(
  dataUrl: string,
  maxPx: number,
  fromDataUrl: (url: string) => NativeImageLike,
): Promise<string> {
  const img = fromDataUrl(dataUrl);
  if (img.isEmpty()) return Promise.reject(new Error('The image could not be decoded.'));
  const { width, height } = img.getSize();
  const s = Math.min(1, maxPx / Math.max(width, height, 1));
  const small = img.resize({
    width: Math.max(1, Math.floor(width * s)),
    height: Math.max(1, Math.floor(height * s)),
    quality: 'good',
  });
  return Promise.resolve(
    dataUrl.startsWith('data:image/png;')
      ? `data:image/png;base64,${small.toPNG().toString('base64')}`
      : `data:image/jpeg;base64,${small.toJPEG(90).toString('base64')}`,
  );
}

const READ_ONLY = {
  ok: false as const,
  error: 'This project is a read-only package. Its AI sharing settings cannot be changed.',
  code: 'read-only' as const,
};

/**
 * `ai:setCloudEvidence`: "Allow for this project" in the evidence send preview. Sets or removes
 * `aiCloudPhotos` and `aiCloudScans` (each on its own; false removes the flag, so absent means
 * off) in one manifest save among the project's other saves, as `ai:setCloudDrawings` does.
 * Refused for packages.
 */
export function registerEvidencePolicyIpc({
  handle,
  projects,
}: {
  handle: Handle;
  projects: Pick<ModelProjects, 'root' | 'package'>;
}): void {
  handle('ai:setCloudEvidence', async ({ projectId, photos, scans }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) {
      return { ok: false, error: `Project "${projectId}" is not open.` };
    }
    await (
      await lib()
    ).updateManifestFile(root, (m) => {
      const next: ProjectManifest = { ...m };
      if (photos === true) next.aiCloudPhotos = true;
      else if (photos === false) delete next.aiCloudPhotos;
      if (scans === true) next.aiCloudScans = true;
      else if (scans === false) delete next.aiCloudScans;
      return { manifest: next };
    });
    return { ok: true };
  });
}

/**
 * The engineer step's host in main: consents re-read from disk for every request (a package
 * shares no photos or scans and has no runs), the run folder `engineering/<run>` (its `run.json`
 * must be there; cache and spend under its `ai/`), and the downscale (`resize`, Electron
 * `nativeImage` through `resizeDataUrl` in the app).
 */
export function engineerRuntimeHost(o: {
  projects: Pick<ModelProjects, 'root' | 'package'>;
  /** The package's AI policy (its header); folder projects read their manifest. */
  packagePolicy: (projectId: string) => AiPolicy;
  resize?: (dataUrl: string, maxPx: number) => Promise<string>;
}): EngineerRuntimeHost {
  return {
    policy: async (projectId) => {
      if (o.projects.package(projectId)) {
        return { ai: o.packagePolicy(projectId), photos: false, scans: false };
      }
      const root = o.projects.root(projectId);
      return root === undefined ? null : evidencePolicy(root);
    },
    runDir: (projectId, run) => {
      if (o.projects.package(projectId)) return undefined;
      const root = o.projects.root(projectId);
      return root === undefined ? undefined : join(root, 'engineering', run);
    },
    sourceStamp: async (projectId, setup) => {
      const root = o.projects.root(projectId);
      if (!root) throw new Error('The project is not open.');
      return engineeringSourceStamp(root, setup);
    },
    ...(o.resize ? { resize: o.resize } : {}),
  };
}
