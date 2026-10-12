// Ground truth of the synthetic walk fixtures (packages/schema/src/__fixtures__/walk/), written by
// tools/fixtures/make-walk-path.mjs. The walk is an L in the model frame (x east, y up, z south):
// 4 s standing at the origin, then 40 m east and 30 m north at 1.2 m/s, the camera 1.7 m above
// the ground (y = 0).
//
// The raw frame (what `walk.process` would write) is the model turned by `rotDeg` about up, scaled
// and shifted:
//
//   raw = scale * Ry(rotDeg) * model + shift      (Ry: right-handed turn about +Y, three.js)
//   qRaw = Ry(rotDeg) * qModel                     (quaternions x y z w, three.js camera axes)
//
// A fit of the raw path onto the model has to find the inverse. The broken variant
// (raw-path.broken.json) loses registration for t in [30, 38]; the stills after it are a second
// reconstruction (`segment: 1`) with its own raw frame, `GROUND_TRUTH_SEGMENT_1`.

export const GROUND_TRUTH = Object.freeze({ rotDeg: 37, scale: 0.23, shift: [3, -1, 7] });

export const GROUND_TRUTH_SEGMENT_1 = Object.freeze({
  rotDeg: 112,
  scale: 0.31,
  shift: [-5, 2, 1],
});

/** The walk itself, in the model frame. */
export const WALK = Object.freeze({
  standS: 4,
  speedMps: 1.2,
  legs: [
    [40, 0],
    [0, -30],
  ],
  heightM: 1.7,
  stepsPerM: 1.8,
  stillEveryS: 0.5,
  orientationHz: 200,
  videoFps: 30,
  /** Registration is lost in the broken variant for t in this window, seconds. */
  gap: [30, 38],
});
