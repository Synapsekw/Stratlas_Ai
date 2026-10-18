/**
 * Review keys for the floating antenna card: A accepts, R rejects, the arrows step through the
 * filtered list and Esc closes. Keys typed into a field, held with a modifier, already handled or
 * pressed while a modal dialog is open are left alone.
 */
import { useEffect } from 'react';
import { decideAntenna, selectAntenna, stepAntenna } from './antennaStore';

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function ignored(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  const target = e.target;
  if (target instanceof Element && target.closest(EDITABLE)) return true;
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** The action for a key, or null when the card does not handle it. */
function actionOf(key: string): (() => void) | null {
  switch (key) {
    case 'a':
    case 'A':
      return () => void decideAntenna('accepted');
    case 'r':
    case 'R':
      return () => void decideAntenna('rejected');
    case 'ArrowRight':
    case 'ArrowDown':
      return () => {
        stepAntenna(1);
      };
    case 'ArrowLeft':
    case 'ArrowUp':
      return () => {
        stepAntenna(-1);
      };
    case 'Escape':
      return () => {
        selectAntenna(null);
      };
    default:
      return null;
  }
}

/** Listens on `window` while `enabled` (the card shows a unit). */
export function useAntennaKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (ignored(e)) return;
      // a held A or R would accept or reject a run of units; held arrows may step on
      if (e.repeat && /^[aArR]$/.test(e.key)) return;
      const act = actionOf(e.key);
      if (!act) return;
      e.preventDefault();
      act();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
}
