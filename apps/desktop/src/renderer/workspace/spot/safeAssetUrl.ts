import type { AssetRef } from '@aio/schema';
import { assetUrl } from '@aio/workspace';

/** `assetUrl` that returns undefined, instead of throwing, for a path that leaves the project. */
export function safeAssetUrl(projectId: string, ref: AssetRef): string | undefined {
  try {
    return assetUrl(projectId, ref);
  } catch {
    return undefined;
  }
}
