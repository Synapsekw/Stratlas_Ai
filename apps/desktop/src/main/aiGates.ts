import type { Settings } from '@aio/schema';

/**
 * What every cloud AI path asks before it calls out: the agent runtime, the provider's own request
 * and the local model IPC share these, so they cannot disagree. Both read `current()`, which shows
 * a change from the moment it is asked for: offline-only turned on refuses the very next call,
 * before the settings file is written.
 */
export function aiGates(
  settings: { current(): Settings },
  policy: { cloudAllowed(setting: boolean): boolean },
): { offlineOnly: () => boolean; cloudAllowed: () => boolean } {
  return {
    // Offline-only is the stronger switch: no cloud AI while it is on, whatever `cloudAi` says.
    offlineOnly: () => settings.current().offlineOnly === true,
    // Cloud AI also needs the open package's permission (AI-2, default forbid).
    cloudAllowed: () => policy.cloudAllowed(settings.current().cloudAi),
  };
}
