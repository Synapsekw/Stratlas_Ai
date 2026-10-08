/**
 * Surveying in the Builder (M11): the site's survey settings (`survey/settings.json`, G1), its
 * measurements (`survey/measurements.json`, G3), the comparison templates of the project
 * (`survey/templates.json`) and of the user library (userData), its designs (`survey/designs.json`,
 * G6) and the prepared surfaces for the From and To pickers (`survey/surfaces/<id>/tiles.json`,
 * G2). Every write is atomic with a `.bak`, journaled and refused for packages. The computing
 * runs as pipeline jobs (`survey.*`, `design.import`) through `jobs:start`. G0 stubs: every channel
 * answers "not available yet".
 */
import { notYet, type Handle } from './notYet';
import { readDesigns, readPackageDesigns, writeDesigns } from './surveyDesigns';

/** The open projects (main's `ProjectRegistry`): a folder's root, or a read-only package. */
export interface SurveyProjects {
  root(id: string): string | undefined;
  package(
    id: string,
  ):
    | { archive: { entries: ReadonlyMap<string, unknown>; read(name: string): Promise<Buffer> } }
    | undefined;
}

export interface SurveyIpcDeps {
  handle: Handle;
  /** Without it (G0 tests) the designs channels answer "not available yet". */
  projects?: SurveyProjects;
}

export function registerSurveyIpc({ handle, projects }: SurveyIpcDeps): void {
  const what = 'Surveying';
  handle('survey:readSettings', () => notYet(what));
  handle('survey:writeSettings', () => notYet(what));
  handle('survey:readMeasurements', () => notYet(what));
  handle('survey:writeMeasurements', () => notYet(what));
  handle('survey:readTemplates', () => notYet(what));
  handle('survey:writeTemplates', () => notYet(what));
  // designs (G6): surveyDesigns.ts
  handle('survey:readDesigns', ({ projectId }) => {
    if (!projects) return notYet(what);
    const root = projects.root(projectId);
    if (root !== undefined) return readDesigns(root);
    const pkg = projects.package(projectId);
    if (pkg) return readPackageDesigns(pkg.archive);
    return { ok: false, error: `Project "${projectId}" is not open.` };
  });
  handle('survey:writeDesigns', ({ projectId, file }) => {
    if (!projects) return notYet(what);
    if (projects.package(projectId))
      return {
        ok: false,
        error: 'This project is a read-only package. Its designs cannot be changed.',
      };
    const root = projects.root(projectId);
    if (root === undefined)
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then try again.` };
    return writeDesigns(root, file);
  });
  handle('survey:surfaces', () => notYet(what));
}
