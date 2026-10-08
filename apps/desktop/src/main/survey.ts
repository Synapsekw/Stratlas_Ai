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

export interface SurveyIpcDeps {
  handle: Handle;
}

export function registerSurveyIpc({ handle }: SurveyIpcDeps): void {
  const what = 'Surveying';
  handle('survey:readSettings', () => notYet(what));
  handle('survey:writeSettings', () => notYet(what));
  handle('survey:readMeasurements', () => notYet(what));
  handle('survey:writeMeasurements', () => notYet(what));
  handle('survey:readTemplates', () => notYet(what));
  handle('survey:writeTemplates', () => notYet(what));
  handle('survey:readDesigns', () => notYet(what));
  handle('survey:writeDesigns', () => notYet(what));
  handle('survey:surfaces', () => notYet(what));
}
