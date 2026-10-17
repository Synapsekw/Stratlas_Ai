import type { PanoScanSkipped, PanoSkipReason } from '@aio/schema';
import { t } from '@aio/ui';

/** Why a file is not a panorama, in words (the preview's list and Add data's notes share it). */
export function panoSkipText(reason: PanoSkipReason): string {
  // the reason is `dual-fisheye`, its sentence lives under a camel-case key
  return reason === 'dual-fisheye' ? t('pano.skip.dualFisheye') : t(`pano.skip.${reason}`);
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The Insta360 stills skipped as two unstitched fisheye circles, named, with what to do: or null
 * when there are none.
 */
export function fisheyeSkipNote(skipped: readonly PanoScanSkipped[]): string | null {
  const names = skipped.filter((s) => s.reason === 'dual-fisheye').map((s) => fileName(s.file));
  return names.length > 0 ? `${names.join(', ')}: ${panoSkipText('dual-fisheye')}` : null;
}
