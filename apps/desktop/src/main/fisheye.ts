/*
 * Insta360 `.insp` stills (pinned media, Review Focus 1). The camera writes two fisheye circles
 * side by side in a 2:1 JPEG until Insta360 Studio stitches it, so the aspect alone takes it for
 * a 360. Shrunk to 64 x 32 grey, an unstitched still is two bright discs with black around them;
 * an equirect has picture everywhere. Pure, so main's scan and the tests share it.
 */

/** The size a still is shrunk to before it is judged. */
export const FISHEYE_GREY = { width: 64, height: 32 } as const;

/** The circles: radius 16 px, centred at (16, 16) and (48, 16) of the 64 x 32 image. */
const RADIUS = 16;
const CENTRES = [
  [16, 16],
  [48, 16],
] as const;
/** Pixels farther than this from both centres are the black around the circles. */
const OUTSIDE_PX = 16.5;
/** The black around the circles is darker than this on average ... */
const MAX_OUTSIDE_MEAN = 12;
/** ... and the circles brighter than this. */
const MIN_INSIDE_MEAN = 30;

/** True when a 64 x 32 grey image is two fisheye circles on black, not an equirect. */
export function looksDualFisheye(grey: Uint8Array, w: number, h: number): boolean {
  if (w !== FISHEYE_GREY.width || h !== FISHEYE_GREY.height || grey.length < w * h) return false;
  let outSum = 0;
  let outN = 0;
  let inSum = 0;
  let inN = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.min(...CENTRES.map(([cx, cy]) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
      const v = grey[y * w + x] ?? 0;
      if (d > OUTSIDE_PX) {
        outSum += v;
        outN++;
      } else if (d <= RADIUS) {
        inSum += v;
        inN++;
      }
    }
  if (outN === 0 || inN === 0) return false;
  return outSum / outN < MAX_OUTSIDE_MEAN && inSum / inN > MIN_INSIDE_MEAN;
}

/** Luma (BT.601) of BGRA pixels, as Electron's `NativeImage.toBitmap` gives them. */
export function greyFromBgra(bgra: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const b = bgra[i * 4] ?? 0;
    const g = bgra[i * 4 + 1] ?? 0;
    const r = bgra[i * 4 + 2] ?? 0;
    out[i] = (77 * r + 150 * g + 29 * b) >> 8;
  }
  return out;
}
