/**
 * The "No map pack installed" note: one map shows it at a time (the first one that asks, then the
 * next when that one goes) and once the person hides it, it stays hidden until the app restarts.
 */

let dismissed = false;
/** The maps that would show the note, in the order they asked; the first one shows it. */
const claims: symbol[] = [];
const listeners = new Set<() => void>();

const notify = () => {
  for (const l of listeners) l();
};

/** A map without packs asks to show the note; call the returned function when it goes. */
export function claimNoPackNotice(id: symbol): () => void {
  if (!claims.includes(id)) {
    claims.push(id);
    notify();
  }
  return () => {
    const i = claims.indexOf(id);
    if (i < 0) return;
    claims.splice(i, 1);
    notify();
  };
}

/** Whether this map shows the note now. */
export function showsNoPackNotice(id: symbol): boolean {
  return !dismissed && claims[0] === id;
}

/** The person hid the note: no map shows it again this session. */
export function dismissNoPackNotice(): void {
  if (dismissed) return;
  dismissed = true;
  notify();
}

/** Called when the note's state changes (for `useSyncExternalStore`). */
export function subscribeNoPackNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only: a fresh session. */
export function resetNoPackNotice(): void {
  dismissed = false;
  claims.length = 0;
  notify();
}
