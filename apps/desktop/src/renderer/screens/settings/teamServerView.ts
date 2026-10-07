/** Pure helpers of Settings, Data, Team server (M9 T7, preview). */
import { DEFAULT_HOSTING, type HostingModel, type Role } from '@aio/schema';

/** Is the team server offered in this build? `off` hides it (decision 1). */
export function teamServerShown(hosting: HostingModel = DEFAULT_HOSTING): boolean {
  return hosting.server !== 'off' && hosting.modes.includes('server');
}

/** Is the "Preview" label shown? The one flag: `HostingModel.server` (`ga` removes it). */
export function previewLabelShown(hosting: HostingModel = DEFAULT_HOSTING): boolean {
  return hosting.server === 'preview';
}

/** A fingerprint as people read it aloud: upper-case groups of four. */
export function groupFingerprint(fingerprint: string): string {
  return (fingerprint.toUpperCase().match(/.{1,4}/g) ?? []).join(' ');
}

/** What is wrong with a typed address, as a message key; null when it can be tried. */
export function addressProblem(text: string): 'teamServer.address.https' | null {
  const v = text.trim();
  if (!v) return null;
  try {
    return new URL(v).protocol === 'https:' ? null : 'teamServer.address.https';
  } catch {
    return 'teamServer.address.https';
  }
}

/** The address as the contract takes it: https added when the person left it out. */
export function normaliseAddress(text: string): string {
  const v = text.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

export const ROLE_KEY = {
  owner: 'teamServer.role.owner',
  reviewer: 'teamServer.role.reviewer',
  viewer: 'teamServer.role.viewer',
  client: 'teamServer.role.client',
} as const satisfies Record<Role, string>;
