import { setAnnotationAuthor } from '@aio/annotate';
import type { Identity, IpcRequest } from '@aio/schema';
import { useSyncExternalStore } from 'react';
import type { Bridge } from './bridge';

/**
 * Who this person is (M9 T2): main's identity (`identity:get`, `identity:set`). The old free-text
 * "Your name on issues" in `localStorage` is handed to main once (`migrateFrom`), so nobody loses
 * their name. It stays in storage, so an older build on this computer still finds it.
 */
const KEY = 'stratlas.author';
const MIGRATED = 'stratlas.author.migrated';

export interface IdentityView {
  identity: Identity | null;
  /** Device id, null until the key is made (first export or team change). */
  device: string | null;
  /** The credential store failed: changes are written unsigned. */
  unsigned: boolean;
  /** Why the identity could not be read; the old name is used meanwhile. */
  error: string | null;
  osUser: string;
}

let bridgeRef: Bridge | null = null;
let view: IdentityView = { identity: null, device: null, unsigned: false, error: null, osUser: '' };
const listeners = new Set<() => void>();

function storage(op: (s: Storage) => string | null | undefined): string | null {
  try {
    return op(localStorage) ?? null;
  } catch {
    return null;
  }
}

/** The name written into new issues and reviews: the identity, else the old setting or OS account. */
export function authorName(): string {
  if (view.identity) return view.identity.name;
  const own = storage((s) => s.getItem(KEY))?.trim() ?? '';
  return own.length > 0 ? own : view.osUser;
}

/** Initials for chips; tooltips show `authorName()`. */
export function authorInitials(): string {
  return view.identity?.initials ?? '';
}

function update(next: Partial<IdentityView>) {
  view = { ...view, ...next };
  setAnnotationAuthor(authorName());
  for (const l of listeners) l();
}

/** Ask main for the OS account and the identity once at startup, moving the old name over once. */
export async function initAuthor(bridge: Bridge): Promise<void> {
  bridgeRef = bridge;
  const info = await bridge.call('app:getInfo', {});
  if (info.ok && info.value.user) view = { ...view, osUser: info.value.user };
  const old = storage((s) => s.getItem(KEY))?.trim() ?? '';
  if (old && storage((s) => s.getItem(MIGRATED)) !== '1') {
    const moved = await bridge.call('identity:set', { migrateFrom: old.slice(0, 80) });
    if (moved.ok && moved.value.ok) {
      storage((s) => {
        s.setItem(MIGRATED, '1');
        return null;
      });
    }
  }
  await refreshIdentity();
}

/** Read the identity again (after an export made the device key). */
export async function refreshIdentity(): Promise<void> {
  if (!bridgeRef) return;
  const r = await bridgeRef.call('identity:get', {});
  if (r.ok && r.value.ok) {
    update({
      identity: r.value.identity,
      device: r.value.device,
      unsigned: r.value.unsigned,
      error: null,
    });
  } else {
    update({ error: r.ok ? (r.value.ok ? null : r.value.error) : r.error });
  }
}

/** Change name, initials or email; resolves to the error to show, or null. */
export async function saveIdentity(patch: IpcRequest<'identity:set'>): Promise<string | null> {
  if (!bridgeRef) return 'The app bridge is not available.';
  const r = await bridgeRef.call('identity:set', patch);
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  update({ identity: r.value.identity, error: null });
  return null;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useIdentity(): IdentityView {
  return useSyncExternalStore(subscribe, () => view);
}

export function useAuthor(): { name: string; osUser: string } {
  const v = useIdentity();
  return { name: v.identity?.name ?? authorName(), osUser: v.osUser };
}
