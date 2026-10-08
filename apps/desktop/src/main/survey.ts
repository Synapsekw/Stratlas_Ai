/**
 * Surveying in the Builder (M11): the site's survey settings (`survey/settings.json`, G1), its
 * measurements (`survey/measurements.json`, G3), the comparison templates of the project
 * (`survey/templates.json`) and of the user library (userData), its designs (`survey/designs.json`,
 * G6) and the prepared surfaces for the From and To pickers (`survey/surfaces/<id>/tiles.json`,
 * G2). Every write is atomic with a `.bak`, journaled and refused for packages. The computing
 * runs as pipeline jobs (`survey.*`, `design.import`) through `jobs:start`. The site settings are
 * G1's (`geodesy.ts`); the other channels are G0 stubs answering "not available yet".
 */
import {
  surveySettingsHandlers,
  type GeodesyProjects,
  type JournalAppend,
  type PackageArchive,
} from './geodesy';
import { notYet, type Handle } from './notYet';

export interface SurveyIpcDeps {
  handle: Handle;
  projects?: GeodesyProjects;
  projectPackage?: (id: string) => PackageArchive | undefined;
  journal?: JournalAppend;
}

export function registerSurveyIpc({ handle, ...deps }: SurveyIpcDeps): void {
  const what = 'Surveying';
  const settings = surveySettingsHandlers(deps);
  handle('survey:readSettings', settings.read);
  handle('survey:writeSettings', settings.write);
  handle('survey:readMeasurements', () => notYet(what));
  handle('survey:writeMeasurements', () => notYet(what));
  handle('survey:readTemplates', () => notYet(what));
  handle('survey:writeTemplates', () => notYet(what));
  handle('survey:readDesigns', () => notYet(what));
  handle('survey:writeDesigns', () => notYet(what));
  handle('survey:surfaces', () => notYet(what));
}
