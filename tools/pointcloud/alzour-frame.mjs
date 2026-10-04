// The Al-Zour full-resolution cloud (Metashape Production_2-Final.laz, UTM 39N, ellipsoidal-ish
// heights) to the project frame used by the png-packed review cloud: shifted -1/-2 m along the
// plant grid E/N and levelled with a quadratic surface over the plant grid (coordinates clamped
// to the plant area), so heights become plant elevations (EL, grade = 100).
//
// The constants were recovered from the 10.1 M points of the png-packed cloud (a 1.2 % thinning
// of the same file) matched by position and colour against a 1/200 sample of the LAZ: 153 k
// matches, median height residual under 1 cm in every 200 m cell (see README.md).

/** Plant grid north is 17.9991 degrees east of grid north (import report). */
export const PLANT_TURN_DEG = 17.9991;
/** Plant scene to local frame offset after the turn, metres (import report). */
export const PLANT_OFFSET = [-0.48, 0, 0.035];
/** Project origin, UTM 39N E, N and plant EL (manifest). */
export const ORIGIN = [245714, 3179542, 100];

const t = (PLANT_TURN_DEG * Math.PI) / 180;
const cos = Math.cos(t);
const sin = Math.sin(t);

/** -1 m plant east and -2 m plant north, in UTM metres. */
export const SHIFT_EN = [-cos - 2 * sin, sin - 2 * cos];

/** Quadratic in plant km (u east, w south): c0 + c1 u + c2 w + c3 u^2 + c4 u w + c5 w^2. */
export const LEVEL = [
  119.0300731066205, -0.04371710840722738, -16.993457026307276, 4.849232571737101,
  -0.2627464307650086, 4.1555079862384945,
];
/** The quadratic is evaluated with u and w clamped to these ranges (km). */
export const CLAMP_U = [-0.695, 0.6];
export const CLAMP_W = [-0.19, 0.1675];

/** Reference implementation: LAZ (E, N, Z) to project CRS (E, N, EL). */
export function toProject(e, n, z) {
  const E = e + SHIFT_EN[0];
  const N = n + SHIFT_EN[1];
  const lx = E - ORIGIN[0] - PLANT_OFFSET[0];
  const lz = ORIGIN[1] - N - PLANT_OFFSET[2];
  const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));
  const u = clamp((lx * cos + lz * sin) / 1000, CLAMP_U);
  const w = clamp((-lx * sin + lz * cos) / 1000, CLAMP_W);
  const [c0, c1, c2, c3, c4, c5] = LEVEL;
  return [E, N, z + c0 + c1 * u + c2 * w + c3 * u * u + c4 * u * w + c5 * w * w];
}

const num = (v) => (Math.abs(v) < 1e-12 ? '0' : v.toPrecision(15));

/** The same transform as PDAL stages: filters.ferry (scratch dims U, W) and filters.assign. */
export function pdalStages() {
  const ex = -ORIGIN[0] - PLANT_OFFSET[0] + SHIFT_EN[0]; // lx = X + ex
  const ez = ORIGIN[1] - PLANT_OFFSET[2] - SHIFT_EN[1]; // lz = ez - Y
  const [c0, c1, c2, c3, c4, c5] = LEVEL;
  return [
    { type: 'filters.ferry', dimensions: '=>U, =>W' },
    {
      type: 'filters.assign',
      value: [
        `U = ((X + ${num(ex)}) * ${num(cos)} + (${num(ez)} - Y) * ${num(sin)}) / 1000`,
        `W = ((${num(ez)} - Y) * ${num(cos)} - (X + ${num(ex)}) * ${num(sin)}) / 1000`,
        `U = ${num(CLAMP_U[0])} WHERE U < ${num(CLAMP_U[0])}`,
        `U = ${num(CLAMP_U[1])} WHERE U > ${num(CLAMP_U[1])}`,
        `W = ${num(CLAMP_W[0])} WHERE W < ${num(CLAMP_W[0])}`,
        `W = ${num(CLAMP_W[1])} WHERE W > ${num(CLAMP_W[1])}`,
        `Z = Z + ${num(c0)} + ${num(c1)} * U + ${num(c2)} * W + ${num(c3)} * U * U + ${num(c4)} * U * W + ${num(c5)} * W * W`,
        `X = X + ${num(SHIFT_EN[0])}`,
        `Y = Y + ${num(SHIFT_EN[1])}`,
      ],
    },
  ];
}
