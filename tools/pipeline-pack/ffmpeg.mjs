#!/usr/bin/env node
// ffmpeg for the pipeline pack (founder decision 3 of 12 Oct 2026): conda-forge's prebuilt GPL
// `ffmpeg` (libx264, the v360 filter and the HEVC decoder), installed by micromamba from an
// explicit lock exactly as PDAL is (pdal.mjs, installCondaTool) and pruned to ffmpeg, ffprobe and
// the libraries they load. aio_pipelines.walk and the app find it at <pack>/tools/ffmpeg
// (Library/bin/ffmpeg.exe on Windows, bin/ffmpeg on macOS); QUADRION_FFMPEG overrides it.
//
//   node tools/pipeline-pack/ffmpeg.mjs --out <folder>   ffmpeg for this machine into <folder>
//                                                        (prints QUADRION_FFMPEG=<exe>)
//   node tools/pipeline-pack/ffmpeg.mjs --lock           re-solve ffmpeg-lock.json (online)
//
// build.mjs calls installFfmpeg() and checkFfmpegTool().
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { condaRoot, installCondaTool, PLATFORMS, relockConda, run, walk } from './pdal.mjs';

export const FFMPEG_LOCK_FILE = new URL('./ffmpeg-lock.json', import.meta.url);

/** The conda spec the lock is solved for: the GPL build (`gpl_*`), not the LGPL one. */
export const FFMPEG_SPEC = 'ffmpeg=9.0.2=gpl_*';

/** The committed lock. */
export const FFMPEG_LOCK = existsSync(FFMPEG_LOCK_FILE)
  ? JSON.parse(readFileSync(FFMPEG_LOCK_FILE, 'utf8'))
  : { platforms: {} };

/** The pack platforms the lock has packages for. */
export const FFMPEG_PLATFORMS = Object.keys(PLATFORMS).filter(
  (p) => (FFMPEG_LOCK.platforms?.[PLATFORMS[p].subdir] ?? []).length > 0,
);

/** The programs the pack keeps. */
const PROGRAMS = ['ffmpeg', 'ffprobe'];

const say = (msg) => process.stdout.write(`${msg}\n`);

/**
 * The DLL names a Windows program (PE32 or PE32+) imports, delay-loaded ones included, in table
 * order; [] for a file that is not one.
 */
export function peImports(buf) {
  if (buf.length < 0x40 || buf.toString('latin1', 0, 2) !== 'MZ') return [];
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return [];
  const coff = pe + 4;
  const sections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const plus = buf.readUInt16LE(opt) === 0x20b;
  const dirs = opt + (plus ? 112 : 96);
  const dirCount = buf.readUInt32LE(opt + (plus ? 108 : 92));
  const table = [];
  for (let i = 0; i < sections; i++) {
    const s = opt + optSize + i * 40;
    table.push({
      va: buf.readUInt32LE(s + 12),
      size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)),
      raw: buf.readUInt32LE(s + 20),
    });
  }
  const offset = (rva) => {
    const s = table.find((t) => rva >= t.va && rva < t.va + t.size);
    return s ? rva - s.va + s.raw : -1;
  };
  const cstring = (rva) => {
    const at = offset(rva);
    if (at < 0) return null;
    const end = buf.indexOf(0, at);
    return buf.toString('latin1', at, end < 0 ? buf.length : end);
  };
  const names = [];
  const read = (dir, size, nameAt, live) => {
    if (dir >= dirCount) return;
    const rva = buf.readUInt32LE(dirs + dir * 8);
    let at = rva ? offset(rva) : -1;
    while (at >= 0 && at + size <= buf.length && live(at)) {
      const name = cstring(buf.readUInt32LE(at + nameAt));
      if (name) names.push(name);
      at += size;
    }
  };
  // import descriptors: 20 bytes, name at +12, ended by an all-zero one
  read(1, 20, 12, (at) => buf.readUInt32LE(at + 12) !== 0);
  // delay-load descriptors: 32 bytes, name at +4
  read(13, 32, 4, (at) => buf.readUInt32LE(at + 4) !== 0);
  return names;
}

/**
 * The DLLs (lower-case names) ffmpeg and ffprobe load from a conda prefix on Windows, followed
 * through the import tables (Library/bin, and the runtime DLLs conda puts at the prefix's root).
 */
export function loadedDlls(prefix) {
  const where = new Map();
  for (const rel of walk(prefix)) {
    const m = /^(library\/bin\/)?([^/]+\.dll)$/i.exec(rel);
    if (m) where.set(m[2].toLowerCase(), join(prefix, rel));
  }
  const seen = new Set();
  const todo = PROGRAMS.map((p) => join(prefix, 'Library', 'bin', `${p}.exe`));
  while (todo.length > 0) {
    for (const dll of peImports(readFileSync(todo.pop()))) {
      const key = dll.toLowerCase();
      if (seen.has(key) || !where.has(key)) continue;
      seen.add(key);
      todo.push(where.get(key));
    }
  }
  return seen;
}

/**
 * Where a file of the environment (path relative to its prefix, `/` separated) goes in the pack
 * on Windows, or null: ffmpeg.exe, ffprobe.exe and the DLLs in `loaded`, all in Library/bin.
 */
export function windowsKeep(rel, loaded) {
  const r = rel.toLowerCase();
  for (const p of PROGRAMS) if (r === `library/bin/${p}.exe`) return `Library/bin/${p}.exe`;
  const dll = /^(library\/bin\/)?([^/]+\.dll)$/.exec(r);
  if (dll && loaded.has(dll[2])) return `Library/bin/${basename(rel)}`;
  return null;
}

/** ffmpeg (or ffprobe) inside an installFfmpeg folder. */
export function ffmpegExe(
  dir,
  platform = `${process.platform}-${process.arch}`,
  program = 'ffmpeg',
) {
  return platform.startsWith('win32')
    ? join(dir, 'Library', 'bin', `${program}.exe`)
    : join(dir, 'bin', program);
}

/**
 * ffmpeg for `platform` into `dest` (the pack's tools/ffmpeg), with its licences and
 * `conda-packages.json`. Returns the ffmpeg program.
 */
export async function installFfmpeg({ platform, cache, dest, log = say }) {
  const { packages, files } = await installCondaTool({
    spec: FFMPEG_SPEC,
    lock: FFMPEG_LOCK,
    label: 'ffmpeg-lock.json',
    dest,
    prune: {
      windows: (prefix) => {
        const loaded = loadedDlls(prefix);
        return (rel) => windowsKeep(rel, loaded);
      },
      mac: { programs: PROGRAMS },
    },
    platform,
    cache,
    log,
  });
  log(`  ffmpeg: ${packages} conda-forge packages, ${files} files kept`);
  return ffmpegExe(dest, platform);
}

/**
 * What the walk pipeline needs that an ffmpeg lacks, from its `-filters`, `-encoders` and
 * `-decoders` listings: the v360 filter, the libx264 encoder and the HEVC decoder.
 */
export function ffmpegProblems({ filters, encoders, decoders }) {
  const missing = [];
  // the flag columns: three before FFmpeg 9 (T, S, C), two since (T, S)
  if (!/^\s*\S{2,3}\s+v360\s/m.test(filters)) missing.push('v360 filter');
  if (!/^\s*\S{6}\s+libx264\s/m.test(encoders)) missing.push('libx264 encoder');
  if (!/^\s*\S{6}\s+hevc\s/m.test(decoders)) missing.push('hevc decoder');
  return missing;
}

/** An installed ffmpeg folder: its version line and what it lacks (`ffmpeg`, `ffprobe` too). */
export function checkFfmpegTool(dir, platform = `${process.platform}-${process.arch}`) {
  const exe = ffmpegExe(dir, platform);
  if (!existsSync(exe)) return { version: '', missing: ['ffmpeg'] };
  const out = (arg) => run(exe, ['-hide_banner', arg], { maxBuffer: 16 * 1024 * 1024 });
  const version = /^ffmpeg version \S+/.exec(out('-version'))?.[0] ?? '';
  const missing = ffmpegProblems({
    filters: out('-filters'),
    encoders: out('-encoders'),
    decoders: out('-decoders'),
  });
  if (!existsSync(ffmpegExe(dir, platform, 'ffprobe'))) missing.push('ffprobe');
  return { version, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, lock: { type: 'boolean', default: false } },
  });
  const cache = join(condaRoot(), 'bin');
  try {
    if (values.lock)
      await relockConda({
        spec: FFMPEG_SPEC,
        file: FFMPEG_LOCK_FILE,
        schema: 'ffmpeg-lock/1',
        comment:
          "conda-forge packages of the pack's ffmpeg (tools/pipeline-pack/ffmpeg.mjs), solved by `node tools/pipeline-pack/ffmpeg.mjs --lock`; do not edit by hand. Installed from these URLs with their SHA-256, never re-solved by a build.",
        cache,
      });
    else if (values.out) {
      const platform = `${process.platform}-${process.arch}`;
      const dest = resolve(values.out);
      const exe = await installFfmpeg({ platform, cache, dest });
      const { version, missing } = checkFfmpegTool(dest, platform);
      if (missing.length > 0) throw new Error(`ffmpeg lacks ${missing.join(', ')}`);
      say(`${version}\nQUADRION_FFMPEG=${exe}`);
    } else throw new Error('pass --out <folder> or --lock');
  } catch (e) {
    process.stderr.write(`ffmpeg: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
