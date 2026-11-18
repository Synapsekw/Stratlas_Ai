/**
 * The one record of a tool set that no store keeps at hand (tools by project type, 18 Nov 2026):
 * whether the open project holds a thermal photo. The right-click menu's probe says so
 * (`shell/actions/thermalActions.tsx`). A leaf module, so the probe may write it and the tool
 * sets read it without importing each other.
 */
import { createStore } from 'zustand/vanilla';

export interface HeldFacts {
  thermal: boolean;
}

export const heldFacts = createStore<HeldFacts>(() => ({ thermal: false }));
