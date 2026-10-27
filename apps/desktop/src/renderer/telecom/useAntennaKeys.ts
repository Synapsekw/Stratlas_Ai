/**
 * Review keys for the selected antenna (its row and details in the Project list): A accepts, R
 * rejects, the arrows step through the filtered list, Esc clears the selection and Delete asks to
 * delete the unit. Keys typed into a field, held with a modifier, already handled or pressed while
 * a modal dialog is open are left alone, and so are the keys of a widget that owns them: Delete
 * in the Datasets tree belongs to the tree (it removes what is marked there).
 */
import { useEffect } from 'react';
import { isTypingTarget } from '../keys';
import { askDeleteAntennas } from './antennaDelete';
import { antennaStore, decideAntenna, selectAntenna, stepAntenna } from './antennaStore';

function ignored(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  // a face held by its drag handle: the walk, decisions and Delete wait for its release
  if (antennaStore.getState().boxEdit?.phase === 'drag') return true;
  if (isTypingTarget(e.target)) return true;
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** The action for a key, or null when the list does not handle it. */
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
    case 'Delete':
      return () => {
        const id = antennaStore.getState().selected;
        if (id) askDeleteAntennas([id]);
      };
    default:
      return null;
  }
}

/**
 * Widgets that own the arrows and Escape themselves. The antenna inventory's tree is not one: its
 * rows take only Enter and Space, so the arrows step the selection from a clicked row.
 */
const OWNS_KEYS =
  '[role="tablist"], [role="menu"], [role="listbox"], [role="slider"], [role="tree"]';

/** Rows of another content group in the Project list (measurements, issues) own their Delete. */
function inOtherListRow(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('.pl-rows') !== null && target.closest('[data-antenna-tree]') === null;
}

function ownedElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const owner = target.closest(OWNS_KEYS);
  return owner !== null && !owner.hasAttribute('data-antenna-tree');
}

/**
 * Listens on `window` while `enabled` (a unit is selected). A and R collide with the stage's
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
      // the review keys win over the stage's (A is annotate there)
      e.stopImmediatePropagation();
      act();
    };
    const onBubble = (e: KeyboardEvent): void => {
      if (/^[aArR]$/.test(e.key) || ignored(e)) return;
      if (ownedElsewhere(e.target)) return;
      if (e.key === 'Delete' && inOtherListRow(e.target)) return;
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
