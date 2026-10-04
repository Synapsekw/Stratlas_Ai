import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Demo projects that ship with the app (Store certification needs the app to be usable with no
 * client data). A packaged app looks in `resources/demo/<project>/manifest.json`
 * (electron-builder `extraResources` from `apps/desktop/demo/`); development builds use the
 * folder in STRATLAS_DEMO. They are listed in the library next to the data folder's projects.
 */
export async function demoProjectPaths(o: {
  env: Record<string, string | undefined>;
  packaged: boolean;
  resourcesPath: string;
}): Promise<string[]> {
  const root = o.env.STRATLAS_DEMO ?? (o.packaged ? join(o.resourcesPath, 'demo') : undefined);
  if (!root) return [];
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    try {
      if ((await stat(join(root, name, 'manifest.json'))).isFile()) found.push(join(root, name));
    } catch {
      // not a project folder
    }
  }
  return found;
}
