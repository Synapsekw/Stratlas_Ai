// The "In this project" list's content groups (right sidebar, Project tab). Pure: no React.

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

/** Groups open until the person folds them, as the antenna inventory did. */
export const GROUP_DEFAULT_OPEN = true;
