import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DetectorModelCard } from '../../packages/schema/src/inference.ts';
import { checkFolder } from './check-no-client-data.mjs';
import { parseDxf } from './dxf.mjs';
import { writeM8Fixtures } from './m8-fixtures.mjs';
import { decodeOnnx } from './onnx-test-model.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'm8-fixtures-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('M8 fixtures', () => {
  it('writes the detector and its twins, the marker image and the drawings', async () => {
    const files = await writeM8Fixtures(dir);
    expect(Object.keys(files)).toHaveLength(14);
    const read = (f) => readFileSync(join(dir, f));
    const card = JSON.parse(read('detector/model.json'));
    expect(DetectorModelCard.safeParse(card).success).toBe(true);
    expect(createHash('sha256').update(read('detector/model.onnx')).digest('hex')).toBe(
      card.sha256,
    );
    // the corrupt twin has a matching card, so only reading the model can refuse it
    const bad = JSON.parse(read('detector-corrupt/model.json'));
    expect(createHash('sha256').update(read('detector-corrupt/model.onnx')).digest('hex')).toBe(
      bad.sha256,
    );
    expect(() => decodeOnnx(read('detector-corrupt/model.onnx'))).toThrow();
    expect(decodeOnnx(read('detector-wrong-layout/model.onnx')).graph.outputs[0].shape).toEqual([
      1, 3, 361,
    ]);
    const img = await sharp(read('markers.png')).metadata();
    expect([img.width, img.height]).toEqual([640, 640]);
    expect(JSON.parse(read('markers.json')).boxes).toHaveLength(4);
    expect(parseDxf(read('plot-plan.dxf').toString('latin1')).entities.length).toBeGreaterThan(20);
    expect(JSON.parse(read('plot-plan.json')).control).toHaveLength(4);
  });

  it('writes the same bytes every time', async () => {
    await writeM8Fixtures(join(dir, 'a'));
    await writeM8Fixtures(join(dir, 'b'));
    for (const f of ['detector/model.onnx', 'markers.png', 'plot-plan.dxf', 'plot-plan.png'])
      expect(readFileSync(join(dir, 'a', f)).equals(readFileSync(join(dir, 'b', f)))).toBe(true);
  });

  it('carries no client data (no coordinates, so only the words are checked)', async () => {
    await writeM8Fixtures(dir);
    const r = checkFolder(dir, {});
    expect(r.findings.filter((f) => !f.startsWith('no coordinates'))).toEqual([]);
  });
});
