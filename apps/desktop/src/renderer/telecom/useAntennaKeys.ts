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

/** Widgets that own the arrows and Escape themselves. */
const OWNS_KEYS =
  '[role="tablist"], [role="menu"], [role="listbox"], [role="slider"], [role="tree"]';

/**
 * Listens on `window` while `enabled` (the card shows a unit). A and R collide with the stage's
 * own keys, so they are taken in the capture phase; the arrows and Esc are taken on the way back
 * up, only when nothing has handled them and the focus is not in a widget that owns them.
 */
export function useAntennaKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onCapture = (e: KeyboardEvent): void => {
      if (!/^[aArR]$/.test(e.key) || ignored(e) || e.repeat) return;
      const act = actionOf(e.key);
      if (!act) return;
      e.preventDefault();
      // the card's keys win over the stage's (A is annotate there)
      e.stopImmediatePropagation();
      act();
    };
    const onBubble = (e: KeyboardEvent): void => {
      if (/^[aArR]$/.test(e.key) || ignored(e)) return;
      if (e.target instanceof Element && e.target.closest(OWNS_KEYS)) return;
      const act = actionOf(e.key);
      if (!act) return;
      e.preventDefault();
      act();
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onBubble);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onBubble);
    };
  }, [enabled]);
}
