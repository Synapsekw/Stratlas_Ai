// The content groups the "In this project" list shows (ProjectList.tsx). Each group registers
// here: its title, its count and whether it applies to the open project (hooks, called on every
// render in registry order, so the list is static), its body and its header actions.
import type { MessageKey } from '@aio/ui';
import type { ComponentType } from 'react';
import type { GroupId } from './projectGroups';

export interface ProjectGroupDef {
  id: GroupId;
  title: MessageKey;
  /** The count beside the title; 0 still shows the group. */
  useCount(): number;
  /** A group that does not apply to the project at all is left out. */
  useApplies(): boolean;
  /** The selected row, for a reveal's hold (`useRevealRow`); absent: no row is ever held. */
  useSelected?: () => string | null;
  Body: ComponentType;
  /** Beside the header (not inside its toggle), e.g. the group eye. */
  Actions?: ComponentType;
}

/** Every registered group, in no particular order (`useOrderedGroups` orders them). */
export const PROJECT_GROUPS: readonly ProjectGroupDef[] = [];

/** The groups that apply to the open project, in the order the list shows them. */
export function useOrderedGroups(
  groups: readonly ProjectGroupDef[] = PROJECT_GROUPS,
): ProjectGroupDef[] {
  const out: ProjectGroupDef[] = [];
  // every group's hook runs on every render (the registry never changes while mounted)
  for (const def of groups) {
    if (def.useApplies()) out.push(def);
  }
  return out;
}
