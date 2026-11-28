// The private inputs of the landing preview, and the guard against private names.
//
// The preview is built from projects and prepared assets that are not in the repository. No script
// in this folder names them: each one asks here for the folder it needs, and the answer comes from
// the environment. The variables are one family, QUADRION_PREVIEW_<NAME> (the older
// STRATLAS_PREVIEW_<NAME> works too); the README lists them. A script that needs a variable that is
// not set stops with one line naming it.
//
// The check scripts guard the pages against client and site names with the same list the
// repository's own check uses (tools/agent/check-public-text.mjs), so no name is written here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar } from '../../../packages/brand/src/env.ts';
import { findNames, forbiddenWords } from '../../../tools/agent/check-public-text.mjs';
import { referenceSites } from '../../../tools/demo/check-no-client-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '../assets');

/** The value of QUADRION_PREVIEW_<name>, or undefined. */
export const previewEnv = (name) => envVar(process.env, 'PREVIEW_' + name) || undefined;

/** The value of QUADRION_PREVIEW_<name>; stops the script with a plain message when it is unset. */
export function requiredEnv(name, what) {
  const value = previewEnv(name);
  if (value) return value;
  console.error(`QUADRION_PREVIEW_${name} is not set. Set it to ${what}.`);
  process.exit(1);
}

/** A private source project: an absolute path, or a folder name under QUADRION_PREVIEW_PROJECTS. */
export function projectFolder(name, what) {
  const value = requiredEnv(name, what);
  if (path.isAbsolute(value)) return value;
  return path.resolve(
    requiredEnv('PROJECTS', 'the folder that holds the private source projects'),
    value,
  );
}

/** The flare-stack project. The variable it had before the family existed still works. */
export const flareProject = () =>
  envVar(process.env, 'FLARE_SOURCE') ||
  projectFolder('FLARE_PROJECT', 'the flare-stack source project (a path, or a folder name)');

/** A prepared private asset folder: an absolute path, or a folder name under docs/design/assets. */
export const assetFolder = (name, what) => path.resolve(assets, requiredEnv(name, what));

let words;
/** The client and site names found in `text`, by the repository's shared list. Empty when clean. */
export function privateNames(text) {
  if (!words) {
    const dataRoot =
      envVar(process.env, 'DATA') ?? (process.platform === 'win32' ? 'E:\\Stratlas Data' : '');
    words = forbiddenWords(referenceSites(path.join(dataRoot, 'projects')).names);
  }
  return [...new Set(findNames(String(text), 'text', words).map((f) => f.replace(/^.*?: /, '')))];
}
