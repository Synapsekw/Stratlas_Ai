import { join } from 'node:path';
import { downloadVerified, type FetchLike } from './download';
import { feedUrl, parseFeed, platformKey } from './feed';
import { compareVersions } from './verify';

export interface OnlineSettings {
  offlineOnly?: boolean | undefined;
  updateCheck?: boolean | undefined;
  updateUrl?: string | undefined;
}

export interface Progress {
  received: number;
  total: number;
  phase: 'download' | 'verify' | 'keep' | 'install';
}

export interface OnlineDeps {
  settings: () => OnlineSettings;
  /**
   * Resolves once every settings change asked for so far is written (SettingsStore.settled):
   * Check now right after the switch or the address read them before they were saved.
   */
  settled?: () => Promise<void>;
  currentVersion: string;
  platform: string;
  arch: string;
  /** Fetch in the update session; called only from `check` and `downloadAndInstall`. */
  fetch: FetchLike;
  /** Folder for downloaded installers (`<userData>/updates/downloads`). */
  downloadsDir: string;
  /** Signature and version check of the downloaded file (Windows Authenticode). */
  verify: (path: string, version: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Keep this version for rollback, then run the installer (and quit on Windows). */
  install: (path: string, version: string) => Promise<{ ok: boolean; error?: string }>;
  onProgress?: (p: Progress) => void;
}

type Check =
  | { ok: true; available: boolean; version?: string; notes?: string; size?: number }
  | { ok: false; error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Optional online update (ADR 0003): one static JSON feed at the address in Settings. Off by
 * default, refused on an offline-only workstation, and never automatic: nothing here runs unless
 * the person presses Check now and then Download and install.
 */
export function createOnlineUpdater(d: OnlineDeps) {
  let found: { version: string; href: string; name: string; sha256: string; size: number } | null =
    null;
  let busy = false;

  async function refuse(): Promise<string | null> {
    await d.settled?.();
    const s = d.settings();
    if (s.offlineOnly)
      return 'This workstation is set to offline-only, so online update checks are off.';
    if (!s.updateCheck) return 'Online update checks are switched off in Settings, About.';
    if (!s.updateUrl) return 'Set the update address in Settings, About first.';
    return null;
  }

  return {
    async check(): Promise<Check> {
      const why = await refuse();
      if (why) return { ok: false, error: why };
      found = null;
      let url: string;
      try {
        url = feedUrl(d.settings().updateUrl ?? '');
      } catch {
        return { ok: false, error: 'The update address is not a valid web address.' };
      }
      let text: string;
      try {
        const res = await d.fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
        if (!res.ok) {
          await res.body?.cancel();
          return {
            ok: false,
            error: `The update feed could not be read (HTTP ${String(res.status)}) at ${url}.`,
          };
        }
        text = await res.text();
      } catch (e) {
        return { ok: false, error: `The update check failed: ${message(e)}` };
      }
      const key = platformKey(d.platform, d.arch);
      const parsed = parseFeed(text, url, key);
      if (!parsed.ok) return parsed;
      const { feed, file } = parsed;
      const available = compareVersions(feed.version, d.currentVersion) > 0;
      if (available && !file) {
        return {
          ok: false,
          error: `Version ${feed.version} is out, but the feed has no installer for this computer (${key ?? d.platform}).`,
        };
      }
      if (available && file) {
        found = {
          version: feed.version,
          href: file.href,
          name: file.name,
          sha256: file.sha256,
          size: file.size,
        };
      }
      return {
        ok: true,
        available,
        version: feed.version,
        ...(available && feed.notes ? { notes: feed.notes } : {}),
        ...(available && file ? { size: file.size } : {}),
      };
    },

    async downloadAndInstall(): Promise<{ ok: boolean; error?: string }> {
      const why = await refuse();
      if (why) return { ok: false, error: why };
      if (!found) return { ok: false, error: 'Check for updates first.' };
      if (busy) return { ok: false, error: 'The update is already downloading.' };
      busy = true;
      const f = found;
      const path = join(d.downloadsDir, f.name);
      try {
        await downloadVerified({
          url: f.href,
          sha256: f.sha256,
          size: f.size,
          dest: path,
          fetch: d.fetch,
          onProgress: (received, total) => d.onProgress?.({ received, total, phase: 'download' }),
        });
        d.onProgress?.({ received: f.size, total: f.size, phase: 'verify' });
        const v = await d.verify(path, f.version);
        if (!v.ok) return { ok: false, error: v.error };
        d.onProgress?.({ received: f.size, total: f.size, phase: 'keep' });
        return await d.install(path, f.version);
      } catch (e) {
        return { ok: false, error: `The update could not be downloaded: ${message(e)}` };
      } finally {
        busy = false;
      }
    },
  };
}
