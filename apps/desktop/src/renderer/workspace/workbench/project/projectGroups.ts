// The "In this project" list's content groups (right sidebar, Project tab). Pure: no React.
import type { ProjectKind } from '../../../builder/model';
import { inSets, PROJECT_GROUP_SET, type ToolSet } from '../../../tools/toolSets';

/** Every content group the list knows; groups with no registered body are skipped. */
export type GroupId =
  'antennas' | 'sectors' | 'coverage' | 'measurements' | 'issues' | 'changes' | 'photos';

/** A group's section id in the Project tab's folds (bench `measure`, `quadrion.sections`). */
export const groupSectionId = (group: GroupId): string => `project-${group}`;

/**
 * Groups are folded until the person opens them; only the list's first group starts open
 * (`useOrderedGroups` sets `defaultOpen` on it). A fold the person changes is remembered.
 */
export const GROUP_DEFAULT_OPEN = false;

/** What the project is mainly about; it orders the list. */
export type Category = 'telecom' | 'survey' | 'construction' | 'vertical-asset' | 'default';

/** A category's groups in order. */
export const CATEGORY_ORDER: Record<Category, readonly { id: GroupId }[]> = {
  telecom: [
    { id: 'antennas' },
    { id: 'sectors' },
    { id: 'coverage' },
    { id: 'measurements' },
    { id: 'issues' },
  ],
  survey: [{ id: 'measurements' }, { id: 'issues' }],
  construction: [{ id: 'changes' }, { id: 'measurements' }, { id: 'issues' }, { id: 'photos' }],
  'vertical-asset': [{ id: 'issues' }, { id: 'measurements' }, { id: 'photos' }],
  default: [{ id: 'measurements' }, { id: 'issues' }],
};

/**
 * The project's category from its kind (`projectKind`: the purpose, else the older type): a known
 * kind (telecom, survey, construction, vertical asset) maps to itself, an older inspection or twin
 * or no kind at all lets the contents decide, and any other kind is the default.
 */
export function projectCategory(input: {
  kind: ProjectKind | null;
  hasAntennas: boolean;
  hasRfPlan: boolean;
  hasVolumes: boolean;
}): Category {
  switch (input.kind) {
    case 'telecom':
    case 'survey':
    case 'construction':
    case 'vertical-asset':
      return input.kind;
    case null:
    case 'inspection':
    case 'twin':
      if (input.hasAntennas || input.hasRfPlan) return 'telecom';
      return input.hasVolumes ? 'survey' : 'default';
    default:
      return 'default';
  }
}

/**
 * The ids to show, in order: the category's registered groups that apply, then every other
 * registered group that has items, in registry order. A group of a tool set shows only where that
 * set is part of the project (`sets`, `tools/toolSets.ts`): the tower groups with Telecom, which
 * the project type brings, or a switch, or an antenna inventory the project already holds.
 * `groups` is the registered groups in registry order; an id the category names but nobody
 * registered is skipped.
 */
export function orderGroups(
  category: Category,
  groups: readonly { id: GroupId; count: number; applies: boolean }[],
  sets: ReadonlySet<ToolSet>,
): GroupId[] {
  const shown = groups.filter((g) => g.applies && inSets(sets, PROJECT_GROUP_SET[g.id]));
  const byId = new Map(shown.map((g) => [g.id, g]));
  const out: GroupId[] = [];
  for (const entry of CATEGORY_ORDER[category]) if (byId.has(entry.id)) out.push(entry.id);
  for (const g of shown) if (g.count > 0 && !out.includes(g.id)) out.push(g.id);
  return out;
}
