/**
 * Haul-road compliance runs (M11 G11, PRD HRD-1; data-conventions section 30): `haul.analyse`
 * writes `survey/haul/<run>/run.json` (`aio.haul-run/1`) and `haul.geojson`; the app only lists
 * them (`survey:readHaulRuns`). Runs start as pipeline jobs through `jobs:start`. A package is read
 * in place. A folder without a valid run (a run being written, or one a newer build wrote) is left
 * out, so one bad file never hides the others.
 */
import { HAUL_DIR, HaulRun, type IpcResponse } from '@aio/schema';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notYet, type Handle } from './notYet';
import type { SurveyArchive } from './survey';

const runJson = new RegExp(`^${HAUL_DIR}/([A-Za-z0-9][A-Za-z0-9._-]{0,79})/run[.]json$`);

/** The runs of a project, newest first (then by id). */
export async function listHaulRuns(
  src: { root: string } | { archive: SurveyArchive },
): Promise<IpcResponse<'survey:readHaulRuns'>> {
  const texts: string[] = [];
  try {
    if ('root' in src) {
      const dir = join(src.root, ...HAUL_DIR.split('/'));
      let names: string[] = [];
      try {
        names = (await readdir(dir, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      for (const name of names) {
        try {
          texts.push(await readFile(join(dir, name, 'run.json'), 'utf8'));
        } catch {
          // being written: no run.json yet
        }
      }
    } else {
      const keys = [...src.archive.entries.keys()].filter((k) => runJson.test(k));
      for (const k of keys) texts.push((await src.archive.read(k)).toString('utf8'));
    }
  } catch (e) {
    return {
      ok: false,
      error: `Could not read the haul-road runs: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const runs: HaulRun[] = [];
  for (const t of texts) {
    try {
      const parsed = HaulRun.safeParse(JSON.parse(t));
      if (parsed.success) runs.push(parsed.data);
    } catch {
      // not JSON: left out
    }
  }
  runs.sort((a, b) =>
    a.computedAt !== b.computedAt
      ? a.computedAt < b.computedAt
        ? 1
        : -1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
  return { ok: true, runs };
}

export interface SurveyHaulDeps {
  handle: Handle;
  projects?: { root(id: string): string | undefined; package(id: string): unknown };
  /** The archive of an open package, for read-only reads. */
  projectPackage?: (id: string) => SurveyArchive | undefined;
}

export function registerSurveyHaulIpc({ handle, projects, projectPackage }: SurveyHaulDeps): void {
  handle('survey:readHaulRuns', ({ projectId }) => {
    if (!projects) return notYet('Haul-road compliance');
    const root = projects.root(projectId);
    if (root !== undefined) return listHaulRuns({ root });
    if (projects.package(projectId)) {
      const archive = projectPackage?.(projectId);
      return archive ? listHaulRuns({ archive }) : { ok: true, runs: [] };
    }
    return { ok: false, error: `Project "${projectId}" is not open. Open it, then try again.` };
  });
}
