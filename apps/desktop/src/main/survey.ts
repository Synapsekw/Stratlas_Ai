/**
 * Surveying in the Builder (M11): the site's survey settings (`survey/settings.json`, G1), its
 * measurements (`survey/measurements.json`, G3), the comparison templates of the project
 * (`survey/templates.json`) and of the user library (userData), its designs (`survey/designs.json`,
 * G6) and the prepared surfaces for the From and To pickers (`survey/surfaces/<id>/tiles.json`,
 * G2, built: `survey:surfaces` once main passes the registry). Every write is atomic with a `.bak`, journaled and refused for packages. The computing
 * runs as pipeline jobs (`survey.*`, `design.import`) through `jobs:start`. G0 stubs: every channel
 * answers "not available yet".
 */
import { HeightTiles, SURFACES_DIR, type IpcResponse } from '@aio/schema';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notYet, type Handle } from './notYet';
import type { ProjectRegistry } from './project';

export interface SurveyIpcDeps {
  handle: Handle;
  /** Open projects; without it the channels that read a project answer "not available yet". */
  registry?: Pick<ProjectRegistry, 'root' | 'package'>;
}

interface Archive {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}

const surfaceJson = new RegExp(`^${SURFACES_DIR}/([A-Za-z0-9][A-Za-z0-9._-]{0,79})/tiles[.]json$`);

/**
 * The prepared surfaces of a project (`survey/surfaces/<id>/tiles.json`, `aio.height-tiles/1`),
 * sorted by id, for the From and To pickers (G2). A folder without a valid `tiles.json` (a surface
 * being prepared, or one a newer build wrote) is left out; a package is read in place.
 */
export async function listSurfaces(
  src: { root: string } | { archive: Archive },
): Promise<IpcResponse<'survey:surfaces'>> {
  const texts: string[] = [];
  try {
    if ('root' in src) {
      const dir = join(src.root, ...SURFACES_DIR.split('/'));
      let names: string[] = [];
      try {
        names = (await readdir(dir, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      for (const name of names.sort()) {
        try {
          texts.push(await readFile(join(dir, name, 'tiles.json'), 'utf8'));
        } catch {
          // being prepared: no tiles.json yet
        }
      }
    } else {
      const keys = [...src.archive.entries.keys()].filter((k) => surfaceJson.test(k)).sort();
      for (const k of keys) texts.push((await src.archive.read(k)).toString('utf8'));
    }
  } catch (e) {
    return {
      ok: false,
      error: `Could not read the prepared surfaces: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const surfaces: HeightTiles[] = [];
  for (const t of texts) {
    try {
      const parsed = HeightTiles.safeParse(JSON.parse(t));
      if (parsed.success) surfaces.push(parsed.data);
    } catch {
      // not JSON: left out
    }
  }
  surfaces.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, surfaces };
}

export function registerSurveyIpc({ handle, registry }: SurveyIpcDeps): void {
  const what = 'Surveying';
  handle('survey:readSettings', () => notYet(what));
  handle('survey:writeSettings', () => notYet(what));
  handle('survey:readMeasurements', () => notYet(what));
  handle('survey:writeMeasurements', () => notYet(what));
  handle('survey:readTemplates', () => notYet(what));
  handle('survey:writeTemplates', () => notYet(what));
  handle('survey:readDesigns', () => notYet(what));
  handle('survey:writeDesigns', () => notYet(what));
  handle('survey:surfaces', ({ projectId }) => {
    if (!registry) return notYet(what);
    const pkg = registry.package(projectId);
    if (pkg) return listSurfaces({ archive: pkg.archive });
    const root = registry.root(projectId);
    if (root === undefined)
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then try again.` };
    return listSurfaces({ root });
  });
}
