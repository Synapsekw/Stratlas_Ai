// M11 G9: what main tells the house report page about a project's survey data. The page computes
// the survey sections and CSVs itself (survey engine, `reportPage/house/surveyData.ts`); it cannot
// list folders, so main names the prepared surfaces, and refuses a survey export before the save
// dialog when there is nothing to report.
import { listSurfaces, readMeasurements, type SurveyProjects } from '../survey';

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
