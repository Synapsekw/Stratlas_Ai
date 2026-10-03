import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { LensModel, Vec3 } from '@aio/schema';
import {
  clipHfovDeg,
  groundHit,
  inParallelogram,
  localToPlant,
  mergeFlightClips,
  projectToImage,
  quatAngleDeg,
  type FlightClip,
} from './alzour-check';
import { ALZOUR_GROUPS, parseCsv, parseRegister, registerTags } from './alzour-model';
import { decodeModelZip, glbJson, utmPairs } from './alzour';
import { fitSimilarity2D } from './fit';
import { cameraForward } from './flight';
import { mapPoint } from './frames';
import { quatFromAxisAngle } from './math';
import { plantCameraQuat, plantFrame, plantToScene, plantVideoToFlight } from './plant';
import {
  applyPixelAffine,
  fitPixelAffine,
  fitTileGrid,
  gridCorners,
  invertPixelAffine,
  placementError,
  tileFraction,
  tileIndexOf,
  type PlacedTile,
} from './tiles';

const alpha = (17.9991 * Math.PI) / 180;
const toUtm = (e: number, n: number): [number, number] => [
  244338.089 + e * Math.cos(alpha) + n * Math.sin(alpha),
  3179515.69 - e * Math.sin(alpha) + n * Math.cos(alpha),
];
const fit = fitSimilarity2D(
  [
    [0, 0],
    [1300, 450],
    [2620, 1080],
    [-60, 20],
  ].map(([e = 0, n = 0]) => ({ src: [e, n] as [number, number], dst: toUtm(e, n) })),
);
const origin: Vec3 = [245714, 3179542, 100];
const frame = plantFrame(fit, origin);
const PLOT_Y = 0.62;

describe('tile grids of the plant twin rasters', () => {
  // a grid turned 18 deg in the plant scene, 163.84 m tiles, last column and row cut short
  const step = 163.84;
  const u: [number, number] = [step * Math.cos(-alpha), step * Math.sin(-alpha)];
  const v: [number, number] = [-u[1], u[0]];
  const o: [number, number] = [-1030.75, -212.79];
  const at = (i: number, j: number): [number, number] => [
    o[0] + i * u[0] + j * v[0],
    o[1] + i * u[1] + j * v[1],
  ];
  const tiles: PlacedTile[] = [];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++) {
      const fu = i === 3 ? 0.3 : 1;
      const fv = j === 2 ? 0.97 : 1;
      tiles.push({
        f: `ortho/H_${String(i).padStart(2, '0')}_${String(j).padStart(2, '0')}.webp`,
        c: [at(i, j), at(i + fu, j), at(i + fu, j + fv), at(i, j + fv)],
      });
    }

  it('reads column and row from the tile name', () => {
    expect(tileIndexOf('ortho/H_13_02.webp')).toEqual({ i: 13, j: 2 });
    expect(tileIndexOf('oplan/P_07_04.webp')).toEqual({ i: 7, j: 4 });
    expect(tileIndexOf('map/m0.jpg')).toBeNull();
  });

  it('fits origin and steps from the top-left corners, edge tiles included', () => {
    const g = fitTileGrid(tiles);
    expect(g.o[0]).toBeCloseTo(o[0], 6);
    expect(g.o[1]).toBeCloseTo(o[1], 6);
    expect(Math.hypot(...g.u)).toBeCloseTo(step, 6);
    expect(g.rms).toBeLessThan(1e-6);
    expect([g.maxI, g.maxJ]).toEqual([3, 2]);
    const edge = tiles.find((t) => t.f.includes('H_03_02'));
    if (!edge) throw new Error('missing tile');
    const fr = tileFraction(g, edge);
    expect(fr.fu).toBeCloseTo(0.3, 6);
    expect(fr.fv).toBeCloseTo(0.97, 6);
  });

  it('places the pyramid corners north-up in the local frame (the ortho is north-up in UTM)', () => {
    const g = fitTileGrid(tiles);
    const c = gridCorners(g, 4, 3, 0.5, frame);
    expect(c.tl[1]).toBeCloseTo(0.5, 9);
    // tl -> tr runs due east (local +x), tl -> bl due south (local +z)
    expect(c.tr[2] - c.tl[2]).toBeCloseTo(0, 3);
    expect(c.bl[0] - c.tl[0]).toBeCloseTo(0, 3);
    expect(c.tr[0] - c.tl[0]).toBeCloseTo(4 * step, 3);
    expect(c.bl[2] - c.tl[2]).toBeCloseTo(3 * step, 3);
  });

  it('puts every padded tile where the viewer drew it (plot plan placement)', () => {
    // plot plan layout: 8 x 5 tiles of 2048 px, last column 664 px and last row 1338 px wide
    const full = 2048;
    const plan = tiles.map((t) => {
      const ij = tileIndexOf(t.f) ?? { i: 0, j: 0 };
      return {
        ...t,
        width: ij.i === 3 ? 0.3 * full : full,
        height: ij.j === 2 ? 0.97 * full : full,
      };
    });
    const g = fitTileGrid(plan);
    expect(placementError(g, plan, full)).toBeLessThan(1e-6);
    // in the local frame, the pyramid quad maps each source corner to the matching pixel corner
    const cols = 4;
    const rows = 4; // padded to an even row count, as the importer does
    const c = gridCorners(g, cols, rows, PLOT_Y, frame);
    const lerp = (s: number, t: number): Vec3 => [
      c.tl[0] + s * (c.tr[0] - c.tl[0]) + t * (c.bl[0] - c.tl[0]),
      c.tl[1] + s * (c.tr[1] - c.tl[1]) + t * (c.bl[1] - c.tl[1]),
      c.tl[2] + s * (c.tr[2] - c.tl[2]) + t * (c.bl[2] - c.tl[2]),
    ];
    for (const t of plan) {
      const ij = tileIndexOf(t.f) ?? { i: 0, j: 0 };
      const fu = t.width / full;
      const fv = t.height / full;
      const px = [
        [0, 0],
        [fu, 0],
        [fu, fv],
        [0, fv],
      ] as const;
      t.c.forEach(([x, z], k) => {
        const [du, dv] = px[k] ?? [0, 0];
        const want = mapPoint(frame, [x, PLOT_Y, z]);
        const got = lerp((ij.i + du) / cols, (ij.j + dv) / rows);
        expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThan(1e-6);
      });
    }
    // a tile the viewer drew 1.5 m off the grid is reported
    const moved = plan.map((t, k) =>
      k === 5 ? { ...t, c: t.c.map(([x, z]) => [x + 1.5, z] as [number, number]) } : t,
    );
    expect(placementError(fitTileGrid(plan), moved, full)).toBeCloseTo(1.5, 6);
  });

  it('fits and inverts a pixel to ground affine', () => {
    const pts = [];
    for (let px = 0; px <= 2048; px += 512)
      for (let py = 0; py <= 2000; py += 500)
        pts.push({ px, py, x: 10 + 1.6 * px - 0.52 * py, z: -40 + 0.52 * px + 1.6 * py });
    const a = fitPixelAffine(pts);
    expect(a.max).toBeLessThan(1e-6);
    const [x, z] = applyPixelAffine(a, 700, 300);
    const [px, py] = invertPixelAffine(a, x, z);
    expect(px).toBeCloseTo(700, 6);
    expect(py).toBeCloseTo(300, 6);
  });
});

describe('asset register', () => {
  const csv = [
    'node,tag,name,type,area,group,plant_E,plant_N,utm39_E,utm39_N,base_EL,height_m,top_EL,height_source,has_geometry,source_sheet,notes',
    '20-P-0001A,20-P-0001A,"LNG PUMP, IN-TANK",pump,20,Area_20_LNG_Tanks,1301.1,555.4,,,100.5,2,102.5,drawing,yes,T0006,"says ""hi"""',
    'catwalk-1,,CATWALK,catwalk,10,Area_10_Jetty,2300,700,,,104.5,,,indicative,yes,T0005,',
    '10-A-0001,10-A-0001,JETTY,jetty_platform,10,Area_10_Jetty,2400,800,,,104.5,,,indicative,yes,T0005,',
    'ghost-1,99-X-0001,NOT IN MODEL,other,90,Site_Infrastructure,,,,,,,,indicative,no,,',
  ].join('\r\n');

  it('parses quoted fields with commas and doubled quotes', () => {
    const rows = parseCsv(csv);
    expect(rows[1]?.[2]).toBe('LNG PUMP, IN-TANK');
    expect(rows[1]?.[16]).toBe('says "hi"');
    expect(rows).toHaveLength(5);
  });

  it('reads rows with numbers and empty cells', () => {
    const r = parseRegister(csv);
    expect(r).toHaveLength(4);
    expect(r[0]?.plantE).toBe(1301.1);
    expect(r[0]?.utmE).toBeNull();
    expect(r[1]?.tag).toBe('');
    expect(r[3]?.hasGeometry).toBe(false);
  });

  it('tags model nodes that carry a register tag, with the area group label, area order first', () => {
    const tags = registerTags(
      parseRegister(csv),
      new Set(['20-P-0001A', 'catwalk-1', '10-A-0001']),
    );
    expect(tags).toEqual([
      { node: '10-A-0001', tag: '10-A-0001', area: '10 · Jetty & berths' },
      { node: '20-P-0001A', tag: '20-P-0001A', area: '20 · LNG tanks' },
    ]);
    expect(ALZOUR_GROUPS).toHaveLength(12);
  });
});

describe('model file', () => {
  const json = JSON.stringify({
    asset: { version: '2.0' },
    nodes: [
      { name: 'a', extras: { plant_E: 1300, plant_N: 450, utm39_E: 245713.5, utm39_N: 3179542 } },
      { name: 'b', extras: { plant_E: 1300 } },
    ],
  });
  const pad = (4 - (json.length % 4)) % 4;
  const jb = Buffer.from(json + ' '.repeat(pad));
  const glb = Buffer.alloc(20 + jb.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jb.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  jb.copy(glb, 20);

  it('decodes the base64 zip of the GLB', () => {
    const data = deflateRawSync(glb);
    const name = Buffer.from('plant.glb');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(glb.length, 22);
    head.writeUInt16LE(name.length, 26);
    const b64 = Buffer.concat([head, name, data]).toString('base64');
    const out = decodeModelZip(`${b64}\n`);
    expect(out.name).toBe('plant.glb');
    expect(Buffer.from(out.glb).equals(glb)).toBe(true);
    const g = glbJson(out.glb);
    expect(utmPairs(g.nodes ?? [])).toEqual([{ src: [1300, 450], dst: [245713.5, 3179542] }]);
  });
});

describe('camera checks', () => {
  it('maps a local point back to the plant grid', () => {
    const p = mapPoint(frame, plantToScene(1590.7, 555.4, 141));
    const back = localToPlant(frame, p);
    expect(back.E).toBeCloseTo(1590.7, 6);
    expect(back.N).toBeCloseTo(555.4, 6);
    expect(back.EL).toBeCloseTo(141, 6);
  });

  it('finds where the view axis meets grade', () => {
    const q = quatFromAxisAngle([1, 0, 0], -Math.PI / 4); // looking north, 45 deg down
    const hit = groundHit([0, 100, 0], q, 0);
    expect(hit?.[0]).toBeCloseTo(0, 9);
    expect(hit?.[2]).toBeCloseTo(-100, 9);
    expect(groundHit([0, 100, 0], [0, 0, 0, 1], 0)).toBeNull();
  });

  it('projects points into a pinhole frame', () => {
    const lens = { hfovDeg: 90, aspect: 2 };
    const q = plantCameraQuat(0, 0); // looking along -z
    expect(projectToImage([0, 0, 0], q, lens, [0, 0, -10])).toEqual({ u: 0, v: 0, depth: 10 });
    const edge = projectToImage([0, 0, 0], q, lens, [10, 5, -10]);
    expect(edge?.u).toBeCloseTo(1, 9);
    expect(edge?.v).toBeCloseTo(1, 9);
    expect(projectToImage([0, 0, 0], q, lens, [0, 0, 10])).toBeNull();
  });

  it('measures small rotations accurately', () => {
    const a = plantCameraQuat(87.95, -25.3);
    const b = plantCameraQuat(87.951, -25.3);
    expect(quatAngleDeg(a, b)).toBeCloseTo(0.001, 5);
    expect(quatAngleDeg(a, a)).toBeLessThan(1e-9);
  });

  it('narrows the field of view for 16:9 clips cut from the 17:9 sensor', () => {
    expect(clipHfovDeg(5120 / 2700)).toBe(83);
    expect(clipHfovDeg(960 / 506)).toBe(83);
    expect(clipHfovDeg(16 / 9)).toBeCloseTo(79.3, 1);
  });

  it('tests points against the survey parallelogram', () => {
    expect(inParallelogram([0, 0], [10, 0], [0, 5], [5, 2])).toBe(true);
    expect(inParallelogram([0, 0], [10, 0], [0, 5], [11, 2])).toBe(false);
  });
});

describe('flights from clips', () => {
  const lens: LensModel = { model: 'pinhole', hfovDeg: 83, aspect: 1.8972 };
  const clip = (name: string, created: string, e0: number): FlightClip => ({
    name,
    startUtcMs: Date.parse(created) - 3 * 3_600_000,
    lens,
    video: {
      flight: 1,
      created,
      dur: 0.3,
      hz: 10,
      track: [0, 1, 2].map((i) => [e0 + i, 450, 200, 90, -20, 0, 0]),
    },
  });

  it('puts the clips of one flight on one timeline with their offsets', () => {
    const a = clip('DJI_0001', '2023-02-21T13:22:38.000000Z', 1000);
    const b = clip('DJI_0002', '2023-02-21T13:22:40.000000Z', 1100);
    const { doc, offsets } = mergeFlightClips(
      [b, a],
      (c) => plantVideoToFlight(c.video, frame, c.startUtcMs, c.lens),
      'Flight 1 · 13:22',
    );
    expect(doc.startUtcMs).toBe(Date.UTC(2023, 1, 21, 10, 22, 38));
    expect(offsets.get('DJI_0001')).toBe(0);
    expect(offsets.get('DJI_0002')).toBe(2000);
    expect(doc.samples.map((s) => s.t)).toEqual([0, 100, 200, 2000, 2100, 2200]);
    const fwd = cameraForward(doc.samples[3]?.q ?? [0, 0, 0, 1]);
    // plant azimuth 90 is grid azimuth 108 in the local frame
    expect((Math.atan2(fwd[0], -fwd[2]) * 180) / Math.PI).toBeCloseTo(107.9991, 3);
  });

  it('drops samples of overlapping clips that would go back in time', () => {
    const a = clip('DJI_0001', '2023-02-21T13:22:38.000000Z', 1000);
    const b = {
      ...clip('DJI_0002', '2023-02-21T13:22:38.000000Z', 1100),
      startUtcMs: a.startUtcMs + 100,
    };
    const { doc } = mergeFlightClips(
      [a, b],
      (c) => plantVideoToFlight(c.video, frame, c.startUtcMs, c.lens),
      'x',
    );
    expect(doc.samples.map((s) => s.t)).toEqual([0, 100, 200, 300]);
  });
});
