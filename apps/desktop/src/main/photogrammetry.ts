/**
 * Processing photos in the Builder (M10 stream G4): the hardware probe, the estimate, the runs of
 * a project (`photogrammetry/<run>/`), ground control points (`gcp.json`, atomic with a `.bak`,
 * refused for packages), **Use refined poses** and cleaning a run's work files. The processing
 * itself runs as pipeline jobs (`photo.align`, `photo.georef`, `photo.products`) through
 * `jobs:start`. G0 stubs: every channel answers "not available yet".
 */
import { notYet, type Handle } from './notYet';

export interface PhotogrammetryIpcDeps {
  handle: Handle;
}

export function registerPhotogrammetryIpc({ handle }: PhotogrammetryIpcDeps): void {
  const what = 'Photo processing';
  handle('photo:probe', () => notYet(what));
  handle('photo:estimate', () => notYet(what));
  handle('photo:runs', () => notYet(what));
  handle('photo:readRun', () => notYet(what));
  handle('photo:readGcp', () => notYet(what));
  handle('photo:writeGcp', () => notYet(what));
  handle('photo:applyPoses', () => notYet(what));
  handle('photo:cleanWork', () => notYet(what));
}
