/**
 * A tileable normal map for water, generated in code (the app is offline and ships no fetched
 * textures): a height field summed from waves whose wave vectors are whole numbers of cycles per
 * tile, so the map repeats seamlessly; amplitudes fall off like a wind sea spectrum. RGBA8,
 * tangent space (x right, y up the texture, z out), `size` x `size`.
 */
export function waterNormalPixels(size = 256, seed = 7): Uint8Array {
  let state = seed >>> 0 || 1;
  const rand = () => {
    // xorshift32: deterministic across runs
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  interface Wave {
    kx: number;
    ky: number;
    amp: number;
    phase: number;
  }
  const waves: Wave[] = [];
  // wind from roughly one direction, with spread; wave numbers 2 to 24 cycles per tile
  const wind = 0.6;
  for (let i = 0; i < 48; i++) {
    const k = 2 + Math.floor(rand() * rand() * 23);
    const ang = wind + (rand() - 0.5) * 2.2;
    const kx = Math.round(Math.cos(ang) * k);
    const ky = Math.round(Math.sin(ang) * k);
    if (kx === 0 && ky === 0) continue;
    const len = Math.hypot(kx, ky);
    waves.push({ kx, ky, amp: 1 / Math.pow(len, 1.6), phase: rand() * Math.PI * 2 });
  }
  const dx = new Float32Array(size * size);
  const dy = new Float32Array(size * size);
  let maxSlope = 1e-9;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let sx = 0;
      let sy = 0;
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      for (const w of waves) {
        // d/du of amp * sin(kx u + ky v + phase), in units per tile radian
        const c = w.amp * Math.cos(w.kx * u + w.ky * v + w.phase);
        sx += c * w.kx;
        sy += c * w.ky;
      }
      const i = y * size + x;
      dx[i] = sx;
      dy[i] = sy;
      maxSlope = Math.max(maxSlope, Math.hypot(sx, sy));
    }
  const out = new Uint8Array(size * size * 4);
  const scale = 1.6 / maxSlope;
  for (let i = 0; i < size * size; i++) {
    const nx = -(dx[i] ?? 0) * scale;
    const ny = -(dy[i] ?? 0) * scale;
    const inv = 1 / Math.hypot(nx, ny, 1);
    out[i * 4] = Math.round((nx * inv * 0.5 + 0.5) * 255);
    out[i * 4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
    out[i * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}
