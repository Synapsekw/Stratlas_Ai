/**
 * Esc on the stage (volumetrics redesign, spec sections 3 and 4): a point pinned on a linked line
 * clears first, then the open pile is let go and the Volumes tab returns to its Inventory. One
 * order for every place Esc is pressed: anywhere in the stage (`attachStageEscape`) and inside the
 * pile panel (`PilePanel`, through `escapeStage`).
 *
 * Whatever takes Esc first keeps it: a drawing or an edit (their capture handler), a field, a
 * dialog, an open menu, the chart with focus, the section window. They mark it taken
 * (`preventDefault` or `stopPropagation`), or they are recognised here.
 */
import { isTyping } from '../keys';
import { linkedHover } from './linkedHover';
import { measureStore, select } from './measureStore';
import { stagePile } from './pile/pileAxisScene';

/** Let go of the open pile when one is open on the stage. */
function closeStagePile(): boolean {
  if (!stagePile()) return false;
  select([], null);
  return true;
}

/**
 * One Esc: the pin if one shows, else `pile` (by default the pile open on the stage). True when
 * the Esc was used.
 */
export function escapeStage(pile: () => boolean = closeStagePile): boolean {
  const h = linkedHover.getState();
  if (h.pin) {
    const shown = h.lines.has(h.pin.key);
    h.setPin(null);
    // a pin whose line has gone showed nothing: the Esc goes on to the pile
    if (shown) return true;
  }
  return pile();
}

/** Something else that answers Esc is open or has the key (the section window asks it too). */
export function taken(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  if (isTyping(e.target)) return true;
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest('[role="menu"], [role="listbox"], .vwin')) return true;
  const doc = el?.ownerDocument ?? document;
  if (doc.querySelector('[role="menu"], [aria-modal="true"]')) return true;
  const m = measureStore.getState();
  return m.draw !== null || m.editing !== null;
}

/** Answer Esc anywhere in the window for the stage. Returns the detach. */
export function attachStageEscape(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || taken(e)) return;
    if (escapeStage()) e.preventDefault();
  };
  target.addEventListener('keydown', onKey);
  return () => {
    target.removeEventListener('keydown', onKey);
  };
}
