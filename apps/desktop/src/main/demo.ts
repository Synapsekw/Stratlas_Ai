import type { LibraryEntry } from '@aio/schema';
import { cp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';

/**
 * Demo projects that ship with the app (synthetic data from tools/demo/build-demo.mjs; Store
 * certification and a first start need the app to be usable with no client data). A packaged app
 * looks in `resources/demo/` (electron-builder `extraResources` from `apps/desktop/demo/`);
 * development builds and tests use the folder in STRATLAS_DEMO.
 *
 * The bundled folder is never written: the installed app may be read only (MSIX) and an update
 * replaces it. Opening a demo project opens a working copy in userData `demo/<id>/`, made on the
 * first open and replaced when a newer app ships a different demo build (`demo.json` `build`).
 */
export function demoRoot(o: {
  env: Record<string, string | undefined>;
  packaged: boolean;
  resourcesPath: string;
}): string | undefined {
  return o.env.STRATLAS_DEMO ?? (o.packaged ? join(o.resourcesPath, 'demo') : undefined);
}

/** `demo.json` beside the bundled projects (written by tools/demo/build-demo.mjs). */
const DemoInfo = z.object({
  schema: z.literal('aio.demo/1'),
  build: z.string().min(1),
  primary: z.string().optional(),
});

export interface DemoSet {
  root: string;
  /** Build stamp; working copies of another build are replaced. */
  build: string;
  /** Folder name of the project the welcome opens. */
  primary: string | undefined;
  /** Bundled project folders. */
  projects: string[];
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** The bundled demo projects, or null when the app ships none. */
export async function findDemos(root: string | undefined): Promise<DemoSet | null> {
  if (!root) return null;
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return null;
  }
  const projects: string[] = [];
  for (const name of names)
    if (await isFile(join(root, name, 'manifest.json'))) projects.push(join(root, name));
  if (projects.length === 0) return null;
  let info: z.infer<typeof DemoInfo> | null = null;
  try {
    const r = DemoInfo.safeParse(JSON.parse(await readFile(join(root, 'demo.json'), 'utf8')));
    if (r.success) info = r.data;
  } catch {
    // an older demo folder without demo.json: the projects still list
  }
  return {
    root,
    build: info?.build ?? 'unversioned',
    primary: info?.primary ?? projects[0]?.split(sep).pop(),
    projects,
  };
}

/** Folders of the bundled demo projects (the library lists their working copy when one exists). */
export async function demoProjectPaths(o: {
  env: Record<string, string | undefined>;
  packaged: boolean;
  resourcesPath: string;
}): Promise<string[]> {
  return (await findDemos(demoRoot(o)))?.projects ?? [];
}

const Copies = z.record(z.string(), z.string());
const COPIES = 'copies.json';

const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

async function copies(copyRoot: string): Promise<Record<string, string>> {
  try {
    const r = Copies.safeParse(await readJson(join(copyRoot, COPIES)));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

/** The working copy of a bundled project when it exists and matches this build, else null. */
async function currentCopy(
  demos: DemoSet,
  project: string,
  copyRoot: string,
): Promise<string | null> {
  const id = project.split(sep).pop() ?? '';
  const dir = join(copyRoot, id);
  if ((await copies(copyRoot))[id] !== demos.build) return null;
  return (await isFile(join(dir, 'manifest.json'))) ? dir : null;
}

/**
 * Library paths of the demo projects: the working copy when it is current, else the bundled
 * folder (opening it makes the copy). `primary` marks the one the welcome opens.
 */
export async function demoLibraryPaths(
  demos: DemoSet | null,
  copyRoot: string,
): Promise<{ path: string; primary: boolean }[]> {
  if (!demos) return [];
  const out: { path: string; primary: boolean }[] = [];
  for (const p of demos.projects) {
    const id = p.split(sep).pop();
    out.push({
      path: (await currentCopy(demos, p, copyRoot)) ?? p,
      primary: id === demos.primary,
    });
  }
  return out;
}

/** Mark the library entries that are demo projects (bundled or their working copies). */
export function markDemoEntries(
  entries: LibraryEntry[],
  paths: { path: string; primary: boolean }[],
): LibraryEntry[] {
  const byKey = new Map(paths.map((p) => [key(p.path), p.primary]));
  return entries.map((e) => {
    const primary = byKey.get(key(e.path));
    return primary === undefined ? e : { ...e, demo: { primary } };
  });
}

/**
 * The folder to open for `path`: a bundled demo project opens as its working copy in `copyRoot`
 * (copied now when missing or from another build); any other path is returned as given.
 */
export async function demoOpenPath(
  path: string,
  demos: DemoSet | null,
  copyRoot: string,
): Promise<string> {
  if (!demos) return path;
  const rel = relative(resolve(demos.root), resolve(path));
  if (rel === '' || rel.startsWith('..') || rel.includes(sep) || rel.includes('/')) return path;
  const project = demos.projects.find((p) => key(p) === key(path));
  if (!project) return path;
  const current = await currentCopy(demos, project, copyRoot);
  if (current) return current;
  const id = rel;
  const dir = join(copyRoot, id);
  const staging = join(copyRoot, `.${id}-${String(process.pid)}-${String(Date.now())}`);
  try {
    await rm(staging, { recursive: true, force: true });
    await cp(project, staging, { recursive: true });
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
    await writeJsonAtomic(join(copyRoot, COPIES), {
      ...(await copies(copyRoot)),
      [id]: demos.build,
    });
    return dir;
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    console.warn(`Demo: could not make a working copy of ${project}: ${String(e)}`);
    return path;
  }
}
