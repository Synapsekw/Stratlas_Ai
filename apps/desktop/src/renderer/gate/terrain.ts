/**
 * The launch screen's background: a point-cloud terrain drifting toward the viewer, a mint scan
 * band passing through it, and points near the pointer lit like a scanner (from the approved
 * prototype, docs/brand/quadrion/build/gate.mjs). Plain 2D canvas, about 4,600 points a frame.
 */

export interface TerrainView {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Milliseconds since the screen started (0 for the still frame of reduced motion). */
  t: number;
  /** Smoothed pointer parallax, -1..1. */
  sx: number;
  sy: number;
  /** The scan light in CSS pixels; far off-screen when there is no pointer. */
  lx: number;
  ly: number;
  /** Point colour and lit colour (the theme's `--fg-0` and `--acc`). */
  ink: string;
  lit: string;
}

const COLS = 96;
const ROWS = 48;

function height(x: number, z: number, t: number): number {
  return (
    Math.sin(x * 0.11 + t * 0.00012) * 1.6 +
    Math.cos(z * 0.17 - t * 0.00009) * 1.2 +
    Math.sin((x + z) * 0.05) * 2.2
  );
}

export function drawTerrain(ctx: CanvasRenderingContext2D, v: TerrainView): void {
  const { width: W, height: H, t } = v;
  ctx.clearRect(0, 0, W, H);
  const horizon = H * 0.47 - v.sy * 18;
  const fov = Math.min(W, H) * 0.9;
  const camH = 9;
  const scanZ = ((t * 0.006) % (ROWS + 20)) - 10;
  const R = Math.max(110, Math.min(W, H) * 0.16);
  let litNow = false;
  ctx.fillStyle = v.ink;
  for (let r = 0; r < ROWS; r++) {
    const z = ROWS - r + 4 + ((t * 0.0012) % 1);
    const near = 1 - z / (ROWS + 6);
    for (let c = 0; c < COLS; c++) {
      const x = (c - COLS / 2) * 1.12;
      const y = height(c, r + t * 0.0012, t);
      const X = W / 2 + (x / z) * fov * 0.55 - v.sx * 70 * near;
      const Y = horizon + ((camH - y) / z) * fov * 0.32;
      if (X < -4 || X > W + 4 || Y < 0 || Y > H + 4) continue;
      const d = Math.abs(ROWS - r - scanZ);
      const band = d < 1.6 ? 1 - d / 1.6 : 0;
      const dl = Math.hypot(X - v.lx, Y - v.ly);
      const torch = dl < R ? (1 - dl / R) ** 2 : 0;
      const glow = Math.max(band, torch);
      // the fill colour is parsed on every assignment: set it only when it changes
      const lit = glow > 0.02;
      if (lit !== litNow) {
        ctx.fillStyle = lit ? v.lit : v.ink;
        litNow = lit;
      }
      ctx.globalAlpha = lit ? 0.18 + glow * 0.7 : 0.05 + near * 0.3;
      const s = (0.6 + near * 1.6) * (1 + glow * 0.6);
      ctx.fillRect(X - s / 2, Y - s / 2, s, s);
    }
  }
  ctx.globalAlpha = 1;
}
