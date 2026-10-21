import { isPositionEdited, photoCorrection } from '@aio/geo';
import { defineAction, registerActions, type Action, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { positionEdit } from '../../builder/alignSession';
import { editablePicks, editReason, type PanelAt } from '../../builder/positionEditStore';
import { editBlocked } from './reasons';

/*
 * Edit position and Reset to original on photos (Media tiles, the Datasets photo rows, photo
 * markers on the map and in 3D). Pinned photos and photos with no position are greyed: a pin is
 * their hand placement (Move pin), and a photo with no position needs Place on site first.
 */

type Photos = Extract<MenuTarget, { kind: 'photos' }>;

/** Where the last menu was opened: the panel opens there. */
let lastMenu: PanelAt = null;
let listening = false;

/** The point of the last right-click anywhere in the window, or null before one. */
export function menuPoint(): PanelAt {
  return lastMenu;
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(
    'contextmenu',
    (e) => {
      lastMenu = { x: e.clientX, y: e.clientY };
    },
    true,
  );
}

/** The picks whose position is edited (an offset of 0.5 mm or more), pinned ones left out. */
function editedPicks(tg: Photos) {
  const ws = workspace.getState();
  const m = ws.project?.manifest;
  return editablePicks(tg.picks, m).editable.filter((p) =>
    isPositionEdited(photoCorrection(ws.orientation, p.layerId, p.photoId)),
  );
}

export const POSITION_ACTIONS: Action[] = [
  defineAction<'photos'>({
    id: 'photos.editPosition',
    label: 'position.edit',
    icon: 'crosshair',
    section: 'edit',
    targets: ['photos'],
    multi: true,
    disabled: (tg, ctx) => editBlocked(ctx) || editReason(editablePicks(tg.picks, ctx.manifest)),
    run: (tg) => {
      positionEdit.getState().open(tg.picks, menuPoint());
    },
  }),
  defineAction<'photos'>({
    id: 'photos.resetPosition',
    label: 'position.reset',
    icon: 'undo',
    section: 'edit',
    targets: ['photos'],
    multi: true,
    appliesTo: (tg) => editedPicks(tg).length > 0,
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: async (tg) => {
      await positionEdit.getState().reset(tg.picks);
    },
  }),
];

/** Register the Edit position actions; returns the unregister. */
export function registerPositionActions(): () => void {
  listen();
  return registerActions(POSITION_ACTIONS);
}
