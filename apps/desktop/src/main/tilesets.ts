/**
 * 3D Tiles of a project (M10 stream G7): `<project>/tilesets.json` (`aio.tilesets/1`) read and
 * written atomically with a `.bak`, refused for packages. Tilesets are made by the `tiles.mesh` and
 * `tiles.cloud` pipelines or imported from other software. G0 stubs: both channels answer "not
 * available yet".
 */
import { notYet, type Handle } from './notYet';

export interface TilesetsIpcDeps {
  handle: Handle;
}

export function registerTilesetsIpc({ handle }: TilesetsIpcDeps): void {
  const what = '3D Tiles';
  handle('tilesets:list', () => notYet(what));
  handle('tilesets:write', () => notYet(what));
}
