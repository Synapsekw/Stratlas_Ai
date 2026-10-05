import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Issue, parseManifest } from '@aio/schema';
import sharp from 'sharp';
import { hclChapters, importHcl } from './hcl';
import {
  HCL_SEVERITY_MODEL,
  buildHclIssue,
  classifyFinding,
  tankNormalKit,
  type KitFinding,
} from './hcl-model';
import { decodeKitCloud } from './cloud';
import { matchTurn, orientationProbe } from './orientation';

const F01: KitFinding = {
  id: 'F01',
  title: 'Crack in bottom plate',
  severity: 5,
  area: 'Bottom plate',
  text: 'A crack in the bottom plate.',
  photos: [
    {
      image: '101_0003',
      flight: '101',
      t: 0.05,
      target: [1.165, 0.035, -0.38],
      cam: [1.178, 0.42, -0.095],
      dir: [-0.0268, -0.8033, -0.595],
    },
  ],
  report_page: 7,
  loc: { pos: [1.165, 0.035, -0.38], height_m: 0.04, bearing: 342, r: 1.23 },
};

describe('HCl findings to issues', () => {
  it('classifies findings by title', () => {
    expect(classifyFinding({ title: 'Crack in bottom plate' })).toBe('crack');
    expect(classifyFinding({ title: 'Top plate patch damage' })).toBe('patch-damage');
    expect(classifyFinding({ title: 'Top plate corrosion' })).toBe('corrosion');
    expect(classifyFinding({ title: "Vertical joint 12 o'clock" })).toBe('coating-blister');
  });

  it('points shell normals into the tank', () => {
    expect(tankNormalKit('Shell', [2, 1, 0], [1, 0, 0])).toEqual([-1, 0, -0]);
    expect(tankNormalKit('Bottom plate', [1, 0, 1], [0, -1, 0])).toEqual([0, 1, 0]);
  });

  it('builds a valid issue with a mesh sighting in the local frame and an image sighting', () => {
    const issue = buildHclIssue(F01, {
      meshLayer: 'tank',
      photosLayer: 'photos',
      photoSize: () => ({ width: 1280, height: 960 }),
      createdAt: '2023-11-22T12:00:00Z',
    });
    expect(Issue.safeParse(issue).success).toBe(true);
    expect(issue.severity).toBe(5);
    expect(issue.severityModelId).toBe(HCL_SEVERITY_MODEL.id);
    const mesh = issue.sightings.find((s) => s.on === 'mesh');
    expect(mesh?.on === 'mesh' && mesh.geom.type === 'spoint' ? mesh.geom.p : null).toEqual([
      -0.38, 0.035, -1.165,
    ]);
    const img = issue.sightings.find((s) => s.on === 'image');
    expect(img?.on === 'image' ? img.geom : null).toEqual({ type: 'point', x: 640, y: 480 });
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A one-flight HCl kit slice in `dir` with POI photo 101_0003 and the `extra` POIs. */
function writeSlice(dir: string, extra: string[] = []): void {
  const src = () => dir;
  for (const d of ['app', 'data', 'video', 'photos', 'thumbs'])
    mkdirSync(join(src(), d), { recursive: true });
  const flight = {
    id: '101',
    name: 'Flight 101 · Shell pass 1',
    video_offset: 131.5,
    duration_s: 2,
    segments: ['v101_00.mp4'],
    segment_s: 60,
    t: [-0.2, -0.1, 0, 0.1, 0.2],
    pos: Array.from({ length: 5 }, () => [1.178, 0.42, -0.095]),
    q: Array.from({ length: 5 }, () => [0.0997, 0.0535, 0.0215, 0.9934]),
    qd: Array.from({ length: 5 }, () => [0, 0, 0, 1]),
    servo: [0, 0, 0, 0, 0],
    pois: [
      {
        name: 'POI-01',
        image: '101_0003.JPG',
        t: 0.05,
        target: [1.165, 0.035, -0.38],
        cam: [1.178, 0.42, -0.095],
        dir: [-0.0268, -0.8033, -0.595],
      },
      ...extra.map((image, i) => ({
        name: `POI-${String(i + 2).padStart(2, '0')}`,
        image: `${image}.JPG`,
        t: 0.1,
        target: [1.165, 0.035, -0.38],
        cam: [1.178, 0.42, -0.095],
        dir: [-0.0268, -0.8033, -0.595],
      })),
    ],
    fov_h_deg: 114,
    lens: 'ftheta',
  };
  const wrap = (k: string, v: unknown) =>
    `window.__tankData=window.__tankData||{};window.__tankData["${k}"]=${JSON.stringify(v)};`;
  writeFileSync(join(src(), 'data/flight101.js'), wrap('flight101.json', flight));
  const cloud = new Uint8Array(14);
  new DataView(cloud.buffer).setInt16(0, 1000, true); // point 0: x_kit = 1 m (north)
  cloud[12] = 9;
  writeFileSync(
    join(src(), 'data/cloud101.js'),
    wrap('cloud101.txt', Buffer.from(cloud).toString('base64')),
  );
  writeFileSync(join(src(), 'app/T.glb'), 'glTF');
  writeFileSync(join(src(), 'R.pdf'), '%PDF');
  writeFileSync(join(src(), 'F.csv'), 'id\nF01\n');
  const html = [
    '<script>window.TANK_FILES={"pdf":{"url":"R.pdf"},"csv":{"url":"F.csv"}};',
    `window.TANK_FLIGHTS=${JSON.stringify([{ id: '101', data: 'flight101.json', name: 'Shell pass 1', dur: 2, pois: 1 }])};`,
    `window.TANK_FINDINGS=${JSON.stringify([F01])};`,
    'window.TANK_META={"components":[{"node":"N1_Neck","group":"Nozzles","id":"N1","label":"N1 DN80"}]};</script>',
  ].join('');
  writeFileSync(join(src(), 'T - 3D Report.html'), html);
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x90:rate=25',
    '-t',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    join(src(), 'video/v101_00.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=128x96',
    '-frames:v',
    '1',
    join(src(), 'photos/101_0003.jpg'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=48x36',
    '-frames:v',
    '1',
    join(src(), 'thumbs/101_0003.jpg'),
  ]);
}

describe.skipIf(!hasFfmpeg)('importHcl on a one-flight slice', () => {
  let root = '';
  const src = () => join(root, 'src');
  const out = () => join(root, 'out');

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'aio-hcl-'));
    writeSlice(src());
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a package whose manifest validates', async () => {
    const r = await importHcl({ src: src(), out: out() });
    expect(r.issues).toBe(1);
    const m = parseManifest(JSON.parse(readFileSync(join(out(), 'manifest.json'), 'utf8')));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.crs).toEqual({ epsg: 32639 });
    expect(m.value.layers.map((l) => l.kind)).toEqual(['mesh', 'pointcloud', 'video', 'photos']);
    const video = m.value.layers.find((l) => l.kind === 'video');
    expect(video?.kind === 'video' ? video.offsetMs : null).toBe(200);
    const cloud = decodeKitCloud(new Uint8Array(readFileSync(join(out(), 'clouds/f101.bin'))));
    expect(Array.from(cloud.xyz.slice(0, 3))).toEqual([0, 0, -1000]);
    expect(Array.from(cloud.intensity)).toEqual([9, 0]);
    const issues = JSON.parse(readFileSync(join(out(), 'issues.json'), 'utf8')) as {
      schema: string;
    };
    expect(issues.schema).toBe('aio.issues/1');
  }, 60_000);

  it('skips every file on an unchanged re-run', async () => {
    const r = await importHcl({ src: src(), out: out() });
    expect(r.written).toBe(0);
    expect(r.skipped).toBeGreaterThan(5);
  }, 60_000);

  it('keeps issues the founder created in the app on a re-run', async () => {
    const file = join(out(), 'issues.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; issues: Issue[] };
    const first = saved.issues[0];
    if (!first) throw new Error('no imported issue');
    const at = '2026-10-04T03:00:26.657Z';
    const mine: Issue = {
      ...first,
      id: 'f48c7a80-1f4b-42ec-89b3-fc0e0b83ef89',
      code: 'F12',
      source: 'human',
      status: 'draft',
      author: 'D',
      createdAt: at,
      updatedAt: at,
    };
    writeFileSync(file, JSON.stringify({ ...saved, issues: [...saved.issues, mine] }));
    await importHcl({ src: src(), out: out() });
    const after = JSON.parse(readFileSync(file, 'utf8')) as { issues: Issue[] };
    expect(after.issues.map((i) => i.code)).toEqual([...saved.issues.map((i) => i.code), 'F12']);
  }, 60_000);
});

/** An asymmetric test picture (a bright block in one corner on a gradient), `seed` varies it. */
function picture(w: number, h: number, seed: number) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = x < w / 3 && y < h / 3 ? 250 : Math.round((x / w) * 120 + (y / h) * 60);
      px[i] = v;
      px[i + 1] = (v + seed * 40) % 256;
      px[i + 2] = (x * 7 + y * 3 + seed) % 50;
    }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } });
}

describe.skipIf(!hasFfmpeg)('importHcl turns the kit thumbnails upright', () => {
  let root = '';
  const src = () => join(root, 'src');
  const out = () => join(root, 'out');
  const turnOf = async (file: string, ref: Buffer) =>
    matchTurn(await orientationProbe(file), await orientationProbe(ref)).turn;
  let upright3 = Buffer.alloc(0);
  let upright4 = Buffer.alloc(0);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aio-hcl-turn-'));
    writeSlice(src(), ['101_0004']);
    upright3 = await picture(128, 96, 1).jpeg().toBuffer();
    upright4 = await picture(128, 96, 2).jpeg().toBuffer();
    // as the kit made them: 101_0003 in both sizes (thumbnail upside down), 101_0004 only as an
    // upside-down thumbnail
    writeFileSync(join(root, 'full-101_0003.jpg'), upright3);
    await sharp(upright3).rotate(180).resize(48).jpeg().toFile(join(src(), 'thumbs/101_0003.jpg'));
    await sharp(upright4).rotate(180).resize(48).jpeg().toFile(join(src(), 'thumbs/101_0004.jpg'));
    // first import as before the fix: no photo in both sizes, so nothing to check against
    unlinkSync(join(src(), 'photos/101_0003.jpg'));
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('uses thumbnails as delivered when no photo shows the turn', async () => {
    await importHcl({ src: src(), out: out() });
    expect(await turnOf(join(out(), 'photos/101_0004.jpg'), upright4)).toBe(2);
    const report = readFileSync(join(out(), 'IMPORT-REPORT.md'), 'utf8');
    expect(report).toContain('no photo in both sizes to check the thumbnails against');
  }, 60_000);

  it('turns thumbnails upright and the shapes drawn on them with them', async () => {
    // the founder drew a box on 101_0004 as it was shown (upside down, 48 x 36)
    const file = join(out(), 'issues.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; issues: Issue[] };
    const first = saved.issues[0];
    if (!first) throw new Error('no imported issue');
    const at = '2026-10-04T03:01:49.936Z';
    const mine: Issue = {
      ...first,
      id: 'e1b585dc-163b-43a6-a281-2e2121d3674a',
      code: 'F13',
      source: 'human',
      createdAt: at,
      updatedAt: at,
      sightings: [
        {
          on: 'image',
          layer: 'photos',
          photo: '101_0004',
          geom: { type: 'box', x: 2, y: 3, w: 10, h: 6 },
        },
      ],
    };
    writeFileSync(file, JSON.stringify({ ...saved, issues: [...saved.issues, mine] }));

    // the kit's full copy of 101_0003 shows which way up its thumbnails are
    copyFileSync(join(root, 'full-101_0003.jpg'), join(src(), 'photos/101_0003.jpg'));
    await importHcl({ src: src(), out: out() });
    expect(await turnOf(join(out(), 'photos/101_0004.jpg'), upright4)).toBe(0);
    expect(await turnOf(join(out(), 'photos/thumbs/101_0004.jpg'), upright4)).toBe(0);
    expect(await turnOf(join(out(), 'photos/thumbs/101_0003.jpg'), upright3)).toBe(0);
    expect(await turnOf(join(out(), 'photos/101_0003.jpg'), upright3)).toBe(0);

    const after = JSON.parse(readFileSync(file, 'utf8')) as { issues: Issue[] };
    const f13 = after.issues.find((i) => i.code === 'F13');
    expect(f13?.sightings[0]).toMatchObject({ geom: { type: 'box', x: 36, y: 27, w: 10, h: 6 } });
    const report = readFileSync(join(out(), 'IMPORT-REPORT.md'), 'utf8');
    expect(report).toContain("the kit's POI thumbnails are its full copies turned 180 deg");
    expect(report).toMatch(/Saved image sightings turned with their photo \| 1/);
  }, 60_000);

  it('changes nothing on a re-run', async () => {
    const t0 = Date.now();
    const r = await importHcl({ src: src(), out: out() });
    const touched = readdirSync(out(), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && statSync(join(e.parentPath, e.name)).mtimeMs >= t0)
      .map((e) => e.name);
    // only the report, which no longer lists the turn of the previous run
    expect(touched).toEqual(['IMPORT-REPORT.md']);
    expect(r.written).toBe(1);
    const after = JSON.parse(readFileSync(join(out(), 'issues.json'), 'utf8')) as {
      issues: Issue[];
    };
    const f13 = after.issues.find((i) => i.code === 'F13');
    expect(f13?.sightings[0]).toMatchObject({ geom: { x: 36, y: 27 } });
  }, 60_000);
});

describe('hclChapters', () => {
  it('lists the MOV chapters of one flight folder in order', () => {
    const root = mkdtempSync(join(tmpdir(), 'aio-hcl-orig-'));
    try {
      mkdirSync(join(root, '101-acid tank-1-00'));
      mkdirSync(join(root, '1010-other'));
      for (const f of ['101_0002.MOV', '101_0001.MOV', '101_0003.JPG', 'x_thermal.mp4'])
        writeFileSync(join(root, '101-acid tank-1-00', f), '');
      expect(hclChapters(root, '101')).toEqual([
        join(root, '101-acid tank-1-00', '101_0001.MOV'),
        join(root, '101-acid tank-1-00', '101_0002.MOV'),
      ]);
      expect(hclChapters(root, '102')).toEqual([]);
      expect(hclChapters(join(root, 'missing'), '101')).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
