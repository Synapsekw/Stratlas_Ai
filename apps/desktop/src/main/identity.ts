/**
 * Identity, devices and members (M9 stream T2): `identity:*` and `members:*`. The device's private
 * key lives only in the OS vault (`DEVICE_KEY_ACCOUNT`); renderer code never signs. T0 stubs: every
 * channel answers "not available yet" until T2 fills it.
 */
import { notYet, type Handle } from './notYet';

export interface IdentityIpcDeps {
  handle: Handle;
}

export function registerIdentityIpc({ handle }: IdentityIpcDeps): void {
  const what = 'Identity and team members';
  handle('identity:get', () => notYet(what));
  handle('identity:set', () => notYet(what));
  handle('identity:exportCard', () => notYet(what));
  handle('identity:importCard', () => notYet(what));
  handle('members:list', () => notYet(what));
  handle('members:add', () => notYet(what));
  handle('members:setRole', () => notYet(what));
  handle('members:remove', () => notYet(what));
  handle('members:revokeDevice', () => notYet(what));
}
