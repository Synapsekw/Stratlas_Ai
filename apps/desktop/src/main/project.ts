import { openPackage, type ZipArchive } from '@aio/project/package';
import {
  Issue,
  PACKAGE_EXTENSION,
  PACKAGE_ORIGIN_FILE,
  PackageOrigin,
  parseManifest,
  validateIssueAgainstModel,
  type IpcResponse,
  type PackageHeader,
  type ProjectManifest,
  type WalkLayer,
} from '@aio/schema';
import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { walkLayersInMemory } from './walks';
import { z } from 'zod';
import {
  isChangedOnDisk,
  readJson,
  readJsonSeen,
  seenFiles,
  writeJsonSeen,
  type SeenFiles,
} from './fsutil';

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

  /** Where an id points on disk: a project folder or a `.aio` file (opened or still locked). */
  path(id: string): string | undefined {
    return this.byId.get(id);
  }

  /** Every package opened in this session, by project id. */
  openPackages(): [string, PackageSource][] {
    return [...this.packages.entries()];
  }
}

type Loaded<T> = { ok: true; value: T } | { ok: false; error: string };

async function loadJsonFile(
  file: string,
  what: string,
  seen?: SeenFiles,
): Promise<Loaded<unknown>> {
  try {
    return { ok: true, value: await (seen ? readJsonSeen(file, seen) : readJson(file)) };
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

/**
 * Read `<root>/issues.json`; a missing file means no issues yet. With `seen` (the read the
 * person sees, `project:open`), what was read is remembered so the next save compares first.
 */
export async function readIssues(root: string, seen?: SeenFiles): Promise<Loaded<Issue[]>> {
  const file = join(root, 'issues.json');
  const raw = await loadJsonFile(file, 'issues.json (issues.json.bak)', seen);
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

export function parseIssues(raw: unknown, where: string, fix: string): Loaded<Issue[]> {
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
  const { archive, header, issuesJson } = r.value;
  // walks filed beside the manifest by an older build are layers here, in memory only
  const walkLayers = await walkLayersInMemory(archive, r.value.manifest).catch(() => []);
  const manifest =
    walkLayers.length > 0
      ? { ...r.value.manifest, layers: [...r.value.manifest.layers, ...walkLayers] }
      : r.value.manifest;
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
  /** The project log: one line per notable thing that happened while opening. */
  log: (line: string) => void = () => undefined,
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
  let manifest = await readManifest(root);
  if (!manifest.ok) return manifest;
  manifest = await withWalkLayers(root, manifest, log);
  if (!manifest.ok) return manifest;
  const issues = await readIssues(root, seenFiles);
  if (!issues.ok) return issues;
  const id = registry.register(root);
  const origin = await readOrigin(root);
  return {
    ok: true,
    id,
    root,
    manifest: manifest.value,
    issues: issues.value,
    ...(origin ? { origin } : {}),
  };
}

/** What opening a project uses of the builder; tests hand in others. */
export interface WalkOpenTools {
  migrateWalks(root: string): Promise<{ added: WalkLayer[]; saved: boolean; error?: string }>;
  refreshWalkPaths(root: string): Promise<string[]>;
  /** Clears what `.trash/` holds from more than seven days ago. */
  sweepTrash?(root: string): Promise<string[]>;
}

const walkOpenTools = (): Promise<WalkOpenTools> => import('@aio/project/builder');

/**
 * Walks filed beside the manifest before they were layers become layers now (the walk layer and
 * placing, "Migration on open"), and the files a `walk.process` job wrote since are linked. Each
 * step has its own guard, so one failing never stops the other. The manifest is read again
 * whenever a step saved. When the migration cannot save, its layers are still answered, in memory
 * only, and the failure is logged. Never fails the open.
 */
export async function withWalkLayers(
  root: string,
  manifest: Loaded<ProjectManifest>,
  log: (line: string) => void,
  tools: () => Promise<WalkOpenTools> = walkOpenTools,
): Promise<Loaded<ProjectManifest>> {
  if (!manifest.ok) return manifest;
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let t: WalkOpenTools;
  try {
    t = await tools();
  } catch (e) {
    log(`Walks were not turned into layers: ${why(e)}`);
    return manifest;
  }
  let added: WalkLayer[] = [];
  let changed = false;
  let unsaved = false;
  try {
    const m = await t.migrateWalks(root);
    added = m.added;
    changed = m.saved;
    if (m.error !== undefined) {
      unsaved = true;
      log(`The walk layers could not be saved: ${m.error}`);
    }
  } catch (e) {
    log(`Walks were not turned into layers: ${why(e)}`);
  }
  if (added.length > 0) {
    const n = added.length;
    log(`${String(n)} ${n === 1 ? 'walk' : 'walks'} became ${n === 1 ? 'a layer' : 'layers'}`);
  }
  try {
    if ((await t.refreshWalkPaths(root)).length > 0) changed = true;
  } catch (e) {
    log(`The files of the walks were not linked: ${why(e)}`);
  }
  try {
    await t.sweepTrash?.(root);
  } catch (e) {
    log(`The removed walks were not cleared: ${why(e)}`);
  }
  if (changed) {
    const again = await readManifest(root);
    if (again.ok) {
      return unsaved
        ? { ok: true, value: { ...again.value, layers: [...again.value.layers, ...added] } }
        : again;
    }
  }
  if (unsaved)
    return { ok: true, value: { ...manifest.value, layers: [...manifest.value.layers, ...added] } };
  return manifest;
}

/** `package-origin.json` of a project extracted from a package; null when absent or not valid. */
async function readOrigin(root: string): Promise<PackageOrigin | null> {
  try {
    const r = PackageOrigin.safeParse(await readJson(join(root, PACKAGE_ORIGIN_FILE)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
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

/**
 * Validate issues against the project's severity models, then replace issues.json atomically,
 * unless it changed on disk since the project was opened or last saved here (shared folders).
 */
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
    await writeJsonSeen(
      join(root, 'issues.json'),
      { schema: ISSUES_SCHEMA, issues },
      { backup: true },
    );
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `Could not save ${join(root, 'issues.json')}: ${String(e)}` };
  }
  return { ok: true };
}
