import type { AntennasFile, DateShift, ProjectManifest } from '@aio/schema';
import { captureShift, dateShiftOf } from '@aio/workspace';

/**
 * How far the inventory is drawn from where it is stored: the line-up shift of the survey date
 * its cloud belongs to (the run's `captureId`, else the cloud layer's date in an older file), or
 * null when that date is not lined up or there is no open manifest. Kept apart from the scene, so
 * Coverage reads it without loading the 3D layer and its pointer rules.
 */
export function antennaShift(
  file: AntennasFile | null,
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'> | null,
): DateShift | null {
  if (!file || !manifest) return null;
  const { captureId, cloudLayer } = file.run;
  return captureId !== undefined
    ? captureShift(manifest, captureId)
    : dateShiftOf(manifest, cloudLayer);
}
