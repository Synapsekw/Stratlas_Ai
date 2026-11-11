/** Add-on model packs: catalogue, install, the IPC and the job gates of their features. */
export {
  addonBaseUrl,
  allowedAddonUrl,
  archiveUrl,
  DEFAULT_ADDON_BASE_URL,
  guardedFetch,
  parseCatalogue,
  readCatalogue,
} from './catalogue';
export {
  addonDir,
  addonsRoot,
  installAddonArchive,
  installedAddon,
  installedAddonDirs,
  listInstalledAddons,
  readGroundAddon,
  readInstalledAddon,
  readPointClassifier,
  removeAddon,
  sweepAddons,
  type InstalledAddon,
} from './install';
export {
  asksGround,
  depthBandRefusal,
  GROUND_PACK_FEATURE,
  groundGate,
  LIFT_PACK_FEATURE,
  liftRefusal,
  packProblem,
  RECIPE_PIPELINES,
} from './gates';
export { registerAddonsIpc, type AddonsIpcDeps } from './ipc';
