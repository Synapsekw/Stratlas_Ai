import { openPackage, type ZipArchive } from '@aio/project/package';
import {
  Issue,
  PACKAGE_EXTENSION,
  parseManifest,
  validateIssueAgainstModel,
  type IpcResponse,
  type PackageHeader,
  type ProjectManifest,
} from '@aio/schema';
import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';

export const ISSUES_SCHEMA = 'aio.issues/1';
const IssuesFile = z.object({ schema: z.literal(ISSUES_SCHEMA), issues: z.array(Issue) });

/** Lower-case, URL-safe id from a folder name. */
export function slugify(s: string): string {
  const slug = s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'project' : slug;
}

const keyOf = (root: string) => {
  const r = resolve(root);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** A `.aio` package opened in place: members are served from the archive by offset. */
export interface PackageSource {
  file: string;
  archive: ZipArchive;
  header: PackageHeader;
  manifest: ProjectManifest;
}

const isPackagePath = (p: string) => p.toLowerCase().endsWith(PACKAGE_EXTENSION);

/**
 * Project id to root folder or opened package. Only registered projects are reachable through
 * aio://project/<id>/, so the renderer can never point the protocol at an arbitrary path.
 */
export class ProjectRegistry {
  private readonly byId = new Map<string, string>();
  private readonly byKey = new Map<string, string>();
  private readonly packages = new Map<string, PackageSource>();

  private idFor(path: string): string {
    const key = keyOf(path);
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const name = basename(resolve(path));
    const base = slugify(isPackagePath(name) ? name.slice(0, -PACKAGE_EXTENSION.length) : name);
    let id = base;
    for (let n = 2; this.byId.has(id); n++) id = `${base}-${String(n)}`;
    this.byId.set(id, resolve(path));
    this.byKey.set(key, id);
    return id;
  }

  register(root: string): string {
    return this.idFor(root);
  }

  /** Register (or refresh, after a re-export) an opened package. */
  registerPackage(source: PackageSource): string {
    const id = this.idFor(source.file);
    this.packages.set(id, source);
    return id;
  }

  /** Root folder of a folder project; undefined for packages and unknown ids. */
  root(id: string): string | undefined {
    return this.packages.has(id) ? undefined : this.byId.get(id);
  }

  package(id: string): PackageSource | undefined {
    return this.packages.get(id);
  }
}

type Loaded<T> = { ok: true; value: T } | { ok: false; error: string };

async function loadJsonFile(file: string, what: string): Promise<Loaded<unknown>> {
  try {
    return { ok: true, value: await readJson(file) };
  } catch (e) {
    if (e instanceof SyntaxError) {
      return {
        ok: false,
        error: `${file} is not valid JSON (${e.message}). Fix the file or restore ${what} from a backup.`,
      };
    }
    return { ok: false, error: `Could not read ${file}: ${String(e)}` };
  }
}

/** Read and validate `<root>/manifest.json`. */
export async function readManifest(root: string): Promise<Loaded<ProjectManifest>> {
  const file = join(root, 'manifest.json');
  const raw = await loadJsonFile(file, 'manifest.json');
  if (!raw.ok) return raw;
  if (raw.value === undefined) {
    return {
      ok: false,
      error: `No manifest.json in ${root}. Pick the project folder that holds manifest.json, or import the job first.`,
    };
  }
  const parsed = parseManifest(raw.value);
  if (!parsed.ok) return { ok: false, error: `${file}: ${parsed.error}` };
  return parsed;
}

/** Read `<root>/issues.json`; a missing file means no issues yet. */
export async function readIssues(root: string): Promise<Loaded<Issue[]>> {
  const file = join(root, 'issues.json');
  const raw = await loadJsonFile(file, 'issues.json (issues.json.bak)');
  if (!raw.ok) return raw;
  if (raw.value === undefined) return { ok: true, value: [] };
  const parsed = IssuesFile.safeParse(raw.value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
    return {
      ok: false,
      error: `${file} is invalid${where}: ${first?.message ?? 'unknown error'}. Fix the file or restore issues.json.bak.`,
    };
  }
  return { ok: true, value: parsed.data.issues };
}

function parseIssues(raw: unknown, where: string, fix: string): Loaded<Issue[]> {
  if (raw === undefined) return { ok: true, value: [] };
  const parsed = IssuesFile.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.length ? ` at ${first.path.join('.')}` : '';
    return {
      ok: false,
      error: `${where} is invalid${at}: ${first?.message ?? 'unknown error'}. ${fix}`,
    };
  }
  return { ok: true, value: parsed.data.issues };
}

/** Open a `.aio` package in place (nothing is unpacked or written). */
export async function openPackageProject(
  path: string,
  registry: ProjectRegistry,
  passphrase?: string,
): Promise<IpcResponse<'project:open'>> {
  const file = resolve(path);
  const r = await openPackage(file, passphrase);
  if (!r.ok) {
    return { ok: false, error: r.error, ...(r.needsPassphrase ? { needsPassphrase: true } : {}) };
  }
  const { archive, header, manifest, issuesJson } = r.value;
  const issues = parseIssues(
    issuesJson,
    `issues.json in ${basename(file)}`,
    'Ask the sender for a new copy of the package.',
  );
  if (!issues.ok) return issues;
  const id = registry.registerPackage({ file, archive, header, manifest });
  return {
    ok: true,
    id,
    root: file,
    manifest,
    issues: issues.value,
    package: { header, file, encrypted: archive.encrypted, sizeBytes: archive.sizeBytes },
  };
}

export async function openProject(
  path: string,
  registry: ProjectRegistry,
  passphrase?: string,
): Promise<IpcResponse<'project:open'>> {
  const root = resolve(path);
  try {
    const s = await stat(root);
    if (!s.isDirectory()) {
      if (isPackagePath(root)) return await openPackageProject(root, registry, passphrase);
      return {
        ok: false,
        error: `${root} is a file. Pick the project folder or a ${PACKAGE_EXTENSION} package instead.`,
      };
    }
  } catch {
    return {
      ok: false,
      error: `Folder not found: ${root}. Check the path or the data folder in Settings.`,
    };
  }
  const manifest = await readManifest(root);
  if (!manifest.ok) return manifest;
  const issues = await readIssues(root);
  if (!issues.ok) return issues;
  const id = registry.register(root);
  return { ok: true, id, root, manifest: manifest.value, issues: issues.value };
}

/** `project:writeIssues`: folder projects only; a package is never written. */
export async function writeProjectIssues(
  registry: ProjectRegistry,
  projectId: string,
  issues: Issue[],
): Promise<{ ok: boolean; error?: string }> {
  if (registry.package(projectId)) {
    return {
      ok: false,
      error: 'This project is a read-only package. Issues are not saved into it.',
    };
  }
  const root = registry.root(projectId);
  if (root === undefined) {
    return { ok: false, error: `Project "${projectId}" is not open. Open it, then save again.` };
  }
  return writeIssues(root, issues);
}

/** Validate issues against the project's severity models, then replace issues.json atomically. */
export async function writeIssues(
  root: string,
  issues: Issue[],
): Promise<{ ok: boolean; error?: string }> {
  const manifest = await readManifest(root);
  if (!manifest.ok) return { ok: false, error: manifest.error };
  const models = new Map(manifest.value.severityModels.map((m) => [m.id, m]));
  for (const issue of issues) {
    const model = models.get(issue.severityModelId);
    if (!model) {
      return {
        ok: false,
        error: `Issue ${issue.code}: severity model "${issue.severityModelId}" is not in this project.`,
      };
    }
    const r = validateIssueAgainstModel(issue, model);
    if (!r.ok) return { ok: false, error: r.error };
  }
  try {
    await writeJsonAtomic(
      join(root, 'issues.json'),
      { schema: ISSUES_SCHEMA, issues },
      { backup: true },
    );
  } catch (e) {
    return { ok: false, error: `Could not save ${join(root, 'issues.json')}: ${String(e)}` };
  }
  return { ok: true };
}
