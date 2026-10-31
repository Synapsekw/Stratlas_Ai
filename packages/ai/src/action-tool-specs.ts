/**
 * The right-click actions of the app as two agent tools (A2, agent.md 4.4): `list_actions` asks
 * what a person's menu offers on a target, `run_action` runs one of them. The actions live in the
 * desktop's shared action registry (`@aio/ui` actions, registered by the app's shell); the
 * executors are in the desktop renderer (agent/actionBridge.ts).
 *
 * `AGENT_ACTIONS` is the coverage table: every registered action is either offered to the agent
 * with a risk, or excluded with the reason. Main reads the risk from here (a write asks for
 * approval first), and the desktop's parity test fails when a registered action has no entry, so
 * a new right-click action cannot land without a decision about the agent.
 */
import type { ToolRisk } from '@aio/schema';
import { z } from 'zod';
import type { ToolSpec } from './tools';

/** An action the agent may run: `navigate` changes only the view, `write` changes data or files. */
export interface CoveredAction {
  risk: Extract<ToolRisk, 'navigate' | 'write'>;
  /**
   * What the run leaves to the person: `confirm`, a confirm box (a delete); `finish`, a dialog or
   * tool the person completes (a save dialog, a wizard). The result says so instead of "done".
   */
  then?: 'confirm' | 'finish';
  /** Why a view risk is right for an action filed in an edit, date, file or danger section. */
  why?: string;
}
/** An action that stays with the person, and why. */
export interface ExcludedAction {
  exclude: string;
}
export type AgentActionEntry = CoveredAction | ExcludedAction;

const VIEW: CoveredAction = { risk: 'navigate' };
const WRITE: CoveredAction = { risk: 'write' };
/** A write the app then asks the person to confirm (its own confirm box). */
const CONFIRM: CoveredAction = { risk: 'write', then: 'confirm' };
/** A write the person finishes in a dialog or tool the action opens. */
const FINISH: CoveredAction = { risk: 'write', then: 'finish' };
/** A view action filed in an edit or file section of the menu. */
const viewIn = (why: string): CoveredAction => ({ risk: 'navigate', why });

const PICKS_FILES = 'Opens a file picker: the person chooses the files.';
const NAME_FIELD = 'Opens a name field for the person to type in.';
const HAND_WORK = 'Hand work in the view: the person places, drags or draws it.';
const FOLD = 'Folds a row of the Datasets list; nothing for the agent to do.';

export const AGENT_ACTIONS: Readonly<Record<string, AgentActionEntry>> = {
  // the project row
  'project.addData': { exclude: PICKS_FILES },
  'project.addPanos': { exclude: PICKS_FILES },
  'project.addInspector': { exclude: PICKS_FILES },
  'project.addDrawing': { exclude: PICKS_FILES },
  'project.addSurveyDate': { exclude: 'Asks the person for the date in a field.' },
  'project.showAll': VIEW,
  'project.hideAll': VIEW,
  'project.importFolder': { exclude: PICKS_FILES },
  'project.import360': { exclude: PICKS_FILES },
  'project.importTiles': { exclude: PICKS_FILES },
  'project.checkPlacement': VIEW,
  'project.exports': FINISH,
  'project.properties': viewIn(
    'Opens the properties panel; nothing changes until the person edits it.',
  ),
  'project.close': { exclude: 'Closes the project the agent works in.' },
  'project.emptyTrash': {
    exclude: 'Cannot be undone; the person empties the trash and confirms in the Datasets list.',
  },
  'group.addDrawing': { exclude: PICKS_FILES },
  'group.add360': { exclude: PICKS_FILES },
  'group.toggle': { exclude: FOLD },
  // survey date folders
  'date.view': VIEW,
  'date.toggle': { exclude: FOLD },
  'date.show': VIEW,
  'date.hide': VIEW,
  'date.zoomTo': VIEW,
  'date.compare': VIEW,
  'date.rename': { exclude: NAME_FIELD },
  'date.lineUp': FINISH,
  'date.removeLineUp': WRITE,
  'date.colour': WRITE,
  'date.icon': WRITE,
  'date.reset': WRITE,
  'date.addData': { exclude: PICKS_FILES },
  'date.export': FINISH,
  'date.delete': CONFIRM,
  // dataset rows
  'layer.show': VIEW,
  'layer.hide': VIEW,
  'layer.zoomTo': VIEW,
  'layer.rename': { exclude: NAME_FIELD },
  'layer.moveToDate': WRITE,
  'layer.compare': VIEW,
  'layer.export': FINISH,
  'layer.reveal': viewIn('Shows the file in the file manager; nothing changes.'),
  'layer.properties': viewIn(
    'Opens the properties panel; nothing changes until the person edits it.',
  ),
  'layer.delete': CONFIRM,
  'cloud.settings': VIEW,
  'cloud.colourBy': VIEW,
  'pointcloud.cleanup': { exclude: 'Opens the cleanup tools for hand editing.' },
  'pointcloud.removeNoise': WRITE,
  'pointcloud.saveCleaned': WRITE,
  'pointcloud.resetCleanup': WRITE,
  'mesh.georef': { exclude: HAND_WORK },
  'mesh.place': { exclude: HAND_WORK },
  'layer.dropToGround': WRITE,
  'engineering.create': FINISH,
  'drawing.settings': VIEW,
  'drawing.sideBySide': VIEW,
  'drawing.place': { exclude: HAND_WORK },
  'drawing.onTop': VIEW,
  'walk.open': VIEW,
  'walk.compareWith': VIEW,
  'walk.place': { exclude: HAND_WORK },
  'walk.removePlacement': { exclude: 'The person confirms it in the Datasets row.' },
  'video.calibrate': { exclude: HAND_WORK },
  'video.alignCamera': { exclude: HAND_WORK },
  'video.flightPath': VIEW,
  'photos.alignTo': WRITE,
  'photos.createMaps': FINISH,
  'photos.openFirst': VIEW,
  'pano.open': VIEW,
  'pano.stitch': WRITE,
  'annotations.open': VIEW,
  'annotations.pins': VIEW,
  // photos, 360s and pins
  'media.place': { exclude: HAND_WORK },
  'media.move': { exclude: HAND_WORK },
  'media.direction': { exclude: HAND_WORK },
  'media.as360': WRITE,
  'media.asPhoto': WRITE,
  'media.remove': WRITE,
  'photos.editPosition': { exclude: 'Opens a position form for the person to fill in.' },
  'photos.resetPosition': WRITE,
  'layers.rereadPhotos': { exclude: 'Opens a folder picker and its own dialogs.' },
  // measurements
  'measure.rename': { exclude: NAME_FIELD },
  'measure.colour': WRITE,
  'measure.visibility': viewIn('Hides or shows the measurement in the view, as the eye icon does.'),
  'measure.flyTo': viewIn('Moves the camera to the measurement.'),
  'measure.editBoundary': { exclude: HAND_WORK },
  'measure.moveToFolder': WRITE,
  'measure.moveToDate': WRITE,
  'measure.delete': WRITE,
  'measure.addToReport': WRITE,
  'measure.removeFromReport': WRITE,
  'measure.export': FINISH,
  'change.areaCompare': VIEW,
  // RF, thermal, antennas
  'rf.coverage': VIEW,
  'thermal.analyse': VIEW,
  'antenna.flyTo': VIEW,
  'antenna.hide': VIEW,
  'antenna.show': VIEW,
  'antenna.soloKind': VIEW,
  'antenna.editAzimuth': { exclude: HAND_WORK },
  'antenna.editDowntilt': { exclude: HAND_WORK },
  'antenna.accept': WRITE,
  'antenna.reject': WRITE,
  'antenna.redraw': { exclude: HAND_WORK },
  'antenna.delete': CONFIRM,
  // the issue register rows
  'issue.placeOnModel': { exclude: 'Needs a click on the model in the view.' },
  'finding.movePoint': { exclude: 'Needs a click on the model in the view.' },
};

/** The target kinds the agent can name (the menu's `group` heading stays with the person). */
export const AGENT_TARGET_KINDS = [
  'project',
  'date',
  'layers',
  'measurements',
  'antennas',
  'photos',
  'media',
  'annotations',
] as const;

const Ids = z.array(z.string().min(1).max(200)).min(1).max(200);

/** What an action acts on, as the model names it (ids from the list tools). */
export const ActionTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z
    .object({
      kind: z.literal('date'),
      date: z
        .string()
        .min(1)
        .max(200)
        .nullable()
        .describe('Capture id from list_surveys; null for the Every date folder'),
    })
    .strict(),
  z.object({ kind: z.literal('layers'), ids: Ids.describe('Layer ids from list_layers') }).strict(),
  z
    .object({
      kind: z.literal('measurements'),
      ids: Ids.describe('Measurement ids from list_measurements'),
    })
    .strict(),
  z.object({ kind: z.literal('antennas'), ids: Ids }).strict(),
  z
    .object({
      kind: z.literal('photos'),
      layer: z.string().min(1).max(200),
      ids: Ids.describe('Photo ids'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('media'),
      layer: z.string().min(1).max(200),
      ids: Ids.describe('Photo or 360 ids'),
      as: z.enum(['photo', 'pano']).default('photo'),
    })
    .strict(),
  z.object({ kind: z.literal('annotations'), row: z.enum(['issues', 'drafts']) }).strict(),
]);
export type ActionTarget = z.output<typeof ActionTarget>;

export const actionToolInputs = {
  list_actions: z.object({ target: ActionTarget }).strict(),
  run_action: z
    .object({
      action: z.string().min(1).max(100).describe('An action id from list_actions'),
      target: ActionTarget,
      pick: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('For an action with picks: the pick id from list_actions'),
    })
    .strict(),
} as const;
export type ActionToolInput<N extends keyof typeof actionToolInputs> = z.output<
  (typeof actionToolInputs)[N]
>;

/** The risk of running `id`: its entry's, `write` for an unknown or excluded one (asks first). */
export function actionRisk(id: unknown): ToolRisk {
  const e = typeof id === 'string' ? AGENT_ACTIONS[id] : undefined;
  return e && 'risk' in e ? e.risk : 'write';
}

export const ACTION_TOOL_SPECS: ToolSpec[] = [
  {
    meta: {
      name: 'list_actions',
      description:
        "What the person's right-click menu offers on a target (the project, a survey date, layers, measurements, antennas, photos, 360s, the issue rows): action ids, labels, why one is greyed, its picks.",
      scope: 'project',
      risk: 'read',
    },
    input: actionToolInputs.list_actions,
  },
  {
    meta: {
      name: 'run_action',
      description:
        'Run one menu action from list_actions on its target, as the person would. Actions that change data or write files ask for approval first.',
      scope: 'project',
      risk: 'write',
    },
    input: actionToolInputs.run_action,
    // a filed date move can be taken back; the others answer no undo
    undoable: true,
    riskFor: (input) =>
      actionRisk(
        typeof input === 'object' && input !== null
          ? (input as { action?: unknown }).action
          : undefined,
      ),
  },
];
