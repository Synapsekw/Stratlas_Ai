// The content groups the "In this project" list shows (ProjectList.tsx). Each group registers
// here: its title, its count and whether it applies to the open project (hooks, called on every
// render in registry order, so the list is static), its body and its header actions.
import type { MessageKey } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import type { ComponentType } from 'react';
import { projectKind } from '../../../builder/model';
import { useRf } from '../../../rf/rfStore';
import { useAntennas } from '../../../telecom/antennaStore';
import { antennasGroup } from '../../../telecom/AntennasGroup';
import { useHasVolumeMeasurements } from '../view';
import { coveragePlanGroup } from './groups/CoveragePlanGroup';
import { issuesGroup } from './groups/IssuesGroup';
import { measurementsGroup } from './groups/MeasurementsGroup';
import { sectorsGroup } from './groups/SectorsGroup';
import { orderGroups, projectCategory, type GroupId } from './projectGroups';

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
  /** Set by `useOrderedGroups` on the list's first group: it starts open, the others folded. */
  defaultOpen?: boolean;
}

/** Every registered group, in registry order (`useOrderedGroups` orders the ones that show). */
export const PROJECT_GROUPS: readonly ProjectGroupDef[] = [
  antennasGroup,
  sectorsGroup,
  coveragePlanGroup,
  measurementsGroup,
  issuesGroup,
];

/**
 * The groups that apply to the open project, in the order its category gives (see
 * `orderGroups`); the first one starts open, the others folded.
 */
export function useOrderedGroups(
  groups: readonly ProjectGroupDef[] = PROJECT_GROUPS,
): ProjectGroupDef[] {
  // the purpose, else the older type: a volumetric project from before the purpose is a survey
  const kind = useWorkspace((s) => {
    const manifest = s.project?.manifest;
    return manifest ? projectKind(manifest) : null;
  });
  const hasAntennas = useAntennas((s) => s.file !== null);
  const hasRfPlan = useRf((s) => s.hasFile);
  const hasVolumes = useHasVolumeMeasurements();
  // every group's hooks run on every render (the registry never changes while mounted)
  const facts = groups.map((def) => ({
    id: def.id,
    count: def.useCount(),
    applies: def.useApplies(),
  }));
  const category = projectCategory({ kind, hasAntennas, hasRfPlan, hasVolumes });
  return orderGroups(category, facts).flatMap((id, i) => {
    const def = groups.find((g) => g.id === id);
    return def ? [{ ...def, defaultOpen: i === 0 }] : [];
  });
}
