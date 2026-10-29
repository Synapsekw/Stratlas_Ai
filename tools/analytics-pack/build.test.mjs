import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsPackManifest } from '../../packages/schema/src/analytics.ts';
import { keygen, verifyBytes } from '../release/ed25519.mjs';
import { APP_RANGE, buildAnalyticsPack, pinnedDownload } from './build.mjs';

const APP_VERSION = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../apps/desktop/package.json'), 'utf8'),
).version;
const sha = (s) => createHash('sha256').update(s).digest('hex');

const BODIES = {
  'rt.zip': 'runtime-zip',
  'cu.zip': 'cudart-zip',
  'm.gguf': 'model-gguf',
  'p.gguf': 'mmproj-gguf',
  'rt-LICENSE': 'llama licence text',
  'qw-LICENSE': 'qwen licence text',
};
const pin = (name, extra = {}) => ({
  url: `https://example.test/${name}`,
  sha256: sha(BODIES[name]),
  size: BODIES[name].length,
  ...extra,
});
const LOCK = {
  runtime: {
    name: 'llama.cpp',
    release: 'b1',
    assets: [pin('rt.zip'), pin('cu.zip')],
    executable: 'llama/llama-server.exe',
  },
  model: {
    id: 'qwen-test',
    licence: 'Apache-2.0',
    gguf: pin('m.gguf', { file: 'model/m.gguf' }),
    mmproj: pin('p.gguf', { file: 'model/p.gguf' }),
  },
  licences: [
    pin('rt-LICENSE', { file: 'licences/llama.cpp-LICENSE.txt' }),
    pin('qw-LICENSE', { file: 'licences/Qwen3.5-9B-LICENSE.txt' }),
  ],
};

let root;
let calls;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'analytics-pack-'));
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fetchTo = (url, dest) => {
  calls.push(url);
  const body = BODIES[url.split('/').pop()] ?? 'wrong';
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  return Promise.resolve();
};
/** A zip stand-in: the "zip" is unpacked to one file named after it. */
const unzip = (zip, dest) => {
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, zip.endsWith('-rt.zip') ? 'llama-server.exe' : 'cudart.dll'), 'bin');
};

function detectorsDir() {
  const d = join(root, 'detectors-src');
  const one = join(d, 'pole', 'pole-leaning');
  mkdirSync(one, { recursive: true });
  writeFileSync(
    join(one, 'detector.json'),
    JSON.stringify({ id: 'pole-leaning', version: 3, status: 'experimental' }),
  );
  writeFileSync(join(one, 'samples.txt'), 'x');
  return d;
}

const build = (o = {}) =>
  buildAnalyticsPack({
    out: join(root, 'out'),
    cache: join(root, 'cache'),
    lock: LOCK,
    version: '0.2.0',
    detectorsDir: detectorsDir(),
    fetchTo,
    unzip,
    archive: false,
    createdAt: '2026-10-21T00:00:00.000Z',
    // never the key of whoever runs the tests
    signingKey: null,
    ...o,
  });

describe('analytics pack build', () => {
  it('pinned download refuses a wrong sha256', async () => {
    const cache = join(root, 'cache');
    await expect(
      pinnedDownload({
        pin: { ...pin('rt.zip'), sha256: sha('something else') },
        cache,
        fetchTo,
      }),
    ).rejects.toThrow(/SHA-256/);
    // nothing wrong is left in the cache
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });

  it('pinned download uses the cache the second time', async () => {
    const cache = join(root, 'cache');
    await pinnedDownload({ pin: pin('rt.zip'), cache, fetchTo });
    await pinnedDownload({ pin: pin('rt.zip'), cache, fetchTo });
    expect(calls).toHaveLength(1);
  });

  it('manifest lists every file with size and sha256', async () => {
    const { packDir } = await build();
    const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
    expect(AnalyticsPackManifest.parse(manifest)).toBeTruthy();
    expect(manifest.appRange).toBe(APP_RANGE);
    expect(APP_RANGE).toBe(`>=${APP_VERSION} <2.0.0`);
    expect(manifest.model.sha256).toBe(sha(BODIES['m.gguf']));
    const onDisk = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else onDisk.push(p.slice(packDir.length + 1).replaceAll(sep, '/'));
      }
    };
    walk(packDir);
    expect(Object.keys(manifest.files).sort()).toEqual(
      onDisk.filter((f) => f !== 'manifest.json').sort(),
    );
    expect(manifest.files['model/m.gguf']).toEqual({
      size: BODIES['m.gguf'].length,
      sha256: sha(BODIES['m.gguf']),
    });
    expect(manifest.files['llama/llama-server.exe'].sha256).toBe(sha('bin'));
  });

  it('signs the manifest with the publisher key, and leaves it unsigned without one', async () => {
    const { privatePem, publicKey } = keygen();
    const keyFile = join(root, 'pack-key.pem');
    writeFileSync(keyFile, privatePem);
    const { packDir } = await build({ signingKey: keyFile });
    const sig = readFileSync(join(packDir, 'manifest.sig'), 'utf8').trim();
    expect(verifyBytes(publicKey, readFileSync(join(packDir, 'manifest.json')), sig)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
    expect(manifest.files['manifest.sig']).toBeUndefined();

    const unsigned = await build();
    expect(existsSync(join(unsigned.packDir, 'manifest.sig'))).toBe(false);
  });

  it('the pack carries both licence texts', async () => {
    const { packDir } = await build();
    const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
    for (const [file, body] of [
      ['licences/llama.cpp-LICENSE.txt', BODIES['rt-LICENSE']],
      ['licences/Qwen3.5-9B-LICENSE.txt', BODIES['qw-LICENSE']],
    ]) {
      expect(readFileSync(join(packDir, file), 'utf8')).toBe(body);
      expect(manifest.files[file]).toEqual({ size: body.length, sha256: sha(body) });
    }
  });

  it('the shipped pins are pack 0.2.0 with Qwen3.5-9B', () => {
    const lock = JSON.parse(readFileSync(join(import.meta.dirname, 'lock.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('0.2.0');
    expect(lock.model.id).toBe('qwen3.5-9b-q4_k_m');
    expect(lock.model.gguf.file).toBe('model/qwen3.5-9b-q4_k_m.gguf');
    expect(lock.model.mmproj.file).toBe('model/mmproj-qwen3.5-9b-f16.gguf');
    expect(lock.model.gguf.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    expect(lock.licences.map((l) => l.file)).toContain('licences/Qwen3.5-9B-LICENSE.txt');
    expect(APP_RANGE.startsWith(`>=${APP_VERSION} `)).toBe(true);
  });

  it('--no-model still carries the licence texts', async () => {
    const { packDir } = await build({ noModel: true });
    expect(existsSync(join(packDir, 'licences', 'llama.cpp-LICENSE.txt'))).toBe(true);
  });

  it('detectors folder copied and listed in manifest.detectors', async () => {
    const { packDir } = await build();
    const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
    expect(manifest.detectors).toEqual([
      { assetType: 'pole', id: 'pole-leaning', version: 3, status: 'experimental' },
    ]);
    expect(existsSync(join(packDir, 'detectors', 'pole', 'pole-leaning', 'samples.txt'))).toBe(
      true,
    );
    expect(manifest.files['detectors/pole/pole-leaning/detector.json']).toBeDefined();
  });

  it('--no-model leaves model out and marks manifest.model.sha256 "none"', async () => {
    const { packDir } = await build({ noModel: true });
    const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
    expect(manifest.model.sha256).toBe('none');
    expect(AnalyticsPackManifest.safeParse(manifest).success).toBe(false);
    expect(existsSync(join(packDir, 'model'))).toBe(false);
    expect(Object.keys(manifest.files).some((f) => f.startsWith('model/'))).toBe(false);
    expect(calls.some((u) => u.endsWith('.gguf'))).toBe(false);
  });
});
