import {
  PACKAGE_HEADER_FILE,
  PACKAGE_SCHEMA,
  PackageHeader,
  parseManifest,
  parsePackageHeader,
  type AssetRef,
  type Layer,
  type PackageHeaderInput,
  type ProjectManifest,
} from '@aio/schema';
import { readdir, stat, statfs } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { planPackage, type SourceFile } from './plan';
import { openZip, ZipError, type ZipArchive } from './reader';
import { writeZip, type ZipMember, type ZipProgress } from './writer';

/** Every file under a project folder (symlinked folders are not followed). */
export async function scanProject(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const s = await stat(p);
        out.push({
          path: relative(root, p).replace(/\\/g, '/'),
          size: s.size,
          mtimeMs: s.mtimeMs,
        });
      }
    }
  };
  await walk(root);
  return out;
}

export interface ExportPackageOptions {
  root: string;
  out: string;
  manifest: ProjectManifest;
  /** Layer ids to leave out. */
  exclude: readonly string[];
  header: Omit<PackageHeaderInput, 'schema' | 'projectId' | 'createdAt' | 'excludedLayers'>;
  passphrase?: string;
  createdBy?: string;
  signal?: AbortSignal;
  onProgress?: (p: ZipProgress) => void;
  /** Files of the project, when the caller has scanned them already. */
  files?: readonly SourceFile[];
  /** Free bytes where the package goes (tests); defaults to the volume's free space. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
  /**
   * Further members written after the project files, e.g. an embedded map pack
   * (`packs/<id>.pmtiles` and `packs/<id>.json`); a project file of the same name is left out.
   */
  extra?: readonly ZipMember[];
}

/** Free space of the volume that holds `dir`, or undefined when the OS does not say. */
export async function volumeFreeBytes(dir: string): Promise<number | undefined> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

const FIRST = ['manifest.json', 'issues.json', 'thumbnail.jpg'];

/**
 * Write a project as one `.aio` package: store-mode ZIP64 with the header and manifest first,
 * optionally AES-256 encrypted. Streams file by file, so multi-GB projects need no extra memory.
 */
export async function exportPackage(o: ExportPackageOptions): Promise<{ bytes: number }> {
  const files = o.files ?? (await scanProject(o.root));
  const plan = planPackage(o.manifest, files, o.exclude);
  const header = PackageHeader.parse({
    ...o.header,
    schema: PACKAGE_SCHEMA,
    projectId: o.manifest.id,
    createdAt: new Date().toISOString(),
    excludedLayers: plan.excluded,
    ...(o.createdBy ? { createdBy: o.createdBy } : {}),
  });
  const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');
  const rank = (p: string) => {
    const i = FIRST.indexOf(p);
    return i < 0 ? FIRST.length : i;
  };
  const extra = o.extra ?? [];
  const replaced = new Set(extra.map((m) => m.name));
  const rest = plan.members
    .filter((f) => !replaced.has(f.path))
    .sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  const members: ZipMember[] = [
    { name: PACKAGE_HEADER_FILE, data: json(header) },
    { name: 'manifest.json', data: json(plan.manifest) },
    ...rest.map((f) => ({
      name: f.path,
      file: join(o.root, ...f.path.split('/')),
      size: f.size,
      ...(f.mtimeMs !== undefined ? { mtimeMs: f.mtimeMs } : {}),
    })),
    ...extra,
  ];

  const bytes = members.reduce((n, m) => n + ('data' in m ? m.data.length : m.size), 0);
  const need = bytes + 64 * 1024 + members.length * 256;
  const free = await (o.freeBytes ?? volumeFreeBytes)(dirname(o.out));
  if (free !== undefined && free < need) {
    throw new Error(
      `Not enough space for ${basename(o.out)}: it needs about ${String(Math.ceil(need / 1e6))} MB and ${dirname(o.out)} has ${String(Math.floor(free / 1e6))} MB free. Free some space, pick another drive or leave out large layers.`,
    );
  }
  return writeZip(o.out, members, {
    ...(o.passphrase !== undefined ? { passphrase: o.passphrase } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  });
}

export interface OpenedPackage {
  archive: ZipArchive;
  header: PackageHeader;
  manifest: ProjectManifest;
  /** Parsed `issues.json`, undefined when the package has none. */
  issuesJson: unknown;
}

export type OpenPackageResult =
  { ok: true; value: OpenedPackage } | { ok: false; error: string; needsPassphrase?: boolean };

const refPath = (ref: AssetRef | undefined) => (ref && 'path' in ref ? ref.path : null);

/** Files a layer cannot open without. */
function requiredFiles(layer: Layer): string[] {
  const refs: (AssetRef | undefined)[] = [];
  switch (layer.kind) {
    case 'mesh':
    case 'pointcloud':
    case 'raster':
      refs.push(layer.src);
      break;
    case 'video':
      refs.push(layer.src, layer.flight.src);
      break;
    case 'photos':
    case 'panoramas':
      for (const i of layer.items) refs.push(i.src);
      break;
    case 'legacy':
      refs.push(layer.entry);
      break;
    case 'basemap':
      break;
  }
  return refs.map(refPath).filter((p): p is string => p !== null);
}

async function readJsonMember(archive: ZipArchive, name: string): Promise<unknown> {
  const text = (await archive.read(name)).toString('utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

/**
 * Open a `.aio` package in place: index it, unlock it, read and check the header and manifest
 * and make sure every layer's files are inside. Nothing is unpacked or written.
 */
export async function openPackage(file: string, passphrase?: string): Promise<OpenPackageResult> {
  const name = basename(file);
  let archive: ZipArchive;
  try {
    archive = await openZip(file);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (archive.encrypted) {
    if (passphrase === undefined) {
      return {
        ok: false,
        needsPassphrase: true,
        error: `${name} is encrypted. Enter the passphrase you were given with the package.`,
      };
    }
    if (!(await archive.unlock(passphrase))) {
      return {
        ok: false,
        needsPassphrase: true,
        error: `That passphrase does not open ${name}. Check it with the sender and try again.`,
      };
    }
  }
  try {
    if (!archive.entries.has('manifest.json')) {
      return {
        ok: false,
        error: `${name} has no manifest.json, so it is not a project package. Ask the sender to export it again from the app.`,
      };
    }
    const header = archive.entries.has(PACKAGE_HEADER_FILE)
      ? parsePackageHeader(await readJsonMember(archive, PACKAGE_HEADER_FILE))
      : null;
    if (header && !header.ok) return { ok: false, error: `${name}: ${header.error}` };
    const manifest = parseManifest(await readJsonMember(archive, 'manifest.json'));
    if (!manifest.ok) return { ok: false, error: `${name}: ${manifest.error}` };
    for (const layer of manifest.value.layers) {
      const missing = requiredFiles(layer).find((p) => !archive.entries.has(p));
      if (missing) {
        return {
          ok: false,
          error: `${name} is missing ${missing} (layer ${layer.name}). Export the package again or ask the sender for a new copy.`,
        };
      }
    }
    const issuesJson = archive.entries.has('issues.json')
      ? await readJsonMember(archive, 'issues.json')
      : undefined;
    const fallback = PackageHeader.parse({
      schema: PACKAGE_SCHEMA,
      projectId: manifest.value.id,
      createdAt: new Date(0).toISOString(),
    });
    return {
      ok: true,
      value: {
        archive,
        header: header ? header.value : fallback,
        manifest: manifest.value,
        issuesJson,
      },
    };
  } catch (e) {
    if (e instanceof ZipError) return { ok: false, error: e.message };
    if (e instanceof SyntaxError) {
      return { ok: false, error: `${name} holds a file that is not valid JSON (${e.message}).` };
    }
    throw e;
  }
}
