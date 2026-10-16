/**
 * Clockwise 90 degrees of a BGRA bitmap, y down. The new width is the old height.
 * Old pixel (x, y) lands at (y, width - 1 - x).
 */
export function rotateBgra90(src: Buffer, width: number, height: number): Buffer {
  if (width < 1 || height < 1 || src.length !== width * height * 4) {
    throw new Error('The image bitmap size does not match.');
  }
  const dst = Buffer.alloc(src.length);
  const newW = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = y;
      const ny = width - 1 - x;
      const si = (y * width + x) * 4;
      const di = (ny * newW + nx) * 4;
      dst[di] = src[si] ?? 0;
      dst[di + 1] = src[si + 1] ?? 0;
      dst[di + 2] = src[si + 2] ?? 0;
      dst[di + 3] = src[si + 3] ?? 0;
    }
  }
  return dst;
}

interface PinholeLens {
  model: 'pinhole';
  hfovDeg: number;
  aspect: number;
  cx?: number | undefined;
  cy?: number | undefined;
  k1?: number | undefined;
  k2?: number | undefined;
  k3?: number | undefined;
  p1?: number | undefined;
  p2?: number | undefined;
}
interface FthetaLens {
  model: 'ftheta';
  hfovDeg: number;
  aspect: number;
  k?: number[] | undefined;
}
type Lens = PinholeLens | FthetaLens;

/**
 * A lens after the picture is turned 90 degrees clockwise. Aspect follows the new pixel size.
 * A pinhole's horizontal field of view becomes what was vertical, and a principal point turns
 * with the pixels. A value that would not fit the lens schema is left as it was.
 */
export function turnLens90<T extends Lens>(lens: T, width: number, height: number): T {
  const aspect = height / width;
  if (lens.model === 'ftheta') return { ...lens, aspect };
  const hfov = (lens.hfovDeg * Math.PI) / 180;
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) / lens.aspect);
  const hfovDeg = (vfov * 180) / Math.PI;
  const next: PinholeLens = {
    ...lens,
    aspect,
    hfovDeg: hfovDeg > 0 && hfovDeg < 180 ? hfovDeg : lens.hfovDeg,
  };
  if (lens.cx !== undefined && lens.cy !== undefined) {
    next.cx = height - lens.cy;
    next.cy = lens.cx;
  }
  return next as T;
}
