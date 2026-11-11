import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAddon, checkInfo, mergeCatalogue, packAddon } from './build-addon.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-build-addon-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const info = {
  id: 'ground-classifier',
  name: 'Ground classifier',
  version: '1.0.0',
  kind: 'point-classifier',
  licence: 'MIT',
  source: 'PDAL SMRF defaults',
  minPipelinePack: '0.35.0',
};

/** The entries of a gzipped ustar archive: `{ path, data }`, in order. */
function readTar(gz) {
  const tar = gunzipSync(gz);
  const out = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (from, len) =>
      h
        .subarray(from, from + len)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const name = str(0, 100);
    const prefix = str(345, 155);
    const size = Number.parseInt(str(124, 12), 8);
    out.push({
      path: prefix ? `${prefix}/${name}` : name,
      data: tar.subarray(at + 512, at + 512 + size),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('build-addon', () => {
  it('packs a folder with addon.json first and every file listed with size and SHA-256', async () => {
    const src = join(dir, 'src');
    await mkdir(join(src, 'extra'), { recursive: true });
    const classifier = JSON.stringify({ schema: 'aio.point-classifier/1', method: 'smrf' });
    await writeFile(join(src, 'classifier.json'), classifier);
    await writeFile(join(src, 'extra', 'notes.txt'), 'notes');
    await writeFile(join(src, 'addon.json'), 'ignored');
    const built = await buildAddon({ dir: src, info, outDir: join(dir, 'out') });
    expect(built.archive).toBe(join(dir, 'out', 'ground-classifier-1.0.0.aioaddon'));
    const bytes = await readFile(built.archive);
    expect(built.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(built.sizeBytes).toBe(bytes.length);
    const entries = readTar(bytes);
    expect(entries.map((e) => e.path)).toEqual([
      'addon.json',
      'classifier.json',
      'extra/notes.txt',
    ]);
    const manifest = JSON.parse(entries[0].data.toString('utf8'));
    expect(manifest).toMatchObject({
      schema: 'aio.addon/1',
      id: 'ground-classifier',
      kind: 'point-classifier',
      minPipelinePack: '0.35.0',
      sizeBytes: classifier.length + 5,
    });
    expect(manifest.files[0]).toEqual({
      path: 'classifier.json',
      sizeBytes: classifier.length,
      sha256: createHash('sha256').update(classifier).digest('hex'),
    });
    expect(built.entry('https://example.com/a/x.aioaddon').archive).toEqual({
      url: 'https://example.com/a/x.aioaddon',
      sizeBytes: bytes.length,
      sha256: built.sha256,
    });
  });

  it('refuses bad facts and a kind without its files', async () => {
    expect(() => checkInfo({ ...info, id: 'Bad Id' })).toThrow(/not an add-on id/);
    expect(() => checkInfo({ ...info, version: '1.0' })).toThrow(/version/);
    expect(() => checkInfo({ ...info, kind: 'other' })).toThrow(/not one of/);
    await expect(
      packAddon({
        info: { ...info, kind: 'detector' },
        files: [{ path: 'model.onnx', data: 'x' }],
        outDir: dir,
      }),
    ).rejects.toThrow(/needs model.json/);
  });

  it('merges an entry into a catalogue, replacing the same id', () => {
    const entry = (id, version) => ({
      manifest: { id, version },
      archive: { url: `${id}.aioaddon`, sizeBytes: 1, sha256: 'a'.repeat(64) },
    });
    const one = mergeCatalogue(null, entry('segmentation', '1.0.0'));
    const two = mergeCatalogue(one, entry('road-defects', '1.0.0'));
    const three = mergeCatalogue(two, entry('segmentation', '1.1.0'));
    expect(three.schema).toBe('aio.addon-catalogue/1');
    expect(three.addons.map((a) => `${a.manifest.id}@${a.manifest.version}`)).toEqual([
      'road-defects@1.0.0',
      'segmentation@1.1.0',
    ]);
  });
});
