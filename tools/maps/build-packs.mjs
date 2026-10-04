#!/usr/bin/env node
// Offline map pack builder. Runs online ONCE on a development machine; the app itself never
// touches the network. It:
//   1. fetches the go-pmtiles CLI (Windows/Linux/macOS release binary) into tools/maps/bin/
//   2. finds the newest Protomaps daily planet build
//   3. extracts the configured packs into <dataRoot>/packs/<id>.pmtiles + <id>.json (MapPackInfo)
//   4. fetches the large style assets (glyph PBFs, sprite PNGs) into packages/maps/assets/
//
// Usage:
//   node tools/maps/build-packs.mjs                 assets + kuwait, world, gcc
//   node tools/maps/build-packs.mjs kuwait world    only the named packs (plus assets)
//   node tools/maps/build-packs.mjs --assets-only   only the style assets
//   node tools/maps/build-packs.mjs --no-assets     packs only
//   node tools/maps/build-packs.mjs --build=20261003 pin a planet build
//   node tools/maps/build-packs.mjs --tool-only     only fetch the pmtiles CLI (bundled into the
//                                                   app by electron-builder extraResources)
//
// Env: STRATLAS_DATA overrides the data root (default E:\Stratlas Data).

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_FONTSTACKS, ASSET_GLYPH_RANGES, ASSET_SPRITES, PACKS } from './packs.config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const binDir = join(here, 'bin');
const assetsDir = join(repo, 'packages', 'maps', 'assets');
const dataRoot = process.env.STRATLAS_DATA ?? 'E:\\Stratlas Data';
const packsDir = join(dataRoot, 'packs');

const BUILDS_INDEX = 'https://build-metadata.protomaps.dev/builds.json';
const BUILD_BASE = 'https://build.protomaps.com/';
const PMTILES_RELEASE = 'https://api.github.com/repos/protomaps/go-pmtiles/releases/latest';
const ASSETS_BASE = 'https://raw.githubusercontent.com/protomaps/basemaps-assets/main/';

const log = (msg) => process.stdout.write(`[maps] ${msg}\n`);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'stratlas-build-packs' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function download(url, dest, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'stratlas-build-packs' } });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(dest), { recursive: true });
      await writeFile(dest, body);
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

/** Ensures the pmtiles CLI exists in tools/maps/bin and returns its path. */
async function ensurePmtiles() {
  const exe = join(binDir, process.platform === 'win32' ? 'pmtiles.exe' : 'pmtiles');
  if (existsSync(exe)) return exe;
  const release = await getJson(PMTILES_RELEASE);
  const os = { win32: 'Windows', linux: 'Linux', darwin: 'Darwin' }[process.platform];
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const asset = release.assets.find(
    (a) => a.name.includes(`_${os}_${arch}`) || a.name.includes(`-${os}_${arch}`),
  );
  if (!asset) throw new Error(`No go-pmtiles ${os} ${arch} asset in ${release.tag_name}`);
  log(`downloading ${asset.name} (${release.tag_name})`);
  const archive = join(binDir, asset.name);
  await download(asset.browser_download_url, archive);
  // bsdtar ships with Windows 10+ and reads zip as well as tar.gz. Call it by full path so a GNU
  // tar from Git Bash (which cannot read zip and treats "E:" as a host) is not picked up.
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  execFileSync(tar, ['-xf', asset.name], { cwd: binDir, stdio: 'inherit' });
  rmSync(archive);
  // Keep only the binary (the archive's README/LICENSE would trip repo-wide format checks).
  for (const f of readdirSync(binDir)) if (join(binDir, f) !== exe) rmSync(join(binDir, f));
  if (!existsSync(exe)) throw new Error(`pmtiles binary not found after extracting ${asset.name}`);
  return exe;
}

/** Returns the newest planet build key, e.g. "20261003". */
async function latestBuild() {
  const builds = await getJson(BUILDS_INDEX);
  const keys = builds
    .map((b) => b.key)
    .filter((k) => /^\d{8}\.pmtiles$/.test(k))
    .sort();
  for (const key of keys.reverse()) {
    const res = await fetch(BUILD_BASE + key, { method: 'HEAD' });
    if (res.ok) return key.slice(0, 8);
  }
  throw new Error('No Protomaps planet build reachable');
}

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited with ${code}`))));
  });
}

async function buildPack(pmtiles, build, pack) {
  mkdirSync(packsDir, { recursive: true });
  const out = join(packsDir, `${pack.id}.pmtiles`);
  const tmp = `${out}.part`;
  if (existsSync(out)) {
    log(`${pack.id}: exists, skipping (delete it to rebuild)`);
  } else {
    log(`${pack.id}: extracting z0-${pack.maxZoom} bbox ${pack.bbox.join(',')} from ${build}`);
    const args = [
      'extract',
      `${BUILD_BASE}${build}.pmtiles`,
      tmp,
      `--maxzoom=${pack.maxZoom}`,
      '--download-threads=8',
    ];
    if (pack.bbox.join(',') !== '-180,-85,180,85') args.push(`--bbox=${pack.bbox.join(',')}`);
    await run(pmtiles, args);
    renameSync(tmp, out);
  }
  /** @type {import('../../packages/schema/src/ipc').MapPackInfo} */
  const info = {
    id: pack.id,
    label: pack.label,
    bbox: pack.bbox,
    maxZoom: pack.maxZoom,
    sizeBytes: statSync(out).size,
  };
  writeFileSync(join(packsDir, `${pack.id}.json`), `${JSON.stringify(info, null, 2)}\n`);
  log(`${pack.id}: ${(info.sizeBytes / 1e6).toFixed(1)} MB`);
}

async function fetchAssets() {
  let n = 0;
  for (const stack of ASSET_FONTSTACKS) {
    for (const range of ASSET_GLYPH_RANGES) {
      const dest = join(assetsDir, 'fonts', stack, `${range}.pbf`);
      if (existsSync(dest)) continue;
      await download(`${ASSETS_BASE}fonts/${encodeURIComponent(stack)}/${range}.pbf`, dest);
      n++;
    }
  }
  for (const sprite of ASSET_SPRITES) {
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
      const dest = join(assetsDir, 'sprites', `${sprite}${suffix}`);
      if (existsSync(dest)) continue;
      await download(`${ASSETS_BASE}sprites/v4/${sprite}${suffix}`, dest);
      n++;
    }
  }
  log(`assets: ${n} files fetched into ${assetsDir}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const names = argv.filter((a) => !a.startsWith('--'));
  const pinned = argv.find((a) => a.startsWith('--build='))?.slice(8);

  if (flags.has('--tool-only')) {
    log(`pmtiles CLI: ${await ensurePmtiles()}`);
    return;
  }
  if (!flags.has('--no-assets')) await fetchAssets();
  if (flags.has('--assets-only')) return;

  const wanted = names.length ? PACKS.filter((p) => names.includes(p.id)) : PACKS;
  if (!wanted.length) throw new Error(`Unknown pack(s): ${names.join(', ')}`);
  const pmtiles = await ensurePmtiles();
  const build = pinned ?? (await latestBuild());
  log(`planet build ${build}, data root ${dataRoot}`);
  for (const pack of wanted) await buildPack(pmtiles, build, pack);
  log(`done: ${readdirSync(packsDir).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
