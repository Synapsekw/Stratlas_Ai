/**
 * The coverage picture as a PNG data URL, for the map's image source (MapLibre takes a URL). On
 * its own so a test without a canvas can stand in for it.
 */
import type { CoverageImage } from './coverageImage';

export function imageUrl(img: CoverageImage): string {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  if (!g) return '';
  g.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c.toDataURL('image/png');
}
