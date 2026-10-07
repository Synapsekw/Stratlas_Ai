import { z } from 'zod';

/**
 * userData `launch.json` (`aio.launch-settings/1`): the launch screen preference (Settings,
 * Appearance, Show launch screen). Its own file, not a `Settings` field, so `settings.json` keeps
 * exactly the keys a 0.9 build reads (its settings schema is strict). A missing file, or a missing
 * `show`, means the launch screen is shown.
 */
export const LAUNCH_SETTINGS_FILE = 'launch.json';
export const LAUNCH_SETTINGS_SCHEMA = 'aio.launch-settings/1' as const;

export const LaunchSettings = z.looseObject({
  schema: z.literal(LAUNCH_SETTINGS_SCHEMA),
  /** Show the launch screen when the app starts. Absent: shown. */
  show: z.boolean().optional(),
});

export type LaunchSettings = z.infer<typeof LaunchSettings>;

export const defaultLaunchSettings = (): LaunchSettings => ({ schema: LAUNCH_SETTINGS_SCHEMA });

/** Whether the launch screen shows: only `show: false` turns it off. */
export const launchScreenShown = (s: Pick<LaunchSettings, 'show'>): boolean => s.show !== false;
