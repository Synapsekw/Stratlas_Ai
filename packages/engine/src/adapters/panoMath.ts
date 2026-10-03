/**
 * Panorama maths, shared by the immersive view's shader and its tests. Directions are in the local
 * frame (Y up, X east, Z south); azimuths are clockwise from local north (-Z), in degrees.
 */

/** What part of the sphere a panorama image covers, around its centre column (`headingDeg`). */
export interface PanoCoverage {
  /** Horizontal span (360 for a full panorama). */
  hspanDeg: number;
  /** Degrees above the horizon at the image's top edge (90 for a full panorama). */
  vtopDeg: number;
  /** Degrees below the horizon at the image's bottom edge (90 for a full panorama). */
  vbotDeg: number;
}

export const FULL_SPHERE: PanoCoverage = { hspanDeg: 360, vtopDeg: 90, vbotDeg: 90 };

const DEG = Math.PI / 180;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Coverage per panorama id from a project's `panoramas/panoramas.json` (`aio.panoramas/1`, written
 * by the importers because the manifest's `PanoRef` has no field for partial coverage).
 */
export function parsePanoIndex(json: unknown): Map<string, PanoCoverage> {
  const out = new Map<string, PanoCoverage>();
  const list = (json as { panoramas?: unknown } | null)?.panoramas;
  if (!Array.isArray(list)) return out;
  for (const p of list as Record<string, unknown>[]) {
    if (typeof p.id !== 'string') continue;
    const h = p.hspanDeg;
    const t = p.vtopDeg;
    const b = p.vbotDeg;
    out.set(p.id, {
      hspanDeg: isNum(h) && h > 0 ? Math.min(360, h) : 360,
      vtopDeg: isNum(t) ? Math.max(-90, Math.min(90, t)) : 90,
      vbotDeg: isNum(b) ? Math.max(-90, Math.min(90, b)) : 90,
    });
  }
  return out;
}

/**
 * Coverage of a panorama without metadata, from its image size: 2:1 is a full sphere; otherwise a
 * 360 degree strip at the image's own angular resolution, centred on the horizon.
 */
export function coverageFromImage(width: number, height: number): PanoCoverage {
  if (!(width > 0 && height > 0) || Math.abs(width / height - 2) < 0.02) return FULL_SPHERE;
  const v = Math.min(180, (360 * height) / width);
  return { hspanDeg: 360, vtopDeg: v / 2, vbotDeg: v / 2 };
}

/** Azimuth (clockwise from -Z) and elevation of a direction, degrees. */
export function dirToAzEl(d: readonly [number, number, number]): [number, number] {
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const az = Math.atan2(d[0], -d[2]) / DEG;
  const el = Math.asin(Math.max(-1, Math.min(1, d[1] / len))) / DEG;
  return [((az % 360) + 360) % 360, el];
}

/** Unit direction for an azimuth (clockwise from -Z) and elevation, degrees. */
export function azElToDir(azDeg: number, elDeg: number): [number, number, number] {
  const a = azDeg * DEG;
  const e = elDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/**
 * Texture coordinate (u right, v up, as three.js with flipY) of a view direction on a panorama
 * whose centre column looks along `headingDeg`; null outside the covered part. Same rule as the
 * fragment shader and the Al-Zour viewer.
 */
export function panoUv(
  d: readonly [number, number, number],
  headingDeg: number,
  cov: PanoCoverage,
): [number, number] | null {
  const [az, el] = dirToAzEl(d);
  const da = ((((az - headingDeg + 540) % 360) + 360) % 360) - 180;
  const u = 0.5 + da / cov.hspanDeg;
  const v = (el + cov.vbotDeg) / (cov.vtopDeg + cov.vbotDeg);
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [u, v];
}

/** Narrowest and widest vertical field of view of the immersive camera, degrees. */
export const PANO_FOV = { min: 20, max: 100, start: 70 } as const;

/** Look state of the immersive view: where the camera points and how far it is zoomed. */
export interface PanoLook {
  yawDeg: number;
  pitchDeg: number;
  fovDeg: number;
}

const wrap360 = (a: number) => ((a % 360) + 360) % 360;

/**
 * Drag to look: the panorama follows the pointer (grab), so dragging right turns the view left.
 * One pixel is one pixel's worth of the current vertical field of view.
 */
export function dragLook(look: PanoLook, dxPx: number, dyPx: number, heightPx: number): PanoLook {
  const k = look.fovDeg / Math.max(1, heightPx);
  return {
    ...look,
    yawDeg: wrap360(look.yawDeg - dxPx * k),
    pitchDeg: Math.max(-89, Math.min(89, look.pitchDeg + dyPx * k)),
  };
}

/** Wheel to zoom: each notch narrows or widens the field of view by 8 %, within PANO_FOV. */
export function zoomLook(look: PanoLook, deltaY: number): PanoLook {
  const f = look.fovDeg * (1 + Math.sign(deltaY) * 0.08);
  return { ...look, fovDeg: Math.max(PANO_FOV.min, Math.min(PANO_FOV.max, f)) };
}

/** Where the immersive view starts: along the image centre, a little below the horizon. */
export function startLook(headingDeg: number, cov: PanoCoverage): PanoLook {
  const mid = (cov.vtopDeg - cov.vbotDeg) / 2;
  return {
    yawDeg: wrap360(headingDeg),
    pitchDeg: Math.max(-30, Math.min(0, mid - 10)),
    fovDeg: PANO_FOV.start,
  };
}

/** Short coverage label: "360°" or "Wide 210° x 89°". */
export function coverageLabel(cov: PanoCoverage): string {
  if (cov.hspanDeg >= 359.5 && cov.vtopDeg >= 89.5 && cov.vbotDeg >= 89.5) return '360°';
  return `Wide ${Math.round(cov.hspanDeg)}° x ${Math.round(cov.vtopDeg + cov.vbotDeg)}°`;
}
