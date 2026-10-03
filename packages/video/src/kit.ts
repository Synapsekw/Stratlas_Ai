import type { Quat, Vec3 } from '@aio/schema';

/**
 * Converts the clip pose files of the design fixtures (docs/design/assets/MANIFEST.md: HCl
 * `*_pose.json`, Al-Zour `*_path.json`) into an `aio.flight/1` document. The production importer
 * belongs to stream S10; this adapter exists for tests and the verification harness.
 *
 * Frames: `local` = already X east, Y up, Z south (Al-Zour plant frame). `tank-north-x` = the HCl
 * tank frame (X plant north, Y up, Z plant east), rotated +90 degrees about Y into the local frame.
 */
export type KitFrame = 'local' | 'tank-north-x';

interface KitSample {
  t: number;
  pos: number[];
  q: number[];
}

interface KitClip {
  recorded_utc?: string;
  clip_start_in_source_s?: number;
  clip_resolution?: number[];
  lens?: {
    model?: string;
    fov_h_deg?: number;
    hfov_deg?: number;
    image_aspect?: string;
    source_aspect?: number;
  };
  samples: KitSample[];
}

const S = Math.SQRT1_2;
/** +90 degrees about Y: (x, y, z) -> (z, y, -x). */
const TANK_TO_LOCAL: Quat = [0, S, 0, S];

function mulQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function aspectOf(clip: KitClip): number {
  const ia = clip.lens?.image_aspect;
  if (ia) {
    const [w, h] = ia.split(':').map(Number);
    if (w && h) return w / h;
  }
  const [w, h] = clip.clip_resolution ?? [];
  if (w && h) return w / h;
  return clip.lens?.source_aspect ?? 16 / 9;
}

export function kitClipToFlight(
  clip: KitClip,
  opts: { frame: KitFrame; startUtcMs?: number },
): unknown {
  let start = opts.startUtcMs;
  if (start === undefined && clip.recorded_utc) {
    start = Date.parse(clip.recorded_utc) + (clip.clip_start_in_source_s ?? 0) * 1000;
  }
  if (start === undefined || !Number.isFinite(start))
    throw new Error('Kit clip has no recording time; pass startUtcMs');
  const hfov = clip.lens?.fov_h_deg ?? clip.lens?.hfov_deg;
  if (!hfov) throw new Error('Kit clip lens has no horizontal field of view');
  const model = clip.lens?.model === 'ftheta' ? 'ftheta' : 'pinhole';
  const tank = opts.frame === 'tank-north-x';
  return {
    schema: 'aio.flight/1',
    startUtcMs: start,
    lens: { model, hfovDeg: hfov, aspect: aspectOf(clip) },
    samples: clip.samples.map((s) => {
      const [x = 0, y = 0, z = 0] = s.pos;
      const q = s.q as Quat;
      const pos: Vec3 = tank ? [z, y, -x] : [x, y, z];
      return { t: Math.round(s.t * 1000), pos, q: tank ? mulQuat(TANK_TO_LOCAL, q) : q };
    }),
  };
}
