/*
 * New `model.evidence` jobs need component processing. Saved legacy measurements retain their
 * original minimum. `jobs:start` asks here before launching or resuming either kind.
 */
import {
  COMPONENT_EVIDENCE_FEATURE,
  COMPONENT_EVIDENCE_MIN_PACK,
  MODEL_EVIDENCE_FEATURE,
  MODEL_EVIDENCE_MIN_PACK,
  type JobRecord,
} from '@aio/schema';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions } from './jobs/pack';

/** What the processing tools must be for `model.evidence` (Settings, Processing tools lists it). */
export const EVIDENCE_PACK_FEATURE = {
  label: MODEL_EVIDENCE_FEATURE,
  minVersion: MODEL_EVIDENCE_MIN_PACK,
};

export const COMPONENT_EVIDENCE_PACK_FEATURE = {
  label: COMPONENT_EVIDENCE_FEATURE,
  minVersion: COMPONENT_EVIDENCE_MIN_PACK,
};

/**
 * Why `jobs:start` refuses `model.evidence` on the installed pack, or null. A development pack
 * (`dev`) and no pack (the job runner says so itself) pass.
 */
export function evidencePackRefusal(
  pipeline: string,
  packVersion: string | null,
  saved?: Pick<JobRecord, 'params' | 'packVersion'>,
): string | null {
  if (pipeline !== 'model.evidence' || packVersion === null || packVersion === 'dev') return null;
  // The runner persists the actual pack before launch. In particular, a drawing-free job run
  // with component processing must never resume on an older pack that lacks those algorithms.
  const components =
    !saved ||
    saved.packVersion === 'dev' ||
    (saved.packVersion !== undefined &&
      compareVersions(saved.packVersion, COMPONENT_EVIDENCE_MIN_PACK) >= 0) ||
    'drawings' in saved.params ||
    'cameraPoses' in saved.params;
  const { label, minVersion } = components
    ? COMPONENT_EVIDENCE_PACK_FEATURE
    : EVIDENCE_PACK_FEATURE;
  if (compareVersions(packVersion, minVersion) >= 0) return null;
  return `${label} needs processing tools ${minVersion} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}

/** Older development builds labelled component jobs with a legacy pack number. Their Python
 * checkpoint records the actual algorithm, including drawing-free processing. */
export async function evidenceJobPackRefusal(
  pipeline: string,
  packVersion: string | null,
  saved?: Pick<JobRecord, 'id' | 'project' | 'params' | 'packVersion'>,
): Promise<string | null> {
  const refusal = evidencePackRefusal(pipeline, packVersion, saved);
  if (
    refusal ||
    pipeline !== 'model.evidence' ||
    !saved ||
    packVersion === null ||
    packVersion === 'dev' ||
    compareVersions(packVersion, COMPONENT_EVIDENCE_MIN_PACK) >= 0
  )
    return refusal;
  try {
    const checkpoint: unknown = JSON.parse(
      await readFile(join(saved.project, 'jobs', saved.id, 'job.json'), 'utf8'),
    );
    if (
      checkpoint &&
      typeof checkpoint === 'object' &&
      'pipelineVersion' in checkpoint &&
      typeof checkpoint.pipelineVersion === 'string' &&
      checkpoint.pipelineVersion.startsWith('components/')
    )
      return evidencePackRefusal(pipeline, packVersion);
    return null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    return 'The saved measurement checkpoint could not be checked. Restore its job.json or start a new modelling run before resuming.';
  }
}
