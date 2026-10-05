/**
 * Screen reader announcements for results that arrive later (a job finished, an export saved):
 * `announce(text)` from anywhere, `<LiveAnnouncer />` mounted once and always, so the live
 * regions exist before their text changes (a region added together with its text is often not
 * read). Visual toasts and panels keep their own role="status" where they have one.
 */
import { useSyncExternalStore } from 'react';

export type Politeness = 'polite' | 'assertive';

interface Said {
  polite: string;
  assertive: string;
}

const NBSP = String.fromCharCode(160);

let said: Said = { polite: '', assertive: '' };
let count = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/**
 * Say `message` once. The same text twice in a row is still read: every other message carries
 * an invisible trailing space so the region's text changes.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  count += 1;
  const text = count % 2 ? message : `${message}${NBSP}`;
  said = { ...said, [politeness]: text };
  emit();
}

/** What the regions hold now (tests). */
export function announced(): Readonly<Said> {
  return said;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => said;

/** The two live regions, visually hidden. Mount once at the app root. */
export function LiveAnnouncer() {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div className="sr-only" data-testid="live-announcer">
      {/* live regions without a status or alert role, so they never stand in for a screen's own */}
      <div aria-live="polite" aria-atomic="true" data-testid="announce-polite">
        {s.polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" data-testid="announce-assertive">
        {s.assertive}
      </div>
    </div>
  );
}
