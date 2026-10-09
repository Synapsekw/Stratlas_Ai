/**
 * The site's hydrology runs (M11 G10, data-conventions section 30): each `hydro.flood`,
 * `hydro.flow` or `hydro.rainfall` job writes `survey/hydro/<run>/run.json` (`aio.hydro-run/1`)
 * beside its outputs; `survey:readHydroRuns` lists them, newest first. A package's runs are read
 * from the archive in place. Read only: the runs are written by the pipeline pack, and the
 * renderer reads their files through the asset protocol. A run file that does not parse, that a
 * newer build wrote, or whose `id` is not its folder's name is left out of the list.
 */
import { HYDRO_DIR, HYDRO_RUN_FILE, HydroRun, type IpcResponse } from '@aio/schema';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonSeen } from './fsutil';
import { newerThanThisBuild } from './newer';
import { notYet, type Handle } from './notYet';

const FAMILY = 'aio.hydro-run';

/** A package's archive, read in place (members by project-relative name). */
export interface HydroArchive {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}

export interface SurveyHydroDeps {
  handle: Handle;
  projects?: { root(id: string): string | undefined; package(id: string): unknown };
  projectPackage?: (id: string) => HydroArchive | undefined;
}

type Runs = IpcResponse<'survey:readHydroRuns'>;

function parse(raw: unknown, rel: string): HydroRun | null {
  if (newerThanThisBuild(raw, FAMILY, rel)) return null;
  const r = HydroRun.safeParse(raw);
  return r.success ? r.data : null;
}

function newestFirst(runs: HydroRun[]): HydroRun[] {
  return runs.sort((a, b) =>
    a.computedAt < b.computedAt ? 1 : a.computedAt > b.computedAt ? -1 : a.id < b.id ? -1 : 1,
  );
}

/** The runs in a project folder (none when it has no `survey/hydro/`). */
export async function readHydroRuns(root: string): Promise<Runs> {
  const dir = join(root, ...HYDRO_DIR.split('/'));
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, runs: [] };
    return { ok: false, error: `Could not read the hydrology runs: ${String(e)}` };
  }
  const runs: HydroRun[] = [];
  for (const name of names) {
    const rel = `${HYDRO_DIR}/${name}/${HYDRO_RUN_FILE}`;
    let raw: unknown;
    try {
      raw = await readJsonSeen(join(dir, name, HYDRO_RUN_FILE));
    } catch {
      continue;
    }
    const run = raw === undefined ? null : parse(raw, rel);
    if (run?.id === name) runs.push(run);
  }
  return { ok: true, runs: newestFirst(runs) };
}

/** A package's runs, read from the archive in place. */
export async function readPackageHydroRuns(archive: HydroArchive): Promise<Runs> {
  const re = new RegExp(`^${HYDRO_DIR}/([^/]+)/${HYDRO_RUN_FILE.replace('.', '\\.')}$`);
  const runs: HydroRun[] = [];
  for (const name of archive.entries.keys()) {
    const m = re.exec(name);
    if (!m) continue;
    try {
      const run = parse(JSON.parse((await archive.read(name)).toString('utf8')) as unknown, name);
      if (run?.id === m[1]) runs.push(run);
    } catch {
      // not JSON: left out
    }
  }
  return { ok: true, runs: newestFirst(runs) };
}

export function registerSurveyHydroIpc({
  handle,
  projects,
  projectPackage,
}: SurveyHydroDeps): void {
  handle('survey:readHydroRuns', ({ projectId }) => {
    if (!projects) return notYet('Hydrology');
    const root = projects.root(projectId);
    if (root !== undefined) return readHydroRuns(root);
    if (projects.package(projectId)) {
      const archive = projectPackage?.(projectId);
      return archive ? readPackageHydroRuns(archive) : { ok: true, runs: [] };
    }
    return { ok: false, error: `Project "${projectId}" is not open. Open it, then try again.` };
  });
}
