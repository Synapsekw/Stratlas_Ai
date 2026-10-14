import { join, win32 } from 'node:path';

/**
 * Whether ODM copes with a space in its paths (C5): it does not. ODM's SMRF ground command is
 * unquoted, so a space gives zero ground points and a DTM that never finishes.
 */
export const SPACES_OK = false;

/** Characters `cmd.exe` treats specially; ODM's command lines pass through it. */
const CMD_SPECIAL = /[&^%!()<>|"]/;

/**
 * A path ODM can be given: a drive path of printable ASCII (no space unless `SPACES_OK`) without
 * `cmd.exe` metacharacters. `~` is fine, so 8.3 short names such as `RUNNER~1` pass. The same rule
 * as the pipelines' `photo/odm/project.py`.
 */
export function isSafeOdmPath(p: string): boolean {
  if (!/^[A-Za-z]:\\/.test(p)) return false;
  const chars = (SPACES_OK as boolean) ? /^[\x20-\x7e]*$/ : /^[\x21-\x7e]*$/;
  return chars.test(p) && !CMD_SPECIAL.test(p);
}

/** `<dataRoot>/runtime/odm.json`: the ODM this app installed. */
export function odmRecordPath(dataRoot: string): string {
  return join(dataRoot, 'runtime', 'odm.json');
}

/** Where the setup is downloaded to. */
export function downloadDir(dataRoot: string): string {
  return join(dataRoot, 'runtime', 'downloads');
}

/**
 * Where ODM is installed. Inno's setup takes `/DIR=` as given and ODM's commands run from there,
 * so the folder must be safe too (C5): the data root's `runtime`, else local app data, else the
 * system drive.
 */
export function odmInstallDir(
  dataRoot: string,
  env: Record<string, string | undefined>,
  version: string,
): string {
  const name = `odm-${version}`;
  const inData = win32.join(dataRoot, 'runtime', name);
  if (isSafeOdmPath(inData)) return inData;
  if (env.LOCALAPPDATA) {
    const local = win32.join(env.LOCALAPPDATA, 'QuadrionODM', name);
    if (isSafeOdmPath(local)) return local;
  }
  return win32.join(env.SystemDrive ?? 'C:', '\\', 'QuadrionODM', name);
}

/** Beside the install folder: where project folders with unsafe paths get their junctions. */
export function odmWorkRoot(installDir: string): string {
  return win32.join(win32.dirname(installDir), 'odm-work');
}
