/**
 * The elevation ramp: Turbo (Anton Mikhailov, Google, Apache-2.0, polynomial fit), blue at the
 * bottom through cyan, green and yellow to red at the top. One polynomial feeds both the point shader and
 * the stage legend, so the legend always matches the cloud.
 */
const R4 = [0.13572138, 4.6153926, -42.66032258, 132.13108234] as const;
const G4 = [0.09140261, 2.19418839, 4.84296658, -14.18503333] as const;
const B4 = [0.1066733, 12.64194608, -60.58204836, 110.36276771] as const;
const R2 = [-152.94239396, 59.28637943] as const;
const G2 = [4.27729857, 2.82956604] as const;
const B2 = [-89.90310912, 27.34824973] as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** The part of Turbo used: its near-black ends would vanish on the dark stage. */
const LO = 0.08;
const SPAN = 0.84;

/** Ramp colour at `t` (0 bottom, 1 top) as display RGB, 0..1 per channel. */
export function elevationColour(t: number): [number, number, number] {
  const x = LO + SPAN * clamp01(t);
  const v = [1, x, x * x, x * x * x] as const;
  const w = [v[2] * v[2], v[3] * v[2]] as const;
  const ch = (a: readonly number[], b: readonly number[]) =>
    clamp01(
      (a[0] ?? 0) * v[0] +
        (a[1] ?? 0) * v[1] +
        (a[2] ?? 0) * v[2] +
        (a[3] ?? 0) * v[3] +
        (b[0] ?? 0) * w[0] +
        (b[1] ?? 0) * w[1],
    );
  return [ch(R4, R2), ch(G4, G2), ch(B4, B2)];
}

/** CSS gradient of the ramp, bottom to top, for the legend. */
export function elevationGradient(stops = 9): string {
  const parts: string[] = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    const [r, g, b] = elevationColour(t).map((c) => Math.round(c * 255));
    parts.push(`rgb(${String(r)}, ${String(g)}, ${String(b)}) ${String(Math.round(t * 100))}%`);
  }
  return `linear-gradient(to top, ${parts.join(', ')})`;
}

const glslVec = (a: readonly number[]) =>
  `vec${String(a.length)}(${a.map((n) => n.toFixed(8)).join(', ')})`;

/** GLSL `vec3 elevationRamp(float t)`, the same polynomial as `elevationColour`. */
export const ELEVATION_RAMP_GLSL = /* glsl */ `
vec3 elevationRamp(float t) {
  float x = ${LO.toFixed(2)} + ${SPAN.toFixed(2)} * clamp(t, 0.0, 1.0);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(
    dot(v4, ${glslVec(R4)}) + dot(v2, ${glslVec(R2)}),
    dot(v4, ${glslVec(G4)}) + dot(v2, ${glslVec(G2)}),
    dot(v4, ${glslVec(B4)}) + dot(v2, ${glslVec(B2)})
  ), 0.0, 1.0);
}
`;
