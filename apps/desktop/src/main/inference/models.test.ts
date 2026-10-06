import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markerCard, markerDetectorOnnx } from './fixtures/markerDetector';
import {
  importModel,
  listModels,
  locateModelFiles,
  modelIdFor,
  parseCard,
  removeModel,
  type ModelDirs,
} from './models';

let base: string;
let dirs: ModelDirs;
const okProbe = () => Promise.resolve(null);

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-models-'));
  dirs = {
    user: join(base, 'user', 'models', 'detect'),
    pack: join(base, 'pack', 'models', 'detect'),
  };
  await mkdir(dirs.user, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function source(over: Record<string, unknown> = {}, name = 'src') {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  const onnx = markerDetectorOnnx();
  await writeFile(join(dir, 'model.onnx'), onnx);
  await writeFile(join(dir, 'model.json'), JSON.stringify({ ...markerCard(onnx), ...over }));
  return dir;
}

describe('model cards', () => {
  it('names the field of the first problem', () => {
    const card = markerCard(markerDetectorOnnx());
    expect(parseCard(card).ok).toBe(true);
    expect(parseCard({ ...card, classes: [] })).toEqual({
      ok: false,
      error: expect.stringContaining('The model card is not valid (classes)') as string,
    });
  });

  it('makes a folder id from name and version, unique', () => {
    const card = markerCard(markerDetectorOnnx());
    expect(modelIdFor(card, new Set())).toBe('marker-test-detector-1.0.0');
    expect(modelIdFor(card, new Set(['marker-test-detector-1.0.0']))).toBe(
      'marker-test-detector-1.0.0-2',
    );
  });
});

describe('finding the model files', () => {
  it('takes a folder, the .onnx or the card', async () => {
    const dir = await source();
    for (const p of [dir, join(dir, 'model.onnx'), join(dir, 'model.json')])
      expect(await locateModelFiles(p)).toEqual({
        ok: true,
        onnx: join(dir, 'model.onnx'),
        card: join(dir, 'model.json'),
      });
  });

  it('refuses a model without a card', async () => {
    const dir = join(base, 'bare');
    await mkdir(dir);
    await writeFile(join(dir, 'detector.onnx'), markerDetectorOnnx());
    expect(await locateModelFiles(join(dir, 'detector.onnx'))).toEqual({
      ok: false,
      error:
        "detector.onnx has no model card (model.json, aio.detector/1). A card with the model's licence is required to import it.",
    });
  });
});

describe('import, list and remove', () => {
  it('copies a checked model into the user folder and lists it', async () => {
    const r = await importModel({ path: await source(), acceptLicence: true }, dirs, okProbe);
    expect(r).toMatchObject({
      ok: true,
      model: { id: 'marker-test-detector-1.0.0', where: 'user' },
    });
    expect(await readdir(join(dirs.user, 'marker-test-detector-1.0.0'))).toEqual([
      'model.json',
      'model.onnx',
    ]);
    const list = await listModels(dirs);
    expect(list.map((m) => [m.info.id, m.info.card.licence, m.info.where])).toEqual([
      ['marker-test-detector-1.0.0', 'MIT', 'user'],
    ]);
    // importing the same file again gives the same model
    expect(
      await importModel({ path: await source({}, 'again'), acceptLicence: true }, dirs, okProbe),
    ).toMatchObject({
      ok: true,
      model: { id: 'marker-test-detector-1.0.0' },
    });
    expect(await readdir(dirs.user)).toEqual(['marker-test-detector-1.0.0']);
  });

  it('needs the licence confirmed, and refuses copyleft weights', async () => {
    expect(
      await importModel({ path: await source(), acceptLicence: false }, dirs, okProbe),
    ).toEqual({
      ok: false,
      error:
        'Confirm that you may use "Marker test detector" under its licence (MIT) to import it.',
    });
    const agpl = await importModel(
      { path: await source({ licence: 'AGPL-3.0-only' }, 'agpl'), acceptLicence: true },
      dirs,
      okProbe,
    );
    expect(agpl).toMatchObject({
      ok: false,
      error: expect.stringContaining('AGPL-3.0-only is not allowed') as string,
    });
  });

  it('refuses a file that does not match its card', async () => {
    const r = await importModel(
      { path: await source({ sha256: 'b'.repeat(64) }), acceptLicence: true },
      dirs,
      okProbe,
    );
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining('does not match its card: SHA-256') as string,
    });
    expect(await readdir(dirs.user)).toEqual([]);
  });

  it("passes on the probe's refusal and copies nothing", async () => {
    const r = await importModel({ path: await source(), acceptLicence: true }, dirs, () =>
      Promise.resolve('The model could not be loaded: bad protobuf'),
    );
    expect(r).toEqual({ ok: false, error: 'The model could not be loaded: bad protobuf' });
    expect(await readdir(dirs.user)).toEqual([]);
  });

  it("lists pack models after the person's, and removes only the person's", async () => {
    await importModel({ path: await source(), acceptLicence: true }, dirs, okProbe);
    const packDir = join(dirs.pack ?? '', 'pack-markers');
    await mkdir(packDir, { recursive: true });
    const onnx = markerDetectorOnnx({ size: 160 });
    await writeFile(join(packDir, 'model.onnx'), onnx);
    await writeFile(join(packDir, 'model.json'), JSON.stringify(markerCard(onnx, {}, 160)));
    expect((await listModels(dirs)).map((m) => `${m.info.id}:${m.info.where}`)).toEqual([
      'marker-test-detector-1.0.0:user',
      'pack-markers:pack',
    ]);
    expect(await removeModel(dirs, 'pack-markers')).toEqual({
      ok: false,
      error: '"pack-markers" comes with the pipeline pack and cannot be removed here.',
    });
    expect(await removeModel(dirs, 'marker-test-detector-1.0.0')).toEqual({ ok: true });
    expect(await removeModel(dirs, 'nope')).toEqual({
      ok: false,
      error: 'There is no detector model "nope".',
    });
  });
});
