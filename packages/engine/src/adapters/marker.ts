import { CanvasTexture, SRGBColorSpace, type Texture } from 'three';
import { PALETTE } from '../palette';

/** Mission glyphs (20 x 20 viewBox, as in the sidebar icon set) for the scene markers. */
export const MARKER_GLYPH = {
  pano: ['M2.5 5.5c5 1.3 10 1.3 15 0v9c-5-1.3-10-1.3-15 0z', 'M10 6.5v7.2'],
  photo: [
    'M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 4 3.5z',
    'M2.5 13.5l4-4 3.5 3.5 2.5-2.5 5 5',
    'M14.3 7.5a1.3 1.3 0 1 1-2.6 0a1.3 1.3 0 1 1 2.6 0',
  ],
} as const;

/**
 * Marker icon for a sprite: a dark plate with a ring and a glyph; `on` draws the ring and the glyph
 * in the accent. Null where there is no 2D canvas (tests); callers then tint a plain sprite.
 */
export function markerTexture(glyph: readonly string[], on: boolean): Texture | null {
  const S = 96;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  if (!g) return null;
  const m = S / 2;
  g.beginPath();
  g.arc(m, m, 40, 0, Math.PI * 2);
  g.fillStyle = 'rgba(20, 24, 30, 0.86)';
  g.fill();
  g.lineWidth = on ? 6 : 4;
  g.strokeStyle = on ? PALETTE.accCss : 'rgba(223, 230, 238, 0.85)';
  g.stroke();
  g.save();
  g.translate(m - 26, m - 26);
  g.scale(2.6, 2.6);
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.strokeStyle = on ? PALETTE.accCss : '#eef2f6';
  for (const d of glyph) g.stroke(new Path2D(d));
  g.restore();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
