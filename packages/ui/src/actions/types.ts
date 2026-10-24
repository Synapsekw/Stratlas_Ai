import type { Layer, ProjectManifest, ToolRisk } from '@aio/schema';
import type { DateTag } from '@aio/workspace';
import type { ReactNode } from 'react';
import type { MessageKey } from '../i18n';
import type { IconName } from '../icons/Icon';
import type { ShortcutId } from '../shortcuts';
import type { TreeGroupKind } from '../tree/model';

/*
 * The right-click menus of the app as one registry (spec section 1): a feature registers what it
 * can do on a target, the menu asks `actionsFor` what to show. Palette and agent stay as they are
 * for now; `risk`, `input` and `surfaces` are reserved for the agent-coverage plan.
 */

export interface PhotoPick {
  layerId: string;
  photoId: string;
}

/** One photo or 360 an action targets (keyed so ground video can join later). */
export interface MediaPick {
  layerId: string;
  itemId: string;
  kind: 'photo' | 'pano';
}

export type MenuTarget =
  | { kind: 'project' }
  /** null: the Every date folder. */
  | { kind: 'date'; captureId: string | null }
  | { kind: 'group'; group: TreeGroupKind; layerIds: string[]; captureId?: string | null }
  /** One row, or the marked rows. */
  | { kind: 'layers'; layerIds: string[] }
  | { kind: 'photos'; picks: PhotoPick[] }
  /** 360s and pins (photos keep `photos`). */
  | { kind: 'media'; picks: MediaPick[] }
  /** Measurement rows: the marked ones, and the row the menu opened on. */
  | { kind: 'measurements'; ids: string[]; clicked: string }
  /** Antenna rows: the ticked ones, and the row the menu opened on. */
  | { kind: 'antennas'; ids: string[]; clicked: string }
  /** The Issues and Drafts rows of the Annotations group (they carry no layer). */
  | { kind: 'annotations'; row: 'issues' | 'drafts' };

export type ActionSection = 'open' | 'view' | 'edit' | 'compare' | 'file' | 'danger';
export const SECTION_ORDER: readonly ActionSection[] = [
  'open',
  'view',
  'edit',
  'compare',
  'file',
  'danger',
];

/** What the surface that opened the menu does for the actions (the Datasets list). */
export interface ActionHost {
  /** A short line where the surface shows notes (the Datasets note). */
  note(text: string, danger?: boolean): void;
  /** Show the name field of a survey date folder. */
  renameDate(captureId: string): void;
  /** File layers under a date (null: none), with the surface's notes and Undo. */
  moveLayers(layerIds: string[], capture: string | null): void;
  /** Ask in the row before a walk's placement is removed. */
  askUnplace(layerId: string): void;
  /** Ask before the project trash is emptied. */
  emptyTrash(): void;
  /** Open or close the folder or group the menu was opened on. */
  toggle?: (() => void) | undefined;
  expanded?: boolean | undefined;
  /** The folder the row or group sits in: `EVERY_DATE` or a capture id. */
  from?: string | undefined;
}

export const NO_HOST: ActionHost = {
  note: () => undefined,
  renameDate: () => undefined,
  moveLayers: () => undefined,
  askUnplace: () => undefined,
  emptyTrash: () => undefined,
};

/** What the predicates read and the runs call; the app builds it once per menu. */
export interface ActionCtx {
  manifest: ProjectManifest;
  hidden: Readonly<Record<string, true>>;
  /** False in a package and for a reviewer who may only look. */
  canEdit: boolean;
  /** A package (.aio): read-only, and its files stay inside it. */
  pkg: boolean;
  /** Survey dates are on (the sidebar shows date folders). */
  datesOn: boolean;
  /** The focused survey date. */
  focus: string | null;
  tags: Readonly<Record<string, DateTag>>;
  /** The layer ids of each date folder (`EVERY_DATE` and capture ids). */
  folderLayers: Readonly<Record<string, readonly string[]>>;
  /** Entries in the project trash. */
  trashEntries: number;
  drafts: number;
  host: ActionHost;
}

export interface SubItem {
  id: string;
  label: string;
  /** Why it cannot be picked; false or absent when it can. */
  disabled?: string | false;
  /** A pick or a radio item that is the current choice. */
  checked?: boolean;
  /** A heading drawn above this item when it differs from the item before. */
  group?: string;
  /** A CSS colour for a small square before the label (dates). */
  swatch?: string;
  icon?: IconName;
  testId?: string;
  /** Rows drawn under the item (Compare with: the rows other features add). */
  after?: (close: () => void) => ReactNode;
}

export interface Action<T extends MenuTarget = MenuTarget> {
  /** `layer.rename`, `photos.alignTo`. */
  id: string;
  label: MessageKey | ((t: T, ctx: ActionCtx) => string);
  icon?: IconName;
  section: ActionSection;
  targets: readonly T['kind'][];
  /** Offered when the target holds several items (marked rows, picked photos). */
  multi?: boolean;
  appliesTo?(t: T, ctx: ActionCtx): boolean;
  /** The reason shown as the tooltip of a greyed item, or false. */
  disabled?(t: T, ctx: ActionCtx): string | false;
  shortcut?: ShortcutId;
  /** How the sub items show: a view that replaces the items (default), a list under a heading, a row of picks. */
  present?: 'submenu' | 'inline' | 'picks';
  submenu?(t: T, ctx: ActionCtx): SubItem[];
  submenuTitle?(t: T, ctx: ActionCtx): string;
  /** A kept test id (`menu-delete`); default `ctx-item-<id>`. */
  testId?: string;
  run(t: T, ctx: ActionCtx, sub?: string): void | Promise<void>;
  risk?: ToolRisk;
  input?: { safeParse(value: unknown): { success: boolean } };
  surfaces?: readonly ('menu' | 'palette' | 'agent')[];
}

export interface ResolvedItem {
  id: string;
  label: string;
  icon?: IconName;
  section: ActionSection;
  disabled: string | false;
  /** The first combo of the action's shortcut as people read it, or null. */
  shortcut: string | null;
  testId: string;
  present: 'action' | 'submenu' | 'inline' | 'picks';
  sub: SubItem[];
  subTitle: string | null;
  run(sub?: string): void;
}

export type { Layer };
