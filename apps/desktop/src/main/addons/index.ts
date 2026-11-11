/** Add-on model packs: catalogue, install, the IPC and the job gates of their features. */
export {
  addonBaseUrl,
  allowedAddonUrl,
  archiveUrl,
  DEFAULT_ADDON_BASE_URL,
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
  readInstalledAddon,
  readPointClassifier,
  removeAddon,
  type InstalledAddon,
} from './install';
export {
  asksGround,
  GROUND_PACK_FEATURE,
  groundGate,
  LIFT_PACK_FEATURE,
  liftRefusal,
} from './gates';
export { registerAddonsIpc, type AddonsIpcDeps } from './ipc';
