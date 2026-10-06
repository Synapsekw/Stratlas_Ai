import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plotPlanDxf } from './change-drawing.mjs';
import { checkFolder } from './check-no-client-data.mjs';
import { truthCoords } from './check-m8.mjs';
import { Part, box } from './geometry.mjs';
import { writeGlb } from './glb.mjs';
import { buildMarkerDetector } from './onnx-test-model.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'demo-check-m8-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A clean project in open desert (UTM 31N) holding one extra file. */
async function project(file, content) {
  const root = join(dir, 'demo', 'p');
  await mkdir(join(root, 'sources'), { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      id: 'p',
      name: 'Demo change site',
      crs: { epsg: 32631 },
      origin: [301705, 2575078, 392],
    }),
  );
  if (file) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return checkFolder(join(dir, 'demo'), { maxMb: 150 });
}

const glb = (extras) => {
  const p = new Part('T-1', 'T-1', 'Area');
  box(p, [0, 0.5, 0], [1, 1, 1], [0.5, 0.5, 0.5]);
  const b = writeGlb([p], { root: 'Root', generator: 'Stratlas demo builder' });
  if (!extras) return b;
  // put extras into the JSON chunk the way an exporter would
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.toString('utf8', 20, 20 + len));
  j.nodes[0].extras = extras;
  let text = Buffer.from(JSON.stringify(j));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = b.subarray(20 + len);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + bin.length, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, text, bin]);
};

describe('client data check: M8 files', () => {
  it('passes the clean plot plan, detector and model', async () => {
    expect((await project('sources/plan.dxf', plotPlanDxf())).findings).toEqual([]);
    expect((await project('sources/model.onnx', buildMarkerDetector().onnx)).findings).toEqual([]);
    expect((await project('models/m.glb', glb({ survey: 'synthetic' }))).findings).toEqual([]);
  });

  it('finds a client name planted in DXF text', async () => {
    const dxf = plotPlanDxf().replace('T-201', 'Masafi T-201');
    const r = await project('sources/plan.dxf', dxf);
    expect(r.findings.join('\n')).toMatch(/plan\.dxf.*Masafi/);
  });

  it('finds a client name planted in the ONNX doc string', async () => {
    const { onnx } = buildMarkerDetector({ doc: 'Trained on KNPC tank photos' });
    const r = await project('sources/model.onnx', onnx);
    expect(r.findings.join('\n')).toMatch(/model\.onnx.*KNPC/);
  });

  it('finds a client name planted in GLB extras', async () => {
    const r = await project('models/m.glb', glb({ site: 'Al-Zour terminal' }));
    expect(r.findings.join('\n')).toMatch(/m\.glb.*Al-Zour/);
  });

  it('places the coordinates of truth.json', async () => {
    const truth = {
      schema: 'aio.truth/1',
      markers: { world: [{ id: 'M1', lonLat: [1.06, 23.27] }] },
      changes: {
        raster: {
          expected: [
            {
              outline: [
                [1.06, 23.27],
                [1.07, 23.27],
                [1.07, 23.28],
              ],
            },
          ],
        },
      },
    };
    expect(truthCoords(truth)).toHaveLength(4);
    expect((await project('truth.json', JSON.stringify(truth))).findings).toEqual([]);
    // near a real site (the HCl tank, UTM 39N): reported
    truth.markers.world[0].lonLat = [48.08, 29.08];
    const r = await project('truth.json', JSON.stringify(truth));
    expect(r.findings.join('\n')).toMatch(/truth\.json.*km from HCl tank/);
  });
});
