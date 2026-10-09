// M11 G9: what main tells the house report page about a project's survey data. The page computes
// the survey sections and CSVs itself (survey engine, `reportPage/house/surveyData.ts`); it cannot
// list folders, so main names the prepared surfaces, and refuses a survey export before the save
// dialog when there is nothing to report.
import { listSurfaces, readMeasurements, type SurveyProjects } from '../survey';
import { listHaulRuns } from '../surveyHaul';
import { readHydroRuns, readPackageHydroRuns } from '../surveyHydro';

/** Ids of the project's prepared surfaces (`survey/surfaces/<id>/tiles.json`); none when unread. */
export async function surveySurfaceIds(
  projects: SurveyProjects,
  projectId: string,
): Promise<string[]> {
  const root = projects.root(projectId);
  const pkg = root === undefined ? projects.package(projectId) : undefined;
  const src = root !== undefined ? { root } : pkg ? { archive: pkg.archive } : null;
  if (!src) return [];
  const r = await listSurfaces(src);
  return r.ok ? r.surfaces.map((s) => s.id) : [];
}

/** Does the project have saved survey measurements? */
export async function hasSurveyMeasurements(
  projects: SurveyProjects,
  projectId: string,
): Promise<boolean> {
  const r = await readMeasurements(projects, projectId);
  return r.ok && r.file.measurements.length > 0;
}

/** Report sections drawn from the site's runs: the most runs of each kind the report prints. */
export const REPORT_RUNS_MAX = 10;

/**
 * Ids of the project's haul-road compliance and hydrology runs (`survey/haul/<id>/run.json`,
 * `survey/hydro/<id>/run.json`), newest first, as `survey:readHaulRuns` and `survey:readHydroRuns`
 * list them; the house report's `haul` and `hydrology` sections read them. None when unread.
 */
export async function surveyRunIds(
  projects: SurveyProjects,
  projectId: string,
): Promise<{ haul: string[]; hydro: string[] }> {
  const root = projects.root(projectId);
  const pkg = root === undefined ? projects.package(projectId) : undefined;
  if (root === undefined && !pkg) return { haul: [], hydro: [] };
  const [haul, hydro] = await Promise.all([
    root !== undefined
      ? listHaulRuns({ root })
      : pkg
        ? listHaulRuns({ archive: pkg.archive })
        : null,
    root !== undefined ? readHydroRuns(root) : pkg ? readPackageHydroRuns(pkg.archive) : null,
  ]);
  const ids = (r: { ok: true; runs: { id: string }[] } | { ok: false } | null) =>
    r?.ok ? r.runs.slice(0, REPORT_RUNS_MAX).map((x) => x.id) : [];
  return { haul: ids(haul), hydro: ids(hydro) };
}
