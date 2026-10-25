// The "In this project" list's content groups (right sidebar, Project tab). Pure: no React.
import type { ProjectKind } from '../../../builder/model';

/** Every content group the list knows; groups with no registered body are skipped. */
export type GroupId =
  | 'antennas'
  | 'sectors'
  | 'coverage'
  | 'measurements'
  | 'issues'
  | 'stockpiles'
  | 'changes'
  | 'photos';

/** A group's section id in the Project tab's folds (bench `measure`, `quadrion.sections`). */
export const groupSectionId = (group: GroupId): string => `project-${group}`;

/**
 * Groups are folded until the person opens them; only the list's first group starts open
 * (`useOrderedGroups` sets `defaultOpen` on it). A fold the person changes is remembered.
 */
export const GROUP_DEFAULT_OPEN = false;

/** The tower groups: only a telecom or vertical asset project names them. */
const TELECOM_GROUPS: ReadonlySet<GroupId> = new Set(['antennas', 'sectors', 'coverage']);

/** What the project is mainly about; it orders the list. */
export type Category = 'telecom' | 'survey' | 'construction' | 'vertical-asset' | 'default';

/** A category's groups in order; an `onlyIfAny` one shows only once it has items. */
export const CATEGORY_ORDER: Record<Category, readonly { id: GroupId; onlyIfAny?: true }[]> = {
  telecom: [
    { id: 'antennas' },
    { id: 'sectors' },
    { id: 'coverage' },
    { id: 'measurements' },
    { id: 'issues' },
  ],
  survey: [{ id: 'stockpiles' }, { id: 'measurements' }, { id: 'issues' }],
  construction: [{ id: 'changes' }, { id: 'measurements' }, { id: 'issues' }, { id: 'photos' }],
  'vertical-asset': [
    { id: 'issues' },
    { id: 'measurements' },
    { id: 'photos' },
    { id: 'antennas', onlyIfAny: true },
  ],
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
 * The ids to show, in order: the category's registered groups that apply (an `onlyIfAny` one only
 * with items), then every other registered group that has items, in registry order, except the
 * tower groups in a survey or construction project (an inventory left from another project, or
 * one a survey never asked for, is not part of it). `groups` is
 * the registered groups in registry order; an id the category names but nobody registered is
 * skipped.
 */
export function orderGroups(
  category: Category,
  groups: readonly { id: GroupId; count: number; applies: boolean }[],
): GroupId[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out: GroupId[] = [];
  for (const entry of CATEGORY_ORDER[category]) {
    const g = byId.get(entry.id);
    if (!g?.applies) continue;
    if (entry.onlyIfAny && g.count <= 0) continue;
    out.push(entry.id);
  }
  const towerless = category === 'survey' || category === 'construction';
  for (const g of groups) {
    if (towerless && TELECOM_GROUPS.has(g.id)) continue;
    if (g.applies && g.count > 0 && !out.includes(g.id)) out.push(g.id);
  }
  return out;
}
