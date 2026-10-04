import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Issue, validateIssueAgainstModel, type Vec3 } from '@aio/schema';
import { fromWgs84, toWgs84 } from '@aio/geo';
import {
  buildKitIssues,
  buildUncertainIssues,
  catalogueFromProfile,
  decodeKitFile,
  exifToIso,
  fitKitFrame,
  kitPhotoPose,
  parseKitDataCall,
  severityModelFromProfile,
  type KitDoc,
  type KitIssueContext,
} from './aik-model';
import { KIT_FRAME, mapDir, mapPoint } from './frames';
import { quatRotate } from './math';

const PROFILE: KitDoc['profile'] = {
  id: 'stack',
  name: 'Stack, chimney or flare',
  classes: [
    { id: 1, key: 'light', label: 'Light staining', severity: 1, color: '#fad34b' },
    { id: 2, key: 'moderate', label: 'Moderate visible rust', severity: 2, color: '#ff7a2d' },
    { id: 4, key: 'uncertain', label: 'Uncertain', uncertain: true, color: '#b68ef8' },
  ],
  severity: [
    { level: 1, label: 'Light', long: 'Light staining', color: '#fad34b' },
    { level: 2, label: 'Moderate', long: 'Moderate visible rust', color: '#ff7a2d' },
    { level: 3, label: 'Heavy', long: 'Heavy deterioration', color: '#ee3f4b' },
  ],
  uncertain: { label: 'Uncertain', long: 'Uncertain / heat affected only', color: '#b68ef8' },
};

const photo = (id: string, extra: Partial<KitDoc['photos'][number]> = {}) => ({
  id,
  latitude: 29,
  longitude: 48,
  altitude: 31.7,
  position: [-30, 0, -40] as Vec3,
  target: [0, 2, 0] as Vec3,
  hfov: 10,
  vfov: 6.7,
  width: 7952,
  height: 5304,
  previewWidth: 2560,
  previewHeight: 1708,
  time: '2019:01:24 11:45:58',
  status: 'finding',
  note: '',
  findings: [] as string[],
  ...extra,
});

const finding = (fid: string, p: string, extra: Partial<KitDoc['findings'][number]> = {}) => ({
  fid,
  photo: p,
  severity: 2,
  class: null,
  classLabel: '',
  bbox: [10, 20, 110, 70] as [number, number, number, number],
  note: 'Rust at a seam.',
  component: 'Stack cladding / seam',
  placement: 'patch',
  center: [1, 40, 0] as Vec3,
  normal: [1, 0, 0] as Vec3,
  height: 40,
  side: 'N',
  zoneLabel: 'Stack',
  coverage: 0.25,
  defect: null,
  ...extra,
});

const ctx = (over: Partial<KitIssueContext> = {}): KitIssueContext => ({
  severityModelId: 'aik-stack',
  meshLayer: 'model',
  frame: KIT_FRAME,
  createdAt: '2026-09-28T16:35:00.000Z',
  layerOf: () => 'photos',
  masksOf: (id) => ({ label: `photos/masks/${id}_mask.png` }),
  patchOf: () => null,
  ...over,
});

describe('kit data scripts', () => {
  it('reads the key and payload of a __kitData call', () => {
    expect(parseKitDataCall('__kitData("masks-00","QUJD")')).toEqual({
      key: 'masks-00',
      b64: 'QUJD',
    });
  });

  it('rejects text that is not a kit data call', () => {
    expect(() => parseKitDataCall('var x = 1;')).toThrow(/kit data/);
  });

  it('joins chunks and unwraps gzip', () => {
    const payload = Buffer.from('glTF-binary-model');
    const gz = gzipSync(payload);
    const half = Math.floor(gz.length / 2);
    const chunks: Record<string, string> = {
      'model.a1': gz.subarray(0, half).toString('base64'),
      'model.b2': gz.subarray(half).toString('base64'),
    };
    const out = decodeKitFile({ chunks: ['model.a1', 'model.b2'], gz: true }, (c) => {
      const v = chunks[c];
      if (!v) throw new Error(c);
      return v;
    });
    expect(Buffer.from(out).toString()).toBe('glTF-binary-model');
  });
});

describe('kit profile', () => {
  it('turns the severity scale into a severity model with uncertain', () => {
    const m = severityModelFromProfile(PROFILE, 'aik-stack');
    expect(m.levels.map((l) => [l.value, l.label, l.color, l.criteria])).toEqual([
      [1, 'Light', '#fad34b', 'Light staining'],
      [2, 'Moderate', '#ff7a2d', 'Moderate visible rust'],
      [3, 'Heavy', '#ee3f4b', 'Heavy deterioration'],
    ]);
    expect(m.uncertain).toEqual({ label: 'Uncertain / heat affected only', color: '#b68ef8' });
  });

  it('turns the classes into a catalogue keyed by class key, keeping uncertain', () => {
    const c = catalogueFromProfile(PROFILE, 'aik-stack', 'aik-stack-classes');
    expect(c.assetType).toBe('stack');
    expect(c.classes.map((k) => [k.id, k.label, k.color, k.hotkey])).toEqual([
      ['light', 'Light staining', '#fad34b', '1'],
      ['moderate', 'Moderate visible rust', '#ff7a2d', '2'],
      ['uncertain', 'Uncertain', '#b68ef8', '4'],
    ]);
  });
});

describe('kit frame from photo GPS', () => {
  // Synthetic site: asset base at a known UTM position, kit north turned 2 deg from grid north.
  const epsg = 32639;
  const base: Vec3 = [220000, 3213000, 31.7];
  const turn = (2 * Math.PI) / 180;
  const photos = [
    [-30, 5, -40],
    [50, 20, 10],
    [5, 60, 45],
    [-20, 75, 30],
  ].map(([xn, y, ze], i) => {
    const e = (ze ?? 0) * Math.cos(turn) - (xn ?? 0) * Math.sin(turn);
    const n = (ze ?? 0) * Math.sin(turn) + (xn ?? 0) * Math.cos(turn);
    const [lon, lat] = toWgs84([base[0] + e, base[1] + n, 0], epsg);
    return photo(`p${i}`, {
      latitude: lat,
      longitude: lon,
      altitude: base[2] + (y ?? 0),
      position: [xn ?? 0, y ?? 0, ze ?? 0],
    });
  });

  it('places the origin at the asset base and recovers the turn', () => {
    const f = fitKitFrame(photos, epsg);
    expect(f.origin[0]).toBeCloseTo(base[0], 2);
    expect(f.origin[1]).toBeCloseTo(base[1], 2);
    expect(f.origin[2]).toBeCloseTo(31.7, 3);
    expect(f.thetaDeg).toBeCloseTo(2, 3);
    expect(f.rms).toBeLessThan(0.01);
  });

  it('maps a kit point to the local frame so its CRS position matches its GPS', () => {
    const f = fitKitFrame(photos, epsg);
    const p = photos[2];
    if (!p) throw new Error('fixture');
    const local = mapPoint(f.frame, p.position);
    const [e, n] = fromWgs84([p.longitude, p.latitude, 0], epsg);
    expect(f.origin[0] + local[0]).toBeCloseTo(e, 2);
    expect(f.origin[1] - local[2]).toBeCloseTo(n, 2);
    expect(f.origin[2] + local[1]).toBeCloseTo(p.altitude, 3);
  });

  it('with no turn reduces to the kit frame (x = z_kit, z = -x_kit)', () => {
    const f = fitKitFrame(photos, epsg);
    const flat = { ...f.frame, rotation: KIT_FRAME.rotation };
    expect(mapPoint(flat, [1, 2, 3]).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([3, 2, -1]);
  });
});

describe('kit photo pose', () => {
  it('looks from the camera position at the target, in the local frame', () => {
    const p = photo('p001', { position: [-30, 0, -40], target: [0, 2, 0] });
    const pose = kitPhotoPose(KIT_FRAME, p);
    expect(pose.pos).toEqual([-40, 0, 30]);
    const look = quatRotate(pose.q, [0, 0, -1]);
    const want = mapDir(KIT_FRAME, [30, 2, 40]);
    const len = Math.hypot(...want);
    look.forEach((v, i) => {
      expect(v).toBeCloseTo((want[i] ?? 0) / len, 6);
    });
    // Image up stays up (no roll).
    expect(quatRotate(pose.q, [0, 1, 0])[1]).toBeGreaterThan(0.99);
    expect(pose.lens).toEqual({ model: 'pinhole', hfovDeg: 10, aspect: 2560 / 1708 });
  });

  it('reads EXIF local time with the site offset', () => {
    expect(exifToIso('2019:01:24 11:45:58', '+03:00')).toBe('2019-01-24T11:45:58+03:00');
    expect(exifToIso('', '+03:00')).toBeUndefined();
  });
});

describe('kit findings to issues', () => {
  const model = severityModelFromProfile(PROFILE, 'aik-stack');

  it('makes one issue per finding (photo unit) with box, mask and mesh sightings', () => {
    const kit = {
      profile: PROFILE,
      photos: [photo('p086')],
      findings: [finding('F01', 'p086')],
    } as KitDoc;
    const issues = buildKitIssues(kit, ctx({ patchOf: () => 'models/patches/F01.json' }));
    expect(issues).toHaveLength(1);
    const i = issues[0];
    if (!i) throw new Error('no issue');
    expect(Issue.safeParse(i).success).toBe(true);
    expect(validateIssueAgainstModel(i, model).ok).toBe(true);
    expect(i.code).toBe('F01');
    expect(i.classId).toBe('moderate');
    expect(i.severity).toBe(2);
    expect(i.title).toBe('Moderate visible rust, Stack cladding / seam');
    expect(i.sightings).toEqual([
      {
        on: 'mesh',
        layer: 'model',
        geom: { type: 'spatch', src: { path: 'models/patches/F01.json' }, center: [0, 40, -1] },
      },
      {
        on: 'image',
        layer: 'photos',
        photo: 'p086',
        geom: { type: 'mask', src: { path: 'photos/masks/p086_mask.png' } },
      },
      {
        on: 'image',
        layer: 'photos',
        photo: 'p086',
        geom: { type: 'box', x: 10, y: 20, w: 100, h: 50 },
      },
    ]);
    expect(i.note).toContain('Rust at a seam.');
    expect(i.note).toContain('40.0 m');
  });

  it('groups region findings by defect, takes the worst severity and pins points', () => {
    const kit = {
      profile: {
        ...PROFILE,
        classes: [
          { id: 3, key: 'cladding', label: 'Cladding damage', severity: 2, color: '#e94b9a' },
        ],
      },
      photos: [photo('p1'), photo('p2'), photo('p3')],
      findings: [
        finding('F0002', 'p1', {
          class: 'cladding',
          severity: 1,
          defect: 'D012',
          placement: 'point',
          center: [0, 10, 5],
          normal: [0, 0, 1],
        }),
        finding('F0003', 'p2', {
          class: 'cladding',
          severity: 2,
          defect: 'D012',
          placement: 'none',
          center: null,
          normal: null,
        }),
        finding('F0001', 'p3', {
          class: 'cladding',
          severity: 1,
          defect: 'D003',
          placement: 'none',
          center: null,
          normal: null,
        }),
      ],
    } as KitDoc;
    const issues = buildKitIssues(kit, ctx({ masksOf: () => ({}) }));
    expect(issues.map((i) => i.code)).toEqual(['D003', 'D012']);
    const d12 = issues[1];
    if (!d12) throw new Error('no issue');
    expect(d12.severity).toBe(2);
    expect(d12.classId).toBe('cladding');
    expect(d12.sightings.flatMap((s) => (s.on === 'image' ? [s.photo] : []))).toEqual(['p1', 'p2']);
    expect(d12.sightings[0]).toEqual({
      on: 'mesh',
      layer: 'model',
      geom: { type: 'spoint', p: [5, 10, 0], n: [1, 0, 0] },
    });
    expect(d12.note).toContain('F0002');
  });

  it('puts image sightings on the layer that holds the photo and skips photos not imported', () => {
    const kit = {
      profile: PROFILE,
      photos: [photo('t1'), photo('x1')],
      findings: [
        finding('F01', 't1', { defect: 'D001' }),
        finding('F02', 'x1', { defect: 'D001' }),
      ],
    } as KitDoc;
    const issues = buildKitIssues(
      kit,
      ctx({
        layerOf: (id) => (id === 't1' ? 'thermal' : null),
        masksOf: () => ({}),
        patchOf: () => null,
      }),
    );
    const img = issues[0]?.sightings.flatMap((s) => (s.on === 'image' ? [[s.layer, s.photo]] : []));
    expect(img).toEqual([['thermal', 't1']]);
    // No patch file: the patch centre becomes a surface point.
    expect(issues[0]?.sightings[0]?.on === 'mesh' && issues[0].sightings[0].geom.type).toBe(
      'spoint',
    );
  });

  it('makes an uncertain issue per uncertain-only photo, with its uncertain mask', () => {
    const kit = {
      profile: PROFILE,
      photos: [
        photo('p006', { status: 'uncertain', note: 'Heat affected.' }),
        photo('p007', { status: 'uncertain', note: 'Loose board.' }),
        photo('p008', { status: 'none' }),
      ],
      findings: [],
    } as KitDoc;
    const issues = buildUncertainIssues(
      kit,
      ctx({
        masksOf: (id) =>
          id === 'p006' ? { uncertain: `photos/masks/${id}_uncertain_mask.png` } : {},
      }),
    );
    expect(issues.map((i) => [i.code, i.severity, i.classId])).toEqual([
      ['U01', 'uncertain', 'uncertain'],
      ['U02', 'uncertain', 'uncertain'],
    ]);
    expect(issues[0]?.sightings[0]).toEqual({
      on: 'image',
      layer: 'photos',
      photo: 'p006',
      geom: { type: 'mask', src: { path: 'photos/masks/p006_uncertain_mask.png' } },
    });
    // Without a mask the whole review frame is marked.
    expect(issues[1]?.sightings[0]).toEqual({
      on: 'image',
      layer: 'photos',
      photo: 'p007',
      geom: { type: 'box', x: 0, y: 0, w: 2560, h: 1708 },
    });
    for (const i of issues) expect(validateIssueAgainstModel(i, model).ok).toBe(true);
  });
});
