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
/**
 * The gaps beside the circles are darker than this. A night equirect (black sky and ground, a lit
 * horizon band) passes the two means above, but its horizon runs through these gaps.
 */
const MAX_GAP_MEAN = 30;

/**
 * Mean of the gaps: columns 0, 31, 32 and 63, rows 9 to 11 and 21 to 23. Those pixel centres sit
 * at least 4.5 rows off the circles' middle row, so 16.1 px or more from both centres: dark even
 * when the circles fill the frame and touch at the middle (rows 12 to 20 of the middle columns are
 * picture then), yet inside a night equirect's horizon band.
 */
function gapMean(grey: Uint8Array, w: number, h: number): number {
  const cols = [0, w / 2 - 1, w / 2, w - 1];
  const rows = [9, 10, 11, 21, 22, 23].map((r) => Math.round((r * h) / 32));
  let sum = 0;
  let n = 0;
  for (const y of rows)
    for (const x of cols) {
      sum += grey[y * w + x] ?? 0;
      n++;
    }
  return n > 0 ? sum / n : 0;
}

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
  return (
    outSum / outN < MAX_OUTSIDE_MEAN &&
    inSum / inN > MIN_INSIDE_MEAN &&
    gapMean(grey, w, h) < MAX_GAP_MEAN
  );
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
