/**
 * Coordinates of a site (M11 stream G1): searching the EPSG catalogue for the site's CRS, and
 * reading and applying the site calibration (`survey/calibration.json`, journaled
 * `survey.calibration`, refused for packages). A calibration is solved from a controller file or
 * point pairs by the `geo.calibration` pipeline. G0 stubs: every channel answers "not available
 * yet".
 */
import { notYet, type Handle } from './notYet';

export interface GeodesyIpcDeps {
  handle: Handle;
}

export function registerGeodesyIpc({ handle }: GeodesyIpcDeps): void {
  const what = 'Coordinate systems and calibration';
  handle('geodesy:searchCrs', () => notYet(what));
  handle('geodesy:readCalibration', () => notYet(what));
  handle('geodesy:applyCalibration', () => notYet(what));
}
