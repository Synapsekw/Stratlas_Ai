/**
 * The "No map pack installed" note: one map shows it at a time (the main map before a compared
 * one, else the first that asked, then the next when that one goes) and once the person hides it,
 * it stays hidden until the app restarts.
 */

let dismissed = false;
/** The maps that would show the note, in the order they asked. */
const claims: { id: symbol; primary: boolean }[] = [];
const listeners = new Set<() => void>();

const notify = () => {
  for (const l of listeners) l();
};

/**
 * A map without packs asks to show the note (`primary`: the main map, not a compared one); call
 * the returned function when it goes.
 */
export function claimNoPackNotice(id: symbol, primary = true): () => void {
  if (!claims.some((c) => c.id === id)) {
    claims.push({ id, primary });
    notify();
  }
  return () => {
    const i = claims.findIndex((c) => c.id === id);
    if (i < 0) return;
    claims.splice(i, 1);
    notify();
  };
}

/** Whether this map shows the note now. */
export function showsNoPackNotice(id: symbol): boolean {
  const shown = claims.find((c) => c.primary) ?? claims[0];
  return !dismissed && shown?.id === id;
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
