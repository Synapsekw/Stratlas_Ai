/**
 * Whether the open pile was opened from the inventory (Project > Volumes: a row of the Inventory
 * or a bar of Cut & fill). A pile always opens in Selection, from every route (founder, 18 Nov
 * 2026); one opened from the inventory carries a "Back to inventory" link there and steps through
 * the piles in the inventory's order. Opened any other way (3D, the Map, the left sidebar) it has
 * neither.
 */
import { createStore } from 'zustand/vanilla';
import { showBench } from '../../workspace/workbench/followTool';
import { select } from '../measureStore';

export interface PileOrigin {
  /** The pile opened from the inventory, while it is the open one. */
  id: string | null;
  /** The inventory's order when it was opened (its folders), for the panel's arrows. */
  order: readonly string[] | null;
}

export const pileOrigin = createStore<PileOrigin>(() => ({ id: null, order: null }));

/** Note that `id` was opened from the inventory (or stepped to from a pile that was). */
export function openedFromInventory(id: string, order: readonly string[] | null = null): void {
  pileOrigin.setState({ id, order });
}

/** The pile is closed, or another route opened one: no link back. */
export function forgetPileOrigin(): void {
  if (pileOrigin.getState().id !== null) pileOrigin.setState({ id: null, order: null });
}

/** "Back to inventory": the pile is no longer selected and Project > Volumes comes forward. */
export function backToInventory(): void {
  forgetPileOrigin();
  select([], null);
  showBench('volumes');
}
