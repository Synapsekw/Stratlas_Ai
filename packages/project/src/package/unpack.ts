import {
  PACKAGE_EXTENSION,
  PACKAGE_HEADER_FILE,
  PACKAGE_ORIGIN_FILE,
  packageEditAllowed,
  PackageOrigin,
  parseManifest,
  type PackageHeader,
  type ProjectManifest,
} from '@aio/schema';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { volumeFreeBytes } from './package';
import type { ZipArchive } from './reader';
import type { ZipProgress } from './writer';

export interface ExtractProjectOptions {
  /** The opened package, unlocked when encrypted. */
  archive: ZipArchive;
  header: PackageHeader;
  manifest: ProjectManifest;
  /** The `.aio` file (only read). */
  file: string;
  /** New projects go to `<dataRoot>/projects/<id>/`. */
  dataRoot: string;
  extractedBy?: string;
  now?: () => Date;
  signal?: AbortSignal;
  onProgress?: (p: ZipProgress) => void;
  /** Free bytes where the project goes (tests); defaults to the volume's free space. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
}

/** Why a package may not be extracted, or null when it may. */
export function extractRefusal(header: PackageHeader, file: string): string | null {
  if (packageEditAllowed(header)) return null;
  return `${basename(file)} is a read-only delivery: the sender did not allow editing it. Ask them for a package that allows extract to edit.`;
}

function slug(s: string): string {
  const v = s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return v || 'project';
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract to edit: copy every member of an opened package into a new project folder
 * `<dataRoot>/projects/<name>-edit/` (never an existing one), verified member by member, with
 * the manifest's id set to the folder name and `package-origin.json` saying which package it
 * came from and when that was exported. Issues, edits (`edits/`) and every layer come along.
 * Written into a hidden folder first and renamed at the end, so a cancelled or failed extract
 * leaves nothing behind. The package itself is only read.
 */
export async function extractProject(
  o: ExtractProjectOptions,
): Promise<{ root: string; id: string; manifest: ProjectManifest }> {
  const refusal = extractRefusal(o.header, o.file);
  if (refusal) throw new Error(refusal);
  const projects = join(o.dataRoot, 'projects');
  await mkdir(projects, { recursive: true });
  const name = basename(o.file);
  const stem = name.toLowerCase().endsWith(PACKAGE_EXTENSION)
    ? name.slice(0, -PACKAGE_EXTENSION.length)
    : name;
  const base = `${slug(stem)}-edit`;
  let id = base;
  for (let n = 2; await exists(join(projects, id)); n++) id = `${base}-${String(n)}`;
  const root = join(projects, id);

  const members = [...o.archive.entries.values()].filter(
    (e) => e.name !== PACKAGE_HEADER_FILE && e.name !== 'manifest.json',
  );
  const bytesTotal = members.reduce((n, e) => n + e.size, 0);
  const free = await (o.freeBytes ?? volumeFreeBytes)(projects);
  const need = bytesTotal + 1024 * 1024;
  if (free !== undefined && free < need) {
    throw new Error(
      `Not enough space to extract ${name}: it needs about ${String(Math.ceil(need / 1e6))} MB and ${projects} has ${String(Math.floor(free / 1e6))} MB free.`,
    );
  }

  const manifest: ProjectManifest = { ...o.manifest, id };
  const checked = parseManifest(manifest);
  if (!checked.ok) throw new Error(`${name}: ${checked.error}`);
  const now = (o.now ?? (() => new Date()))();
  const origin = PackageOrigin.parse({
    schema: 'aio.origin/1',
    package: name,
    path: resolve(o.file),
    projectId: o.header.projectId,
    exportedAt: o.header.createdAt,
    ...(o.header.createdBy ? { exportedBy: o.header.createdBy } : {}),
    extractedAt: now.toISOString(),
    ...(o.extractedBy ? { extractedBy: o.extractedBy } : {}),
    encrypted: o.archive.encrypted,
  });

  const tmp = join(projects, `.${id}.extracting-${String(process.pid)}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const progress: ZipProgress = {
    bytesDone: 0,
    bytesTotal,
    filesDone: 0,
    filesTotal: members.length + 2,
  };
  let last = 0;
  const report = (force = false) => {
    const t = Date.now();
    if (!force && t - last < 100) return;
    last = t;
    o.onProgress?.({ ...progress });
  };
  try {
    for (const e of members) {
      if (o.signal?.aborted) {
        const err = new Error('Extract cancelled.');
        err.name = 'AbortError';
        throw err;
      }
      const dest = join(tmp, ...e.name.split('/'));
      const rel = relative(tmp, dest);
      if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
        throw new Error(`${name} holds an unsafe file name: ${e.name}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      progress.current = e.name;
      const before = progress.bytesDone;
      await o.archive.copyTo(e.name, dest, {
        ...(o.signal ? { signal: o.signal } : {}),
        onBytes: (d) => {
          progress.bytesDone = before + d;
          report();
        },
      });
      progress.bytesDone = before + e.size;
      progress.filesDone++;
      report();
    }
    const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    if (!o.archive.entries.has('issues.json')) {
      await writeFile(join(tmp, 'issues.json'), json({ schema: 'aio.issues/1', issues: [] }));
    }
    await writeFile(join(tmp, PACKAGE_ORIGIN_FILE), json(origin));
    // The manifest last: the library lists a folder only once it has one.
    await writeFile(join(tmp, 'manifest.json'), json(checked.value));
    progress.filesDone += 2;
    delete progress.current;
    await rename(tmp, root);
    report(true);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return { root, id, manifest: checked.value };
}
