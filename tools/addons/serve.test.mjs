import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installAddonArchive } from '../../apps/desktop/src/main/addons/install.ts';
import { buildTestAddons, findSam, serveAddons } from './serve.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-addons-serve-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha = (b) => createHash('sha256').update(b).digest('hex');

describe('pnpm addons:serve', () => {
  it('serves the catalogue on 127.0.0.1, and an add-on downloads, matches it and installs', async () => {
    const out = join(dir, 'out');
    // no data folder: Segmentation falls back to the synthetic segmenter
    const built = await buildTestAddons({ outDir: out, dataRoot: null, env: {} });
    expect(built.segmentation.real).toBe(false);
    expect(built.catalogue.addons.map((e) => e.manifest.id)).toEqual([
      'ground-classifier',
      'road-defects',
      'segmentation',
    ]);
    const server = await serveAddons({ dir: out, port: 0 });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/addons\/$/);
      const catalogue = await (await fetch(new URL('catalogue.json', server.url))).json();
      expect(catalogue).toEqual(built.catalogue);
      const road = catalogue.addons.find((e) => e.manifest.id === 'road-defects');
      const res = await fetch(new URL(road.archive.url, server.url));
      expect(res.status).toBe(200);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.length).toBe(road.archive.sizeBytes);
      expect(sha(bytes)).toBe(road.archive.sha256);
      // the app's own installer takes it, every file checked against addon.json
      const file = join(dir, 'road.aioaddon');
      await writeFile(file, bytes);
      const installed = await installAddonArchive(file, {
        dataRoot: join(dir, 'data'),
        expect: { id: 'road-defects', version: road.manifest.version },
        catalogueSha256: () => road.archive.sha256,
      });
      expect(installed).toEqual(expect.objectContaining({ ok: true }));
      // nothing outside the one folder
      expect((await fetch(new URL('../package.json', server.url))).status).toBe(404);
      expect((await fetch(`${server.url}..%2Fcatalogue.json`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('builds Segmentation from real SAM files when given them, and refuses an incomplete folder', async () => {
    const sam = join(dir, 'sam');
    await mkdir(sam);
    await expect(findSam({ sam, env: {} })).rejects.toThrow(/does not hold/);
    for (const f of ['encoder.onnx', 'decoder.onnx']) await writeFile(join(sam, f), f);
    await writeFile(
      join(sam, 'model.json'),
      JSON.stringify({ name: 'MobileSAM', licence: 'Apache-2.0' }),
    );
    expect(await findSam({ sam, env: {} })).toMatchObject({ dir: sam });
    // the newest pipeline pack in the data folder that carries models/sam
    const root = join(dir, 'root');
    for (const v of ['0.9.0', '0.33.0', '0.34.0'])
      await mkdir(join(root, 'runtime', `pipeline-pack-${v}`), { recursive: true });
    const packSam = join(root, 'runtime', 'pipeline-pack-0.33.0', 'models', 'sam');
    await mkdir(packSam, { recursive: true });
    for (const f of ['encoder.onnx', 'decoder.onnx', 'model.json'])
      await writeFile(join(packSam, f), '{}');
    expect(await findSam({ env: {}, dataRoot: root })).toMatchObject({ dir: packSam });
    expect(await findSam({ env: {}, dataRoot: join(dir, 'none') })).toMatchObject({ dir: null });
  });

  it('starts from the command line and prints the address', async () => {
    const script = fileURLToPath(new URL('./serve.mjs', import.meta.url));
    const out = join(dir, 'cli');
    const child = spawn(process.execPath, [script, '--port', '0', '--out', out], {
      env: { ...process.env, APPDATA: join(dir, 'no-app'), QUADRION_SAM_DIR: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const url = await new Promise((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error(`no address in time:\n${text}`)), 60_000);
        child.stdout.on('data', (c) => {
          text += String(c);
          const m = /Add-on address: (\S+)/.exec(text);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.stderr.on('data', (c) => {
          text += String(c);
        });
        child.on('exit', (code) => reject(new Error(`exited ${String(code)}:\n${text}`)));
      });
      const r = await fetch(new URL('catalogue.json', url));
      expect(r.status).toBe(200);
      expect((await r.json()).addons).toHaveLength(3);
    } finally {
      child.kill();
    }
  }, 90_000);
});
