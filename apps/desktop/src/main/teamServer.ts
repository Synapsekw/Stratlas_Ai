/**
 * The Team Server client (M9 stream T7, preview): enrolment with an invite code, a pinned
 * certificate fingerprint and per-device signed requests (`server:*`). Credentials stay in the
 * vault. T0 stubs: no server is enrolled and every action answers "not available yet".
 */
import { notYet, type Handle } from './notYet';

export interface TeamServerIpcDeps {
  handle: Handle;
}

export function registerTeamServerIpc({ handle }: TeamServerIpcDeps): void {
  const what = 'The team server (preview)';
  handle('server:enrol', () => notYet(what));
  handle('server:list', () => ({ servers: [] }));
  handle('server:forget', () => notYet(what));
}
