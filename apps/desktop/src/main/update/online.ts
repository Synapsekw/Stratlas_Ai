import { compareVersions } from './verify';

/** The slice of electron-updater's AppUpdater this module uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface OnlineSettings {
  offlineOnly?: boolean | undefined;
  updateCheck?: boolean | undefined;
  updateUrl?: string | undefined;
}

export interface OnlineDeps {
  settings: () => OnlineSettings;
  currentVersion: string;
  /** Loads electron-updater lazily, so nothing update-related runs unless the person asks. */
  load: () => Promise<UpdaterLike>;
}

type Check = { ok: true; available: boolean; version?: string } | { ok: false; error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Optional online update check (electron-updater, `generic` provider) against the address in
 * Settings. Off by default, refused on an offline-only workstation, and never automatic.
 */
export function createOnlineUpdater(d: OnlineDeps) {
  let found: string | null = null;
  let updater: UpdaterLike | null = null;

  function refuse(): string | null {
    const s = d.settings();
    if (s.offlineOnly)
      return 'This workstation is set to offline-only, so online update checks are off.';
    if (!s.updateCheck) return 'Online update checks are switched off in Settings, About.';
    if (!s.updateUrl) return 'Set the update address in Settings, About first.';
    return null;
  }

  return {
    async check(): Promise<Check> {
      const why = refuse();
      if (why) return { ok: false, error: why };
      try {
        updater ??= await d.load();
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.setFeedURL({ provider: 'generic', url: d.settings().updateUrl ?? '' });
        const r = await updater.checkForUpdates();
        if (!r) {
          return {
            ok: false,
            error: 'Update checks work in the installed app, not in a development build.',
          };
        }
        const version = r.updateInfo.version;
        const available = compareVersions(version, d.currentVersion) > 0;
        found = available ? version : null;
        return { ok: true, available, version };
      } catch (e) {
        return { ok: false, error: `The update check failed: ${message(e)}` };
      }
    },

    async downloadAndInstall(): Promise<{ ok: boolean; error?: string }> {
      const why = refuse();
      if (why) return { ok: false, error: why };
      if (!updater || !found) return { ok: false, error: 'Check for updates first.' };
      try {
        await updater.downloadUpdate();
        updater.quitAndInstall(false, true);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `The update could not be downloaded: ${message(e)}` };
      }
    },
  };
}
