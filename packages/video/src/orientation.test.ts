import type { Quat, Vec3 } from '@aio/schema';
import { Euler, Quaternion } from 'three';
import { describe, expect, it } from 'vitest';
import {
  biasQuat,
  composeOrientation,
  orientCamera,
  orientationFromQuat,
  quatConj,
  quatRotate,
} from './orientation';
import { cameraQuatFromGimbal } from './srt';

const D = Math.PI / 180;

describe('camera orientation bias', () => {
  it('matches the three.js Euler order YXZ', () => {
    const o = { yawDeg: 12, pitchDeg: -8, rollDeg: 3 };
    const q = new Quaternion().setFromEuler(
      new Euler(o.pitchDeg * D, o.yawDeg * D, o.rollDeg * D, 'YXZ'),
    );
    const b = biasQuat(o);
    expect(Math.abs(b[0] * q.x + b[1] * q.y + b[2] * q.z + b[3] * q.w)).toBeCloseTo(1, 12);
  });

  it('round-trips yaw, pitch and roll', () => {
    for (const o of [
      { yawDeg: 0.4, pitchDeg: -7.9, rollDeg: 0.25 },
      { yawDeg: -170, pitchDeg: 45, rollDeg: 120 },
      { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    ]) {
      const back = orientationFromQuat(biasQuat(o));
      expect(back.yawDeg).toBeCloseTo(o.yawDeg, 9);
      expect(back.pitchDeg).toBeCloseTo(o.pitchDeg, 9);
      expect(back.rollDeg).toBeCloseTo(o.rollDeg, 9);
    }
  });

  it('tilts the view up for positive pitch and left for positive yaw', () => {
    const q: Quat = [0, 0, 0, 1];
    const view = (o: { yawDeg: number; pitchDeg: number; rollDeg: number }): Vec3 =>
      quatRotate(orientCamera(q, o), [0, 0, -1]);
    expect(view({ yawDeg: 0, pitchDeg: 10, rollDeg: 0 })[1]).toBeGreaterThan(0.17);
    expect(view({ yawDeg: 10, pitchDeg: 0, rollDeg: 0 })[0]).toBeLessThan(-0.17);
  });

  it('applies in the camera frame: pitch is about the image x axis whatever the heading', () => {
    const qLog = cameraQuatFromGimbal(137, -23, 0);
    const turned = orientCamera(qLog, { yawDeg: 0, pitchDeg: -8, rollDeg: 0 });
    const a = quatRotate(qLog, [0, 0, -1]);
    const b = quatRotate(turned, [0, 0, -1]);
    const elev = (v: Vec3) => Math.asin(v[1]) / D;
    expect(elev(b) - elev(a)).toBeCloseTo(-8, 6);
    // the image x axis stays horizontal (no roll)
    expect(quatRotate(turned, [1, 0, 0])[1]).toBeCloseTo(0, 9);
    // and the relative turn between them is the bias
    const rel = orientationFromQuat(
      ((x: Quat, y: Quat) => {
        const [ax, ay, az, aw] = x;
        const [bx, by, bz, bw] = y;
        return [
          aw * bx + ax * bw + ay * bz - az * by,
          aw * by - ax * bz + ay * bw + az * bx,
          aw * bz + ax * by - ay * bx + az * bw,
          aw * bw - ax * bx - ay * by - az * bz,
        ] as Quat;
      })(quatConj(qLog), turned),
    );
    expect(rel.pitchDeg).toBeCloseTo(-8, 9);
  });

  it('composes biases', () => {
    const a = { yawDeg: 1, pitchDeg: -6, rollDeg: 0.2 };
    const b = { yawDeg: -0.3, pitchDeg: -2, rollDeg: 0.1 };
    const c = composeOrientation(a, b);
    const qa = orientCamera(orientCamera([0, 0, 0, 1], a), b);
    const qc = biasQuat(c);
    expect(Math.abs(qa[0] * qc[0] + qa[1] * qc[1] + qa[2] * qc[2] + qa[3] * qc[3])).toBeCloseTo(
      1,
      12,
    );
    expect(c.pitchDeg).toBeCloseTo(-8, 1);
  });
});
