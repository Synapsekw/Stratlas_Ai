// The change and modelling demo: deterministic, within budget, free of client data, and its
// truth.json agrees with the files it describes (recomputed here from the files themselves).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectManifest } from '../../packages/schema/src/manifest.ts';
import { BUDGET_MB, CHANGE_ID, buildChangeDemo, treeHash } from './build-change-demo.mjs';
import { checkChangeDemo } from './check-change-demo.mjs';
import { parseDxf } from './dxf.mjs';
import { readLasHeader } from './formats.mjs';
import { decodeOnnx, postprocessYoloV8, runOnnx } from './onnx-test-model.mjs';

let base;
let root;
let truth;
let second;
const read = (rel) => readFileSync(join(root, rel));
const readJson = (rel) => JSON.parse(read(rel).toString('utf8'));

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'change-demo-test-'));
  const a = await buildChangeDemo({ out: join(base, 'a'), quick: true });
  const b = await buildChangeDemo({ out: join(base, 'b'), quick: true });
  root = a.root;
  truth = a.truth;
  second = b.root;
}, 240_000);

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

const glbNodes = (buf) => {
  const len = buf.readUInt32LE(12);
  const j = JSON.parse(buf.toString('utf8', 20, 20 + len));
  return j.nodes.filter((n) => n.mesh !== undefined).map((n) => n.name);
};

describe('change demo build', () => {
  it('is the same bytes on a second build', async () => {
    expect(await treeHash(second)).toBe(await treeHash(root));
  });

  it('stays within its budget and passes the change demo and client data checks', () => {
    const r = checkChangeDemo(root);
    expect(r.findings).toEqual([]);
    expect(r.bytes).toBeLessThan(BUDGET_MB * 1e6);
  });

  it('writes no build-machine path, temp folder or clock into any text file', async () => {
    const files = [];
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(json|geojson|txt|dxf)$/.test(e.name)) files.push(p);
      }
    };
    await walk(root);
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      expect(text, f).not.toMatch(
        /stratlas-change-demo-|change-demo-test-|AppData|\\Users\\|\/home\/|\r/,
      );
      const today = new Date().toISOString().slice(0, 10);
      if (!truth.captures.list.some((c) => c.date === today)) expect(text, f).not.toContain(today);
    }
  });

  it('is a valid project with two dates, every layer of each date naming it', () => {
    const m = ProjectManifest.parse(readJson('manifest.json'));
    expect(m.id).toBe(CHANGE_ID);
    expect(m.name).toContain('2 dates');
    expect(m.captures.map((c) => c.id)).toEqual(['d1', 'd2']);
    for (const d of ['d1', 'd2']) {
      const kinds = m.layers
        .filter((l) => l.capture === d)
        .map((l) => l.kind)
        .sort();
      expect(kinds).toEqual([
        'mesh',
        'photos',
        'pointcloud',
        'raster',
        'raster',
        'vector',
        'video',
      ]);
    }
    expect(m.layers.filter((l) => !l.capture).map((l) => l.id)).toEqual(['plan']);
  });
});

describe('truth.json agrees with the files', () => {
  it('model parts: added, removed, moved and changed by name', () => {
    const n1 = glbNodes(read('models/model-d1.glb'));
    const n2 = glbNodes(read('models/model-d2.glb'));
    const v = Object.fromEntries(truth.changes.component.items.map((i) => [i.part, i.verdict]));
    for (const p of n2.filter((x) => !n1.includes(x))) expect(v[p]).toBe('added');
    for (const p of n1.filter((x) => !n2.includes(x))) expect(v[p]).toBe('removed');
    expect(truth.changes.component.verdicts).toEqual({
      added: 1,
      changed: 1,
      moved: 1,
      removed: 1,
      unchanged: 6,
    });
    expect(truth.changes.component.items.find((i) => i.part === 'SK-01').offsetM).toEqual([
      3, 0, -1.5,
    ]);
  });

  it('point clouds: LAS files in the project CRS with the points the layers hold', () => {
    for (const d of ['d1', 'd2']) {
      const h = readLasHeader(read(`sources/cloud-${d}.las`));
      expect(h.epsg).toBe(32631);
      expect(h.points).toBe(truth.layers[d].cloudPoints);
      const index = readJson(`clouds/cloud-${d}/index.json`);
      expect(index.chunks.reduce((s, c) => s + c.points, 0)).toBe(h.points);
      expect(h.min[0]).toBeGreaterThan(truth.origin[0] - 50);
      expect(h.max[0]).toBeLessThan(truth.origin[0] + 50);
    }
    expect(truth.layers.d2.cloudPoints).toBeGreaterThan(truth.layers.d1.cloudPoints);
  });

  it('surface change: the elevation grids give the volumes in truth (within the noise)', async () => {
    const grids = {};
    for (const d of ['d1', 'd2']) {
      const meta = readJson(`sources/dsm-${d}.json`);
      const img = await sharp(read(`sources/${meta.file}`))
        .toColourspace('grey16')
        .raw({ depth: 'ushort' })
        .toBuffer();
      const v = new Uint16Array(img.buffer, img.byteOffset, meta.width * meta.height);
      grids[d] = { meta, h: Float64Array.from(v, (x) => meta.offset + x * meta.scale) };
    }
    const { meta } = grids.d1;
    const cell = meta.res * meta.res;
    for (const r of truth.changes.surface.regions) {
      let net = 0;
      for (let j = 0; j < meta.height; j++)
        for (let i = 0; i < meta.width; i++) {
          const x = -48 + (i + 0.5) * meta.res;
          const z = -48 + (j + 0.5) * meta.res;
          if (
            x < r.bounds.min[0] ||
            x > r.bounds.max[0] ||
            z < r.bounds.min[2] ||
            z > r.bounds.max[2]
          )
            continue;
          const dh = grids.d2.h[j * meta.width + i] - grids.d1.h[j * meta.width + i];
          if (Math.abs(dh) >= 0.1) net += dh * cell;
        }
      expect(Math.abs(net - r.volume.netM3), r.id).toBeLessThan(
        Math.max(1, Math.abs(r.volume.netM3) * 0.05),
      );
    }
    expect(truth.changes.surface.regions.map((r) => r.id)).toEqual([
      'C-01',
      'EX-01',
      'PL-01',
      'S-01',
      'SK-01 new place',
      'SK-01 old place',
    ]);
    expect(truth.changes.surface.regions.find((r) => r.id === 'S-01').volume.fillM3).toBeCloseTo(
      144,
      0,
    );
  });

  it('map vectors: the features of each date give the vector changes', () => {
    const ids = (d) => readJson(`vectors/site-${d}.geojson`).features.map((f) => f.id);
    expect(ids('d2').filter((x) => !ids('d1').includes(x))).toEqual(['TR-02']);
    const v = Object.fromEntries(truth.changes.vector.items.map((i) => [i.feature, i]));
    expect(v['TR-02'].verdict).toBe('added');
    expect(v['F-01']).toEqual({ feature: 'F-01', verdict: 'reshaped', maxOffsetM: 4 });
    expect(v['PD-01']).toEqual({ feature: 'PD-01', verdict: 'attributes', keys: ['surface'] });
    expect(truth.changes.vector.verdicts).toEqual({
      added: 1,
      attributes: 1,
      reshaped: 1,
      unchanged: 2,
    });
  });

  it('issues: five per date, no track written, one new, one resolved, one grown', () => {
    const issues = readJson('issues.json').issues;
    expect(issues.filter((i) => i.capture === 'd1')).toHaveLength(5);
    expect(issues.filter((i) => i.capture === 'd2')).toHaveLength(5);
    expect(issues.every((i) => i.track === undefined && i.resolvedIn === undefined)).toBe(true);
    expect(truth.changes.issue.verdicts).toEqual({ grown: 1, new: 1, resolved: 1, unchanged: 3 });
    const grown = truth.changes.issue.items.find((i) => i.verdict === 'grown');
    expect(grown.size.to / grown.size.from).toBeCloseTo(1.5, 5);
    // a resolved issue's place was in view on the later date (else it would be "not seen")
    expect(
      truth.changes.issue.items.find((i) => i.verdict === 'resolved').seenOnLater,
    ).toBeTruthy();
  });

  it('detections: the marker passes give the detection changes', () => {
    for (const d of ['d1', 'd2'])
      expect(readJson(`detections/markers-${d}.json`).detections).toHaveLength(
        truth.changes.detection.counts[d],
      );
    expect(truth.changes.detection.verdicts).toEqual({ new: 1, resolved: 1, unchanged: 2 });
  });

  it('videos: one frame per pose step, paired by pose', () => {
    for (const d of ['d1', 'd2']) {
      const mp4 = read(`video/flight-${d}.mp4`);
      const at = mp4.indexOf(Buffer.from('stsz'));
      expect(mp4.readUInt32BE(at + 12)).toBe(truth.counts.videoFrames);
    }
    const pairs = truth.changes.frame.video.pairs;
    expect(pairs).toHaveLength(truth.counts.videoFrames);
    expect(Math.max(...pairs.slice(1).map((p) => p.poseM))).toBeLessThan(2);
  });

  it('drawing: the DXF holds the entities and parts truth lists', () => {
    const doc = parseDxf(read(truth.modelling.drawing.file).toString('latin1'));
    for (const [type, n] of Object.entries(truth.modelling.drawing.entities))
      expect(doc.entities.filter((e) => e.type === type).length, type).toBe(n);
    expect(() => parseDxf(read(truth.modelling.drawing.broken.file).toString('latin1'))).toThrow();
    expect(
      parseDxf(read(truth.modelling.drawing.unitless.file).toString('latin1')).header.$INSUNITS,
    ).toBeUndefined();
    expect(truth.modelling.scan.counts).toEqual({ cylinder: 3, box: 3, extrusion: 1, pipe: 1 });
  });

  it('detector: the card matches the model file', () => {
    const card = readJson(truth.detector.card);
    expect(createHash('sha256').update(read(truth.detector.model)).digest('hex')).toBe(card.sha256);
  });
});

describe('the marker test detector on the demo photos', () => {
  /** Letterbox a photo into the 640 x 640 input (scale, grey padding below), as NCHW / 255. */
  async function input(file) {
    const meta = await sharp(file).metadata();
    const k = 640 / Math.max(meta.width, meta.height);
    const w = Math.round(meta.width * k);
    const h = Math.round(meta.height * k);
    const rgb = await sharp(file)
      .resize(w, h, { kernel: 'lanczos3' })
      .extend({ bottom: 640 - h, right: 640 - w, background: { r: 114, g: 114, b: 114 } })
      .removeAlpha()
      .raw()
      .toBuffer();
    const t = new Float32Array(3 * 640 * 640);
    for (let i = 0; i < 640 * 640; i++)
      for (let c = 0; c < 3; c++) t[c * 640 * 640 + i] = rgb[3 * i + c] / 255;
    return { tensor: { dims: [1, 3, 640, 640], data: t }, k };
  }

  it('finds every seeded marker in every photo, and nothing else', async () => {
    const model = decodeOnnx(read(truth.detector.model));
    let found = 0;
    for (const d of ['d1', 'd2'])
      for (const [photo, want] of Object.entries(truth.markers.photos[`photos-${d}`])) {
        const { tensor, k } = await input(join(root, 'photos', d, `${photo}.jpg`));
        const got = postprocessYoloV8(runOnnx(model, { images: tensor }).output0).map((x) =>
          x.box.map((v) => v / k),
        );
        expect(got.length, `${d} ${photo}`).toBe(want.length);
        for (const m of want) {
          // the rule truth.json states: centre inside the marker box, box inside it widened by 3 px
          const hit = got.find((g) => {
            const cx = (g[0] + g[2]) / 2;
            const cy = (g[1] + g[3]) / 2;
            const [x0, y0, x1, y1] = m.bbox;
            return (
              cx >= x0 &&
              cx <= x1 &&
              cy >= y0 &&
              cy <= y1 &&
              g[0] >= x0 - 3 &&
              g[1] >= y0 - 3 &&
              g[2] <= x1 + 3 &&
              g[3] <= y1 + 3
            );
          });
          expect(hit, `${d} ${photo} ${m.marker}`).toBeTruthy();
          found++;
        }
      }
    expect(found).toBe(truth.changes.detection.counts.d1 + truth.changes.detection.counts.d2);
  }, 120_000);
});
