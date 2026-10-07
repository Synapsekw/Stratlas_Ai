import {
  launchScreenShown,
  type Identity,
  type LaunchGateMode,
  type LaunchSettings,
  type Settings,
} from '@aio/schema';

/**
 * The launch screen's decisions, kept apart from the component so they are tested on their own:
 * whether it shows, whom it greets, and the lines under the name.
 */

/**
 * A copy of the launch preference (userData `launch.json`, read with `launch:get`) in this
 * profile's local storage, read before the first frame: with the screen switched off, the next
 * start shows nothing at all instead of a dark frame until main answers. The file stays the
 * record; this only mirrors it.
 */
export const LAUNCH_HINT_KEY = 'quadrion.launchScreen';

/** This profile's local storage, or null where it is not available. */
export function localStore(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function readLaunchHint(storage: Pick<Storage, 'getItem'> | null): string | null {
  try {
    return storage?.getItem(LAUNCH_HINT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeLaunchHint(storage: Pick<Storage, 'setItem'> | null, on: boolean): void {
  try {
    storage?.setItem(LAUNCH_HINT_KEY, on ? '1' : '0');
  } catch {
    // private storage off: the next start asks main instead
  }
}

/** Render the launch screen on the first frame? Not in an automated run, nor when switched off. */
export function gateAtStart(mode: LaunchGateMode, hint: string | null): boolean {
  return mode !== 'skip' && hint !== '0';
}

/** Keep it once main has answered: only `show: false` turns it off (no file, or absent: shown). */
export function gateWanted(settings: Pick<LaunchSettings, 'show'>): boolean {
  return launchScreenShown(settings);
}

/**
 * The name main gives an identity when it found neither an earlier name nor an OS account
 * (main/identity.ts FALLBACK_NAME). It is not the person's name, so the screen never greets it.
 */
const PLACEHOLDER_NAME = 'Reviewer';

export type Greeting =
  /** Identity not read yet: the name line waits (it is still blurred in by the intro). */
  | { kind: 'pending' }
  | { kind: 'named'; name: string }
  /** No name of their own: "Welcome" and where to set it. Never an invented name. */
  | { kind: 'anonymous' };

/**
 * Whom to greet: the identity's name, the same name the app writes as author. `settled` once the
 * identity was read, failed, or took too long.
 */
export function greetingFor(identity: Identity | null, settled: boolean): Greeting {
  if (!identity) return settled ? { kind: 'anonymous' } : { kind: 'pending' };
  const name = identity.name.trim();
  if (!name) return { kind: 'anonymous' };
  if (identity.migratedFrom === 'new' && name === PLACEHOLDER_NAME) return { kind: 'anonymous' };
  return { kind: 'named', name };
}

/**
 * The line under the name: the company from Settings, Report branding, when there is one, and
 * this computer (`device`, translated by the caller). There is no team or workspace name at the
 * app level yet; a team sign-in will put its name here.
 */
export function orgLine(settings: Pick<Settings, 'reportBranding'>, device: string): string {
  const company = settings.reportBranding?.companyName?.trim() ?? '';
  return company ? `${company} · ${device}` : device;
}
