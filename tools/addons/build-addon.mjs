#!/usr/bin/env node
/**
 * Pack a folder of model files into an add-on archive (`<id>-<version>.aioaddon`, a gzipped tar
 * with `addon.json` and the files at its root; `aio.addon/1` in packages/schema/src/addons.ts),
 * and print or merge its catalogue entry (`aio.addon-catalogue/1`).
 *
 *   node tools/addons/build-addon.mjs <folder> --info <info.json> [--out <dir>]
 *        [--catalogue <catalogue.json>] [--url-prefix <prefix>]
 *
 * `info.json` holds `id`, `name`, `version`, `kind` (detector, segmenter, point-classifier),
 * `licence`, `source` and optionally `description` and `minPipelinePack`. Every file under the
 * folder is listed with its size and SHA-256 (an `addon.json` in it is ignored). The catalogue
 * entry's archive URL is `<prefix><file name>`, or the bare file name (relative to the catalogue).
 * With `--catalogue`, the entry replaces the same id's entry in that file (created if missing).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

export const ADDON_SCHEMA = 'aio.addon/1';
export const CATALOGUE_SCHEMA = 'aio.addon-catalogue/1';
const KINDS = ['detector', 'segmenter', 'point-classifier'];
const KIND_FILES = {
  detector: ['model.onnx', 'model.json'],
  segmenter: ['encoder.onnx', 'decoder.onnx', 'model.json'],
  'point-classifier': ['classifier.json'],
};
const SEMVER = /^\d+\.\d+\.\d+$/;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_FILES = 64;

/** The add-on facts from the input json, checked; throws with a sentence. */
export function checkInfo(info) {
  const need = ['id', 'name', 'version', 'kind', 'licence', 'source'];
  for (const k of need) {
    if (typeof info?.[k] !== 'string' || info[k].trim() === '')
      throw new Error(`info.json needs "${k}".`);
  }
  if (!ID.test(info.id)) throw new Error(`"${info.id}" is not an add-on id (a-z, 0-9, -).`);
  if (!SEMVER.test(info.version)) throw new Error(`"${info.version}" is not a version like 1.0.0.`);
  if (!KINDS.includes(info.kind))
    throw new Error(`"${info.kind}" is not one of ${KINDS.join(', ')}.`);
  if (info.minPipelinePack !== undefined && !SEMVER.test(info.minPipelinePack))
    throw new Error(`minPipelinePack "${info.minPipelinePack}" is not a version like 0.35.0.`);
  return {
    id: info.id,
    name: info.name,
    version: info.version,
    kind: info.kind,
    licence: info.licence,
    source: info.source,
    ...(info.description ? { description: info.description } : {}),
    ...(info.minPipelinePack ? { minPipelinePack: info.minPipelinePack } : {}),
  };
}

/** The manifest of `files` (`[{ path, sizeBytes, sha256 }]`, sorted). */
export function addonManifest(info, files) {
  const facts = checkInfo(info);
  if (files.length === 0) throw new Error('An add-on holds at least one file.');
  if (files.length > MAX_FILES) throw new Error(`An add-on holds at most ${MAX_FILES} files.`);
  for (const f of files) {
    if (!PATH.test(f.path) || f.path.split('/').includes('..'))
      throw new Error(`${f.path} is not a name an add-on file can have.`);
  }
  for (const need of KIND_FILES[facts.kind]) {
    if (!files.some((f) => f.path === need))
      throw new Error(`A ${facts.kind} add-on needs ${need}.`);
  }
  const { minPipelinePack, description, ...rest } = facts;
  return {
    schema: ADDON_SCHEMA,
    ...rest,
    ...(description ? { description } : {}),
    sizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    ...(minPipelinePack ? { minPipelinePack } : {}),
  };
}

// ---------------------------------------------------------------- tar

function header(path, size, type) {
  const h = Buffer.alloc(512);
  const put = (value, at, length) => {
    const b = Buffer.from(value, 'utf8');
    if (b.length > length) throw new Error(`"${value}" is too long for a tar header.`);
    b.copy(h, at);
  };
  const octal = (value, at, length) =>
    put(`${value.toString(8).padStart(length - 1, '0')}\0`, at, length);
  // ustar: names up to 100 bytes, or a prefix of up to 155 and a name of up to 100
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100)
      throw new Error(`${path} is too long for the add-on archive.`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  put(name, 0, 100);
  octal(type === '5' ? 0o755 : 0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.floor(Date.UTC(2026, 0, 1) / 1000), 136, 12);
  h.fill(' ', 148, 156);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of h) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** The tar stream of `entries` (`{ path, data?: Buffer, file?: string, size }`), in order. */
async function* tarStream(entries) {
  for (const e of entries) {
    yield header(e.path, e.size, '0');
    if (e.data) yield e.data;
    else for await (const chunk of createReadStream(e.file)) yield chunk;
    const pad = (512 - (e.size % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
}

const sha256File = async (path) => {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
};

async function listFolder(dir) {
  const out = [];
  const walk = async (d) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const path = relative(dir, full).split(sep).join('/');
        if (path !== 'addon.json') out.push({ path, file: full });
      } else throw new Error(`${full} is neither a file nor a folder.`);
    }
  };
  await walk(dir);
  return out;
}

/**
 * Write `<outDir>/<id>-<version>.aioaddon` from `files` (`{ path: string, data?: Buffer, file?:
 * string }`): `addon.json` first, then each file. Answers the manifest, the archive path, size and
 * SHA-256, and `entry(url)`, its catalogue entry.
 */
export async function packAddon({ info, files, outDir }) {
  const listed = [];
  for (const f of files) {
    const data = f.data === undefined ? undefined : Buffer.from(f.data);
    const size = data ? data.length : (await stat(f.file)).size;
    const sha256 = data
      ? createHash('sha256').update(data).digest('hex')
      : await sha256File(f.file);
    listed.push({ ...f, data, size, sha256 });
  }
  const manifest = addonManifest(
    info,
    listed.map((f) => ({ path: f.path, sizeBytes: f.size, sha256: f.sha256 })),
  );
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(outDir, { recursive: true });
  const archive = join(outDir, `${manifest.id}-${manifest.version}.aioaddon`);
  const partial = `${archive}.partial`;
  const ordered = [...listed].sort((a, b) => a.path.localeCompare(b.path));
  await pipeline(
    tarStream([
      { path: 'addon.json', data: manifestBytes, size: manifestBytes.length },
      ...ordered,
    ]),
    createGzip({ level: 6 }),
    createWriteStream(partial),
  );
  await rename(partial, archive);
  const sizeBytes = (await stat(archive)).size;
  const sha256 = await sha256File(archive);
  return {
    manifest,
    archive,
    sizeBytes,
    sha256,
    entry: (url = basename(archive)) => ({ manifest, archive: { url, sizeBytes, sha256 } }),
  };
}

/** Pack every file under `dir` (see `packAddon`). */
export async function buildAddon({ dir, info, outDir = dir }) {
  return packAddon({ info, files: await listFolder(dir), outDir });
}

/** `catalogue` (or a new one) with `entry` in place of the same id's entry, sorted by id. */
export function mergeCatalogue(catalogue, entry) {
  const base = catalogue ?? { schema: CATALOGUE_SCHEMA, addons: [] };
  if (base.schema !== CATALOGUE_SCHEMA)
    throw new Error(`The catalogue is not ${CATALOGUE_SCHEMA}.`);
  const addons = base.addons.filter((a) => a.manifest.id !== entry.manifest.id);
  addons.push(entry);
  addons.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return { schema: CATALOGUE_SCHEMA, addons };
}

function args(argv) {
  const o = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o.positional.push(a);
  }
  return o;
}

async function main() {
  const a = args(process.argv.slice(2));
  const [dir] = a.positional;
  if (!dir || !a.info) {
    console.error(
      'Usage: node tools/addons/build-addon.mjs <folder> --info <info.json> [--out <dir>] [--catalogue <catalogue.json>] [--url-prefix <prefix>]',
    );
    process.exit(2);
  }
  const info = JSON.parse(await readFile(a.info, 'utf8'));
  const built = await buildAddon({ dir: resolve(dir), info, outDir: resolve(a.out ?? '.') });
  const entry = built.entry(`${a['url-prefix'] ?? ''}${basename(built.archive)}`);
  process.stdout.write(
    `Wrote ${built.archive} (${built.sizeBytes} bytes, SHA-256 ${built.sha256}).\n`,
  );
  if (a.catalogue) {
    const existing = existsSync(a.catalogue)
      ? JSON.parse(await readFile(a.catalogue, 'utf8'))
      : null;
    await writeFile(a.catalogue, `${JSON.stringify(mergeCatalogue(existing, entry), null, 2)}\n`);
    process.stdout.write(`Updated ${a.catalogue}.\n`);
  } else {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
