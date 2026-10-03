import {
  Issue,
  parseManifest,
  validateIssueAgainstModel,
  type IpcResponse,
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

/**
 * Project id to root folder. Only registered roots are reachable through aio://project/<id>/,
 * so the renderer can never point the protocol at an arbitrary folder.
 */
export class ProjectRegistry {
  private readonly byId = new Map<string, string>();
  private readonly byKey = new Map<string, string>();

  register(root: string): string {
    const key = keyOf(root);
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const base = slugify(basename(resolve(root)));
    let id = base;
    for (let n = 2; this.byId.has(id); n++) id = `${base}-${String(n)}`;
    this.byId.set(id, resolve(root));
    this.byKey.set(key, id);
    return id;
  }

  root(id: string): string | undefined {
    return this.byId.get(id);
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

export async function openProject(
  path: string,
  registry: ProjectRegistry,
): Promise<IpcResponse<'project:open'>> {
  const root = resolve(path);
  try {
    const s = await stat(root);
    if (!s.isDirectory()) {
      return { ok: false, error: `${root} is a file. Pick the project folder instead.` };
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
