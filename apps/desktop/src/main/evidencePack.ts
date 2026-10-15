/*
 * The `model.evidence` job needs the processing tools of pipeline pack 0.11.0 or later. `jobs:start`
 * asks here first, so an older pack gets the update message, not a failed job (as for
 * `pano.stitch` in `panos.ts` and `walk.process` in `walks.ts`).
 */
import { MODEL_EVIDENCE_FEATURE, MODEL_EVIDENCE_MIN_PACK } from '@aio/schema';
import { compareVersions } from './jobs/pack';

/** What the processing tools must be for `model.evidence` (Settings, Processing tools lists it). */
export const EVIDENCE_PACK_FEATURE = {
  label: MODEL_EVIDENCE_FEATURE,
  minVersion: MODEL_EVIDENCE_MIN_PACK,
};

/**
 * Why `jobs:start` refuses `model.evidence` on the installed pack, or null. A development pack
 * (`dev`) and no pack (the job runner says so itself) pass.
 */
export function evidencePackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'model.evidence' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, MODEL_EVIDENCE_MIN_PACK) >= 0) return null;
  return `${MODEL_EVIDENCE_FEATURE} needs processing tools ${MODEL_EVIDENCE_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}
