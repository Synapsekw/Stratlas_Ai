#!/usr/bin/env node
// The thermal tools of the pipeline pack (thermal analysis, M1): ExifTool (reads the radiometric
// tags of FLIR and DJI photos) and the DJI Thermal SDK (turns a DJI R-JPEG into temperatures),
// both prebuilt Windows x64 archives. Nothing is built from source. Each archive is fetched from
// the URL pinned in thermal-tools-lock.json into a cache, refused unless its SHA-256 matches, and
// only the listed entries are unpacked into the pack's tools/exiftool and tools/dji-tsdk.
// aio_pipelines finds them there (photo/native.py find_tool); QUADRION_EXIFTOOL and
// QUADRION_DJI_TSDK override.
//
//   node tools/pipeline-pack/thermal-tools.mjs --out <folder> [--cache <folder>] [--offline]
//       both tools into <folder>/tools/ (prints QUADRION_EXIFTOOL=<exe> and QUADRION_DJI_TSDK=<dir>)
//
// build.mjs calls installThermalTools(); --no-thermal-tools leaves the tools out.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { inflateRawSync } from 'node:zlib';

export const THERMAL_LOCK_FILE = new URL('./thermal-tools-lock.json', import.meta.url);

/** The committed lock: `tools` of { name, version, url, sha256, dest, unpack, files }. */
export const THERMAL_LOCK = JSON.parse(readFileSync(THERMAL_LOCK_FILE, 'utf8'));

const say = (msg) => process.stdout.write(`${msg}\n`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The entries of a zip archive (stored or deflated; no zip64, no encryption), read from its
 * central directory: [{ name, read() }] with `read()` the entry's bytes.
 */
export function readZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive (no end-of-directory record)');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    entries.push({
      name,
      read() {
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: corrupt zip entry`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + packed);
        const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
        if (!data) throw new Error(`${name}: unsupported zip method ${String(method)}`);
        if (data.length !== size) throw new Error(`${name}: wrong size in the archive`);
        return data;
      },
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The archive of `tool` as bytes: from the cache when it is there and matches, else downloaded. */
async function archiveOf(tool, { cache, offline, fetchImpl, log }) {
  const dir = join(cache, 'thermal-tools');
  const cached = join(dir, `${tool.sha256}.zip`);
  if (existsSync(cached)) {
    const buf = readFileSync(cached);
    if (sha256(buf) === tool.sha256) return buf;
  }
  if (offline)
    throw new Error(`${tool.name}: offline and ${tool.sha256.slice(0, 12)} is not in the cache`);
  log(`  downloading ${tool.url}`);
  const res = await fetchImpl(tool.url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'quadrion-pipeline-pack' },
  });
  if (!res.ok) throw new Error(`${tool.url}: HTTP ${String(res.status)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== tool.sha256)
    throw new Error(`${tool.name} from ${tool.url} has SHA-256 ${got}, expected ${tool.sha256}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${cached}.part`, buf);
  renameSync(`${cached}.part`, cached);
  return buf;
}

/** Unpack the lock entry's `unpack` rules from a verified archive into `dir`; returns the files. */
function unpack(tool, buf, dir) {
  const entries = readZip(buf).filter((e) => !e.name.endsWith('/'));
  const root = resolve(dir);
  const written = [];
  const put = (entry, to) => {
    const target = resolve(root, to);
    if (!target.startsWith(root + sep)) throw new Error(`${tool.name}: ${to} is outside ${dir}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.read());
    written.push(to);
  };
  for (const rule of tool.unpack) {
    if (rule.from.endsWith('/')) {
      const inside = entries.filter((e) => e.name.startsWith(rule.from));
      if (inside.length === 0) throw new Error(`${tool.name}: nothing under ${rule.from}`);
      for (const e of inside) put(e, `${rule.to}${e.name.slice(rule.from.length)}`);
    } else {
      const e = entries.find((x) => x.name === rule.from);
      if (!e) throw new Error(`${tool.name}: ${rule.from} is not in the archive`);
      put(e, rule.to);
    }
  }
  const missing = tool.files.filter((f) => !written.includes(f));
  if (missing.length > 0)
    throw new Error(`${tool.name}: the archive lacks ${missing.join(', ')} (see the lock's files)`);
  return written;
}

/**
 * ExifTool and the DJI Thermal SDK into `<packDir>/tools/...` (each tool's `dest`). An archive
 * comes from `cache` when it is there and matches, else it is downloaded (never with `offline`);
 * one whose SHA-256 differs from the pin fails the build before anything is unpacked.
 */
export async function installThermalTools(
  packDir,
  {
    offline = false,
    cache = join(tmpdir(), 'quadrion-pack-cache'),
    fetchImpl = fetch,
    lock = THERMAL_LOCK,
    log = say,
  } = {},
) {
  const done = [];
  for (const tool of lock.tools) {
    const buf = await archiveOf(tool, { cache, offline, fetchImpl, log });
    const dir = join(packDir, tool.dest);
    rmSync(dir, { recursive: true, force: true });
    try {
      const files = unpack(tool, buf, dir);
      log(`  ${tool.name} ${tool.version}: ${String(files.length)} files in ${tool.dest}`);
      done.push({ name: tool.name, version: tool.version, dir, files: files.length });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }
  return done;
}

/**
 * The sample photos some tool's archive carries (its lock entry's `dataset` folder) into `dest`,
 * for tests only: never part of the pack. Returns the number of files.
 */
export async function installThermalDataset(
  dest,
  {
    offline = false,
    cache = join(tmpdir(), 'quadrion-pack-cache'),
    fetchImpl = fetch,
    lock = THERMAL_LOCK,
    log = say,
  } = {},
) {
  const tool = lock.tools.find((t) => t.dataset);
  if (!tool) throw new Error('the lock has no dataset');
  const buf = await archiveOf(tool, { cache, offline, fetchImpl, log });
  rmSync(dest, { recursive: true, force: true });
  const files = unpack(
    { name: `${tool.name} dataset`, unpack: [{ from: tool.dataset, to: '' }], files: [] },
    buf,
    dest,
  );
  log(`  ${tool.name} dataset: ${String(files.length)} files`);
  return files.length;
}

/** The ExifTool program of a pack folder. */
export const exiftoolExe = (packDir) => join(packDir, 'tools', 'exiftool', 'exiftool.exe');

/** The DJI Thermal SDK folder (the one holding libdirp.dll) of a pack folder. */
export const djiTsdkDir = (packDir) => join(packDir, 'tools', 'dji-tsdk');

/** What is wrong with the installed thermal tools of a pack folder, or []. */
export function thermalToolProblems(packDir, lock = THERMAL_LOCK) {
  return lock.tools.flatMap((t) =>
    t.files.filter((f) => !existsSync(join(packDir, t.dest, f))).map((f) => `${t.name}: ${f}`),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      cache: { type: 'string' },
      offline: { type: 'boolean', default: false },
      dataset: { type: 'string' },
    },
  });
  try {
    if (!values.out) throw new Error('pass --out <folder>');
    const out = resolve(values.out);
    const opts = {
      offline: values.offline,
      ...(values.cache ? { cache: resolve(values.cache) } : {}),
    };
    await installThermalTools(out, opts);
    const problems = thermalToolProblems(out);
    if (problems.length > 0) throw new Error(`missing after unpacking: ${problems.join(', ')}`);
    say(`QUADRION_EXIFTOOL=${exiftoolExe(out)}\nQUADRION_DJI_TSDK=${djiTsdkDir(out)}`);
    if (values.dataset) {
      await installThermalDataset(resolve(values.dataset), opts);
      say(`QUADRION_DJI_TSDK_DATASET=${resolve(values.dataset)}`);
    }
  } catch (e) {
    process.stderr.write(`thermal-tools: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
