import { fromWgs84 } from '@aio/geo';
import type { Quat, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { parseFlight } from './flight';
import {
  cameraQuatFromGimbal,
  lensFromFocal35,
  parseDjiSrt,
  srtTimingCheck,
  srtToFlight,
} from './srt';

/** Mavic 3 style (no gimbal angles), two frames at 29.97 fps. */
const MAVIC3 = `1
00:00:00,000 --> 00:00:00,033
<font size="28">FrameCnt: 1, DiffTime: 33ms
2023-12-25 11:35:42.772
[iso: 100] [shutter: 1/2000.0] [fnum: 2.8] [ev: -0.3] [ct: 5300] [color_md : default] [focal_len: 24.00] [latitude: 29.38445] [longitude: 47.98378] [rel_alt: 288.300 abs_alt: 207.368] </font>

2
00:00:00,033 --> 00:00:00,066
<font size="28">FrameCnt: 2, DiffTime: 33ms
2023-12-25 11:35:42.805
[iso: 100] [shutter: 1/2000.0] [fnum: 2.8] [ev: -0.3] [ct: 5300] [color_md : default] [focal_len: 24.00] [latitude: 29.38446] [longitude: 47.98378] [rel_alt: 288.400 abs_alt: 207.468] </font>
`;

/** Enterprise style with gimbal angles and CRLF line ends. */
const ENTERPRISE = [
  '1',
  '00:00:00,000 --> 00:00:00,016',
  '<font size="28">SrtCnt : 1, DiffTime : 16ms',
  '2024-03-01 09:00:00,100,000',
  '[iso : 110] [shutter : 1/1000.0] [fnum : 280] [ev : 0] [ct : 5500] [color_md : default] [focal_len : 168.00] [dzoom_ratio: 10000, delta:0],[latitude: 25.204800] [longitude: 55.270800] [rel_alt: 60.000 abs_alt: 64.500] [gb_yaw: 90.0 gb_pitch: -30.0 gb_roll: 0.0] </font>',
  '',
].join('\r\n');

/** Phantom 4 style. */
const PHANTOM = `1
00:00:00,000 --> 00:00:01,000
HOME(48.1000,29.0000) 2017.08.05 14:11:51
GPS(48.1001,29.0002,16) BAROMETER:35.2
ISO:100 Shutter:60 EV:0 Fnum:F2.8
`;

const close = (a: readonly number[], b: readonly number[], tol = 1e-6) => {
  a.forEach((v, i) => {
    expect(Math.abs(v - (b[i] ?? NaN))).toBeLessThan(tol);
  });
};

/** Rotate v by unit quaternion q. */
function rot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

describe('parseDjiSrt', () => {
  it('reads time, position, altitudes and focal length per frame (Mavic 3)', () => {
    const f = parseDjiSrt(MAVIC3);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({
      index: 1,
      startMs: 0,
      endMs: 33,
      clock: '2023-12-25T11:35:42.772',
      lat: 29.38445,
      lon: 47.98378,
      relAlt: 288.3,
      absAlt: 207.368,
      focal35: 24,
    });
    expect(f[0]?.gimbal).toBeUndefined();
    expect(f[1]?.startMs).toBe(33);
  });

  it('reads gimbal angles, spaced keys and CRLF (Enterprise)', () => {
    const [f] = parseDjiSrt(ENTERPRISE);
    expect(f).toMatchObject({
      index: 1,
      clock: '2024-03-01T09:00:00.100',
      lat: 25.2048,
      lon: 55.2708,
      relAlt: 60,
      focal35: 168,
      gimbal: { yaw: 90, pitch: -30, roll: 0 },
    });
  });

  it('reads the older GPS(lon,lat,alt) and BAROMETER form (Phantom 4)', () => {
    const [f] = parseDjiSrt(PHANTOM);
    expect(f).toMatchObject({
      lon: 48.1001,
      lat: 29.0002,
      relAlt: 35.2,
      clock: '2017-08-05T14:11:51.000',
    });
  });

  it('skips blocks without a time code and rejects text with no telemetry', () => {
    expect(parseDjiSrt(`garbage\n\n${MAVIC3}`)).toHaveLength(2);
    expect(() => parseDjiSrt('1\n00:00:00,000 --> 00:00:01,000\nhello\n')).toThrow(/telemetry/i);
  });
});

describe('cameraQuatFromGimbal', () => {
  it('looks north and level at yaw 0, pitch 0', () => {
    close(rot(cameraQuatFromGimbal(0, 0, 0), [0, 0, -1]), [0, 0, -1]);
  });

  it('turns clockwise from north for positive yaw (east is +X)', () => {
    close(rot(cameraQuatFromGimbal(90, 0, 0), [0, 0, -1]), [1, 0, 0]);
  });

  it('looks down for negative pitch and keeps image up toward the horizon', () => {
    const q = cameraQuatFromGimbal(0, -90, 0);
    close(rot(q, [0, 0, -1]), [0, -1, 0]);
    close(rot(q, [0, 1, 0]), [0, 0, -1]);
  });

  it('drops the image right side for positive roll', () => {
    expect(rot(cameraQuatFromGimbal(0, 0, 10), [1, 0, 0])[1]).toBeLessThan(0);
  });
});

describe('lensFromFocal35', () => {
  it('gives the horizontal field of view across the full 4:3 sensor width', () => {
    // 24 mm equivalent on a 4:3 sensor: 84 deg diagonal, 71.6 deg across
    const l = lensFromFocal35(24, 16 / 9);
    expect(l.model).toBe('pinhole');
    expect(l.hfovDeg).toBeCloseTo(71.6, 1);
    expect(l.aspect).toBeCloseTo(1.7778, 4);
  });
});

describe('srtToFlight', () => {
  const origin: Vec3 = [...fromWgs84([47.98378, 29.38445, 0], 32639)];
  origin[2] = 10;

  it('writes a valid aio.flight/1 with one sample per frame at the subtitle time', () => {
    const r = srtToFlight(parseDjiSrt(MAVIC3), {
      epsg: 32639,
      origin,
      utcOffsetMin: 180,
      aspect: 16 / 9,
      takeoffHeight: 10,
    });
    const f = parseFlight(r.doc);
    expect(f.samples.map((s) => s.t)).toEqual([0, 33]);
    // 11:35:42.772 in UTC+3
    expect(f.startUtcMs).toBe(Date.UTC(2023, 11, 25, 8, 35, 42, 772));
    // first frame at the origin, height = take-off height + relative altitude - origin H
    close(f.samples[0]?.pos ?? [], [0, 288.3, 0], 1e-3);
    // second frame about 1.1 m north (= -z)
    expect(f.samples[1]?.pos[2]).toBeLessThan(-1);
    expect(f.lens.hfovDeg).toBeCloseTo(71.6, 1);
    expect(r.orientation).toBe('estimated');
    expect(r.warnings.join(' ')).toMatch(/gimbal/i);
  });

  it('interpolates a 5 Hz GPS fix across 60 fps frames and faces the travel from the start', () => {
    // 4 s at 60 fps, the fix moves ~1.1 m east every 12 frames after a 1 s hover
    const blocks: string[] = [];
    const ts = (ms: number) =>
      `00:00:${String(Math.floor(ms / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
    for (let i = 0; i < 240; i++) {
      const a = Math.round((i * 1000) / 60);
      const b = Math.round(((i + 1) * 1000) / 60);
      const fix = Math.max(0, Math.floor(i / 12) - 5);
      const lon = (47.98378 + fix * 0.0000114).toFixed(7);
      blocks.push(
        `${String(i + 1)}\n${ts(a)} --> ${ts(b)}\nFrameCnt: ${String(i + 1)}\n2023-12-25 11:35:42.772\n[focal_len: 24.00] [latitude: 29.38445] [longitude: ${lon}] [rel_alt: 50.000 abs_alt: 60.000]\n`,
      );
    }
    const r = srtToFlight(parseDjiSrt(blocks.join('\n')), {
      epsg: 32639,
      origin,
      utcOffsetMin: 180,
      aspect: 16 / 9,
    });
    const s = r.doc.samples;
    expect(s).toHaveLength(240);
    let maxStep = 0;
    for (let i = 1; i < s.length; i++)
      maxStep = Math.max(maxStep, Math.abs((s[i]?.pos[0] ?? 0) - (s[i - 1]?.pos[0] ?? 0)));
    // no metre jumps: the fixes are spread over their frames
    expect(maxStep).toBeLessThan(0.2);
    // the first frame (still hovering) already looks east, not north
    const fwd = rot(s[0]?.q ?? [0, 0, 0, 1], [0, 0, -1]);
    expect(fwd[0]).toBeGreaterThan(0.8);
    expect(r.orientation).toBe('estimated');
  });

  it('uses gimbal angles when the SRT has them, corrected to grid north', () => {
    const frames = parseDjiSrt(ENTERPRISE);
    const o = fromWgs84([55.2708, 25.2048, 0], 32640);
    const r = srtToFlight(frames, {
      epsg: 32640,
      origin: [o[0], o[1], 0],
      utcOffsetMin: 240,
      aspect: 16 / 9,
      altitude: 'abs',
    });
    expect(r.orientation).toBe('gimbal');
    const s = r.doc.samples[0];
    expect(s?.pos[1]).toBeCloseTo(64.5, 6);
    const fwd = rot(s?.q ?? [0, 0, 0, 1], [0, 0, -1]);
    // yaw 90 (east), pitch -30: mostly +X, down
    expect(fwd[0]).toBeGreaterThan(0.85);
    expect(fwd[1]).toBeCloseTo(-0.5, 2);
  });

  describe('camera heights (data-conventions 3a)', () => {
    const base = { epsg: 32639, origin, utcOffsetMin: 180, aspect: 16 / 9 };

    it('relative altitude plus the take-off height, recorded in the flight file', () => {
      const r = srtToFlight(parseDjiSrt(MAVIC3), {
        ...base,
        heights: { prefer: 'relative', absOffsetM: 0, takeoffH: 13.5 },
      });
      expect(r.heightSource).toBe('relative');
      // H = 13.5 + 288.3, local y = H - origin H (10)
      expect(r.doc.samples[0]?.pos[1]).toBeCloseTo(291.8, 6);
      expect(r.doc.heights).toEqual({ source: 'relative', absOffsetM: 0, takeoffH: 13.5 });
      // the aircraft put its take-off point at absolute altitude 207.368 - 288.3
      expect(r.takeoffAbsAlt).toBeCloseTo(-80.932, 6);
      expect(r.warnings.join(' ')).not.toMatch(/altitude/);
    });

    it('absolute altitude plus the project datum offset', () => {
      // Al-Zour numbers: relative 113.7, absolute minus relative 41.9, plant EL = absolute + 100
      const srt = MAVIC3.replace(
        'rel_alt: 288.300 abs_alt: 207.368',
        'rel_alt: 113.700 abs_alt: 155.600',
      );
      const r = srtToFlight(parseDjiSrt(srt), {
        ...base,
        heights: { prefer: 'absolute', absOffsetM: 100, takeoffH: 100 },
      });
      expect(r.heightSource).toBe('absolute');
      expect(r.doc.samples[0]?.pos[1]).toBeCloseTo(255.6 - 10, 6);
      expect(r.doc.heights.absOffsetM).toBe(100);
      // the second frame still has the Mavic 3 altitudes: absolute is used there too
      expect(r.doc.samples[1]?.pos[1]).toBeCloseTo(207.468 + 100 - 10, 6);
      expect(r.takeoffAbsAlt).not.toBeNull();
    });

    it('falls back frame by frame and says so', () => {
      const noRel = MAVIC3.replace('rel_alt: 288.300 ', '');
      const r = srtToFlight(parseDjiSrt(noRel), {
        ...base,
        heights: { prefer: 'relative', absOffsetM: 0, takeoffH: 10 },
      });
      expect(r.heightSource).toBe('mixed');
      expect(r.doc.samples[0]?.pos[1]).toBeCloseTo(207.368 - 10, 6);
      expect(r.warnings.join(' ')).toMatch(/1 of 2 frames have no relative altitude/);
    });

    it('places frames without any altitude at the take-off height', () => {
      const bare = MAVIC3.replace(/\[rel_alt: [\d.]+ abs_alt: [\d.]+\] /g, '');
      const r = srtToFlight(parseDjiSrt(bare), {
        ...base,
        heights: { prefer: 'absolute', absOffsetM: 100, takeoffH: 12 },
      });
      expect(r.heightSource).toBe('none');
      expect(r.doc.samples.map((s) => s.pos[1])).toEqual([2, 2]);
      expect(r.takeoffAbsAlt).toBeNull();
      expect(r.warnings.join(' ')).toMatch(/2 frames have no altitude/);
    });

    it('reads the GPS altitude and home point of older aircraft', () => {
      const [f] = parseDjiSrt(PHANTOM);
      expect(f?.absAlt).toBe(16);
      expect(f?.home).toEqual({ lon: 48.1, lat: 29 });
    });
  });
});

describe('srtTimingCheck', () => {
  it('compares subtitle starts with the video frame times', () => {
    const frames = parseDjiSrt(MAVIC3);
    const ok = srtTimingCheck(frames, [0, 33.367]);
    expect(ok.frameMs).toBeCloseTo(33.367, 3);
    expect(ok.maxErrorMs).toBeLessThan(1);
    expect(ok.withinOneFrame).toBe(true);
    const off = srtTimingCheck(frames, [100, 133.367]);
    expect(off.withinOneFrame).toBe(false);
  });
});
