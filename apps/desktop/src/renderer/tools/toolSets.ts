/**
 * Tools shown by project type (founder, 18 Nov 2026; `docs/plans/2026-11-18-tools-by-project.md`).
 * The one place that says which tool sets are part of a project and what belongs to each set. The
 * Tools tab, the right panel's sections, the measure families, the stage tools' modes, the "In
 * this project" list, the right-click menus and the command palette all ask it.
 *
 * The rule: a thing shows when its tool set is part of the project and the data it works on is
 * there. A thing outside every set (`null` in the tables) is in every project and has only the
 * data test. A set is part of the project when the project type gives it, or a person switched it
 * on (the manifest's `toolSets`, which replaces the type's list), or the project already holds
 * that set's own records (`Held`), which no switch can turn off.
 *
 * Pure: no React, no stores. `useToolSets.ts` gathers the facts.
 */
import { projectToolSets, ToolSet, type ProjectManifest, type ProjectPurpose } from '@aio/schema';
import { purposeOf } from '../layout/presets';
import type { FamilyId } from '../survey/measureCatalogue';
import type { GroupId } from '../workspace/workbench/project/projectGroups';
import type { SectionId } from '../workspace/workbench/tabsModel';
import type { IslandMode, ToolGroup } from './registry';

export type { ToolSet };

/** The sets, in the order the switches list them. */
export const TOOL_SETS: readonly ToolSet[] = ToolSet.options;

/** The sets each project type starts with. One line per type: change a type's tools here. */
export const PURPOSE_SETS: Readonly<Record<ProjectPurpose, readonly ToolSet[]>> = {
  survey: ['earthworks'],
  // founder, 18 Nov 2026: a construction project has the engineering tools too
  construction: ['earthworks', 'engineering'],
  'vertical-asset': ['engineering', 'thermal'],
  'confined-space': [],
  // founder, 18 Nov 2026: the type for any mix of data gets every set
  'data-fusion': ['earthworks', 'road', 'engineering', 'telecom', 'thermal'],
  road: ['road'],
  telecom: ['telecom', 'engineering'],
};

/**
 * The records of its own a project holds, per set: piles, volume measurements or the stockpile kit
 * (earthworks), a road model (road), an engineering model (engineering), an antenna inventory, an
 * RF plan or a telecom measurement (telecom), a thermal photo (thermal). Data a set could merely
 * run on (any mesh, any photo) is not a record of it.
 */
export type Held = Readonly<Record<ToolSet, boolean>>;

export const NOTHING_HELD: Held = {
  earthworks: false,
  road: false,
  engineering: false,
  telecom: false,
  thermal: false,
};

export type TypedManifest = Pick<ProjectManifest, 'purpose' | 'type' | 'toolSets'>;

const NONE: ReadonlySet<ToolSet> = new Set();

/**
 * The sets that are part of the project: the list a person chose, else what its type gives (the
 * type the layout follows too, `purposeOf`: an older project by what its type stands for), plus
 * every set whose records it holds. No project: none.
 */
export function toolSetsFor(manifest: TypedManifest | null, held: Held): ReadonlySet<ToolSet> {
  if (!manifest) return NONE;
  const chosen = projectToolSets(manifest) ?? PURPOSE_SETS[purposeOf(manifest)];
  return new Set(TOOL_SETS.filter((set) => chosen.includes(set) || held[set]));
}

/** Whether a thing of `set` shows as far as the sets go (`null`: it is in every project). */
export const inSets = (sets: ReadonlySet<ToolSet>, set: ToolSet | null): boolean =>
  set === null || sets.has(set);

export interface ToolSetSwitch {
  set: ToolSet;
  on: boolean;
  /** The project holds the set's records: it stays on. */
  locked: boolean;
}

/** The switches of Settings, This project, Tool sets. */
export function switchesFor(manifest: TypedManifest, held: Held): ToolSetSwitch[] {
  const sets = toolSetsFor(manifest, held);
  return TOOL_SETS.map((set) => ({ set, on: sets.has(set), locked: held[set] }));
}

/**
 * The list to save when a switch is turned: the whole list of sets then on. Null when nothing
 * changes (a locked set, or a switch that already reads that way).
 */
export function toggled(
  manifest: TypedManifest,
  held: Held,
  set: ToolSet,
  on: boolean,
): ToolSet[] | null {
  const now = switchesFor(manifest, held);
  const row = now.find((r) => r.set === set);
  if (!row || row.locked || row.on === on) return null;
  return now.filter((r) => (r.set === set ? on : r.on)).map((r) => r.set);
}

// ---------------------------------------------------------------- what belongs to which set
// Every table names every id, so a new group, section, family, mode or list group cannot land
// without saying whether it is in every project (`null`) or in a set.

export const GROUP_SET: Readonly<Record<ToolGroup, ToolSet | null>> = {
  view: null,
  measure: null,
  annotate: null,
  volumes: 'earthworks',
  pointcloud: null,
  // founder, 18 Nov 2026: Terrain analysis is in every project
  terrain: null,
  checks: 'earthworks',
  video: null,
  road: 'road',
  engineering: 'engineering',
  coverage: 'telecom',
  thermal: 'thermal',
  environment: null,
};

export const SECTION_SET: Readonly<Record<SectionId, ToolSet | null>> = {
  'selection.selected': null,
  'tools.view': null,
  'tools.measure': null,
  'tools.annotate': null,
  'tools.volumes': 'earthworks',
  'tools.pointcloud': null,
  'tools.terrain': null,
  'tools.checks': 'earthworks',
  'tools.video': null,
  'tools.road': 'road',
  'tools.engineering': 'engineering',
  'tools.coverage': 'telecom',
  'tools.thermal': 'thermal',
  'tools.environment': null,
  'layers.show': 'earthworks',
  'layers.display': null,
  'layers.clouds': null,
  'layers.overlays': null,
  'layers.cutaway': null,
  'layers.flightlines': null,
  'project.digest': null,
  'project.inThisProject': null,
  'project.search': null,
  'project.volumes': 'earthworks',
  'project.changes': null,
  'project.issues': null,
  'project.road': 'road',
  'project.jobs': null,
};

export const FAMILY_SET: Readonly<Record<FamilyId, ToolSet | null>> = {
  point: null,
  line: null,
  polygon: null,
  telecom: 'telecom',
  markup: null,
  section: null,
};

export const MODE_SET: Readonly<Record<IslandMode, ToolSet | null>> = {
  view: null,
  measure: null,
  annotate: null,
  volumes: 'earthworks',
  compare: null,
  video: null,
  road: 'road',
};

export const PROJECT_GROUP_SET: Readonly<Record<GroupId, ToolSet | null>> = {
  antennas: 'telecom',
  sectors: 'telecom',
  coverage: 'telecom',
  measurements: null,
  issues: null,
  stockpiles: 'earthworks',
  changes: null,
  photos: null,
};

/** The first part of a right-click action's id that puts it in a set (`antenna.flyTo`). */
const ACTION_PREFIX_SET: Readonly<Record<string, ToolSet>> = {
  antenna: 'telecom',
  rf: 'telecom',
  thermal: 'thermal',
  engineering: 'engineering',
};

/** The set a right-click action belongs to, by its id; null: it is in every project. */
export function actionSet(actionId: string): ToolSet | null {
  return ACTION_PREFIX_SET[actionId.slice(0, Math.max(0, actionId.indexOf('.')))] ?? null;
}
