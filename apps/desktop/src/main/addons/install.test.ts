import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAddonArchive, fakeAddonFiles, type FakeAddonOptions } from './addon.fakes';
import { parseCatalogue } from './catalogue';
import {
  addonDir,
  addonsRoot,
  installAddonArchive,
  installedAddon,
  installedAddonDirs,
  readInstalledAddon,
  readPointClassifier,
  removeAddon,
} from './install';

let base: string;
let dataRoot: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-addons-'));
  dataRoot = join(base, 'data');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function archiveOf(o: FakeAddonOptions): Promise<string> {
  const a = fakeAddonArchive(o);
  const path = join(base, a.fileName);
  await writeFile(path, a.bytes);
  return path;
}

const install = async (
  o: FakeAddonOptions,
  extra: Partial<Parameters<typeof installAddonArchive>[1]> = {},
) => installAddonArchive(await archiveOf(o), { dataRoot, ...extra });

const leftovers = async () =>
  (await readdir(addonsRoot(dataRoot)).catch(() => [])).filter((n) => n.startsWith('.'));

describe('installAddonArchive', () => {
  it('installs each kind and finds it again', async () => {
    const phases: string[] = [];
    const r = await install(
      { id: 'road-defects', kind: 'detector' },
      { onProgress: (p) => phases.push(p.phase) },
    );
    expect(r).toMatchObject({ ok: true, manifest: { id: 'road-defects', version: '1.0.0' } });
    expect(phases).toContain('unpack');
    expect(phases.at(-1)).toBe('done');
    expect((await readdir(addonDir(dataRoot, 'road-defects'))).sort()).toEqual([
      'addon.json',
      'model.json',
      'model.onnx',
    ]);
    expect(await install({ id: 'segmentation', kind: 'segmenter' })).toMatchObject({ ok: true });
    expect(await install({ id: 'ground-classifier', kind: 'point-classifier' })).toMatchObject({
      ok: true,
    });
    expect((await installedAddon(dataRoot, 'segmenter'))?.dir).toBe(
      addonDir(dataRoot, 'segmentation'),
    );
    expect(await installedAddonDirs(dataRoot, 'detector')).toEqual([
      addonDir(dataRoot, 'road-defects'),
    ]);
    expect((await readPointClassifier(dataRoot))?.smrf.cell).toBe(2);
    expect(await leftovers()).toEqual([]);
  });

  it('replaces an older version, and keeps nothing of it', async () => {
    await install({
      id: 'road-defects',
      kind: 'detector',
      version: '1.0.0',
      files: { ...fakeAddonFiles('detector'), 'notes.txt': 'old' },
    });
    expect(await install({ id: 'road-defects', kind: 'detector', version: '1.1.0' })).toMatchObject(
      { ok: true },
    );
    expect((await readInstalledAddon(dataRoot, 'road-defects'))?.manifest.version).toBe('1.1.0');
    expect(await readdir(addonDir(dataRoot, 'road-defects'))).not.toContain('notes.txt');
    expect(await leftovers()).toEqual([]);
  });

  it('refuses a file whose size does not match addon.json', async () => {
    const r = await install({
      id: 'road-defects',
      kind: 'detector',
      manifest: (m) => {
        const f = m.files[0];
        if (f) f.sizeBytes += 1;
        m.sizeBytes += 1;
      },
    });
    expect(r).toMatchObject({ ok: false, code: 'refused' });
    if (!r.ok) expect(r.error).toMatch(/is \d+ bytes, its addon.json says \d+/);
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
    expect(await leftovers()).toEqual([]);
  });

  it('refuses a tampered file inside the archive', async () => {
    const r = await install({
      id: 'ground-classifier',
      kind: 'point-classifier',
      override: {
        'classifier.json': JSON.stringify({
          schema: 'aio.point-classifier/1',
          method: 'smrf',
          smrf: { cell: 9, slope: 0.2, window: 16, threshold: 0.45, scalar: 1.2 },
        }).padEnd(fakeAddonFiles('point-classifier')['classifier.json']?.length ?? 0, ' '),
      },
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/does not match its addon.json \(SHA-256\)/);
  });

  it('refuses an entry the manifest does not list, and one it lacks', async () => {
    const extra = await install({
      id: 'road-defects',
      kind: 'detector',
      override: { 'extra.bin': 'x' },
    });
    if (extra.ok) throw new Error('installed');
    expect(extra.error).toMatch(/extra.bin, which its addon.json does not list/);
    const files = fakeAddonFiles('detector');
    const lacks = await install({
      id: 'road-defects',
      kind: 'detector',
      files,
      manifest: (m) => {
        m.files.push({ path: 'labels.txt', sizeBytes: 0, sha256: 'a'.repeat(64) });
      },
    });
    if (lacks.ok) throw new Error('installed');
    expect(lacks.error).toMatch(/lacks labels.txt/);
  });

  it('refuses ".." paths, absolute paths and links', async () => {
    for (const [entry, why] of [
      [{ path: '../evil.txt', data: 'x' }, /climbs out/],
      [{ path: '/abs.txt', data: 'x' }, /absolute path/],
      [{ path: 'link', type: 'symlink' as const, linkpath: 'model.onnx' }, /a link/],
    ] as const) {
      const r = await install({ id: 'road-defects', kind: 'detector', extraEntries: [entry] });
      if (r.ok) throw new Error('installed');
      expect(r.error).toMatch(why);
    }
    expect(await readdir(base)).not.toContain('evil.txt');
    expect(await leftovers()).toEqual([]);
  });

  it('checks what each kind needs', async () => {
    const onnxCard = fakeAddonFiles('detector');
    const card = JSON.parse(onnxCard['model.json']?.toString() ?? '{}') as Record<string, unknown>;
    const wrongSha = await install({
      id: 'road-defects',
      kind: 'detector',
      files: { ...onnxCard, 'model.json': JSON.stringify({ ...card, sha256: 'b'.repeat(64) }) },
    });
    if (wrongSha.ok) throw new Error('installed');
    expect(wrongSha.error).toMatch(/does not match its model card/);

    const seg = fakeAddonFiles('segmenter');
    Reflect.deleteProperty(seg, 'decoder.onnx');
    const noDecoder = await install({ id: 'segmentation', kind: 'segmenter', files: seg });
    if (noDecoder.ok) throw new Error('installed');
    expect(noDecoder.error).toMatch(/lacks decoder.onnx/);

    const badClassifier = await install({
      id: 'ground-classifier',
      kind: 'point-classifier',
      files: { 'classifier.json': JSON.stringify({ schema: 'aio.point-classifier/1' }) },
    });
    if (badClassifier.ok) throw new Error('installed');
    expect(badClassifier.error).toMatch(/classifier.json in the add-on is not valid/);
  });

  it('refuses a file that is not an add-on, and too little disk space', async () => {
    const junk = join(base, 'junk.aioaddon');
    await writeFile(junk, 'not a tar');
    const r = await installAddonArchive(junk, { dataRoot });
    expect(r).toMatchObject({ ok: false });
    const full = await install(
      { id: 'road-defects', kind: 'detector' },
      { freeBytes: () => Promise.resolve(1024) },
    );
    if (full.ok) throw new Error('installed');
    expect(full.error).toMatch(/needs \d+ MB free/);
  });

  it('compares the whole archive with the catalogue when it lists that version', async () => {
    const r = await install(
      { id: 'road-defects', kind: 'detector' },
      {
        catalogueSha256: (id, v) =>
          id === 'road-defects' && v === '1.0.0' ? 'c'.repeat(64) : null,
      },
    );
    if (r.ok) throw new Error('installed');
    expect(r.error).toMatch(/not the .* the add-on catalogue lists/);
    expect(
      await install({ id: 'road-defects', kind: 'detector' }, { catalogueSha256: () => null }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a download that is another add-on than the catalogue said', async () => {
    const r = await install(
      { id: 'road-defects', kind: 'detector', version: '1.0.0' },
      { expect: { id: 'road-defects', version: '2.0.0' } },
    );
    if (r.ok) throw new Error('installed');
    expect(r.error).toMatch(/not road-defects 2.0.0/);
  });

  it('stops on cancel', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await install({ id: 'road-defects', kind: 'detector' }, { signal: ctl.signal });
    expect(r).toMatchObject({ ok: false, code: 'cancelled' });
  });
});

describe('tools/addons/build-addon.mjs', () => {
  it('builds an archive this installer takes', async () => {
    const src = join(base, 'src');
    await mkdir(src, { recursive: true });
    for (const [name, data] of Object.entries(fakeAddonFiles('segmenter')))
      await writeFile(join(src, name), data);
    const info = join(base, 'info.json');
    await writeFile(
      info,
      JSON.stringify({
        id: 'segmentation',
        name: 'Segmentation',
        version: '1.2.0',
        kind: 'segmenter',
        licence: 'MIT',
        source: 'test',
      }),
    );
    const tool = join(import.meta.dirname, '..', '..', '..', '..', '..', 'tools', 'addons');
    execFileSync(process.execPath, [
      join(tool, 'build-addon.mjs'),
      src,
      '--info',
      info,
      '--out',
      base,
      '--catalogue',
      join(base, 'catalogue.json'),
    ]);
    const r = await installAddonArchive(join(base, 'segmentation-1.2.0.aioaddon'), {
      dataRoot,
      catalogueSha256: (id, v) => {
        const cat = parseCatalogue(JSON.parse(readFileSync(join(base, 'catalogue.json'), 'utf8')));
        if (!cat.ok) throw new Error(cat.error);
        return (
          cat.catalogue.addons.find((a) => a.manifest.id === id && a.manifest.version === v)
            ?.archive.sha256 ?? null
        );
      },
    });
    expect(r).toMatchObject({ ok: true, manifest: { id: 'segmentation', version: '1.2.0' } });
  });
});

describe('installed add-ons', () => {
  it('sees a changed file as damaged, and removes an add-on', async () => {
    await install({ id: 'road-defects', kind: 'detector' });
    await writeFile(join(addonDir(dataRoot, 'road-defects'), 'model.onnx'), 'short');
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
    expect(await removeAddon(dataRoot, 'road-defects')).toEqual({ ok: true });
    expect(await readdir(addonsRoot(dataRoot))).toEqual([]);
    expect(await removeAddon(dataRoot, 'road-defects')).toMatchObject({ ok: false });
  });

  it('reads the manifest it wrote', async () => {
    await install({ id: 'ground-classifier', kind: 'point-classifier' });
    const raw = JSON.parse(
      await readFile(join(addonDir(dataRoot, 'ground-classifier'), 'addon.json'), 'utf8'),
    ) as { id: string };
    expect(raw.id).toBe('ground-classifier');
  });
});
