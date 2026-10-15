import type { EngineerRuntimeHost } from '@aio/ai/main';
import type { AiPolicy, ProjectManifest } from '@aio/schema';
import { join } from 'node:path';
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

/** The builder library loads on first use, as in builder.ts and modelBuilder.ts. */
const lib = () => import('@aio/project/builder');

export async function evidencePolicy(projectRoot: string): Promise<EvidencePolicy> {
  const ai = await readAiPolicy(projectRoot);
  try {
    const m = await (await lib()).readManifestFile(projectRoot);
    return { ai, photos: m.aiCloudPhotos === true, scans: m.aiCloudScans === true };
  } catch {
    return { ai, photos: false, scans: false };
  }
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
 * shares no photos or scans and keeps no cache), the cache under the run's `engineering/<run>/ai`,
 * and the downscale (`resize`, Electron `nativeImage` in the app).
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
    cacheDir: (projectId, run) => {
      if (o.projects.package(projectId)) return undefined;
      const root = o.projects.root(projectId);
      return root === undefined ? undefined : join(root, 'engineering', run, 'ai');
    },
    ...(o.resize ? { resize: o.resize } : {}),
  };
}
