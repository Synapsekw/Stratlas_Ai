import type { AiPolicy } from '@aio/schema';
import { readAiPolicy } from './aiProjects';

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
