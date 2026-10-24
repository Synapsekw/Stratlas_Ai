import { defineAction, registerActions, t, type Action, type MenuTarget } from '@aio/ui';
import type { AntennaStatus, AntennaUnit } from '@aio/schema';
import { askDeleteAntennas } from '../../telecom/antennaDelete';
import {
  antennaStore,
  beginFlag,
  requestFly,
  setAntennaSolo,
  setUnitStatus,
  showAntennaField,
  toggleAntennaHidden,
} from '../../telecom/antennaStore';

/*
 * The right-click actions of the antenna rows in the project list (and of a unit picked in 3D):
 * edit the azimuth or downtilt in place, accept or reject, redraw the outline, fly to, hide or show,
 * show only one kind, and delete. Several ticked rows take Accept, Reject, Fly to, Hide or Show and
 * Delete together; the rest act on the row the menu opened on.
 */

type Target = Extract<MenuTarget, { kind: 'antennas' }>;

/** Why an edit is greyed: a read-only inventory, or nothing. */
function readOnlyReason(): string | false {
  return antennaStore.getState().readOnly ? t('telecom.antennas.readOnly') : false;
}

const blocked = (): string | false => readOnlyReason();

/** Why Redraw outline is greyed (the card's reasons), or false. */
function redrawBlocked(): string | false {
  const s = antennaStore.getState();
  if (s.readOnly) return t('telecom.antennas.readOnly');
  if (s.running) return t('telecom.antennas.running');
  if (s.flagStarting || s.flagJob !== null) return t('telecom.antennas.flag.busy');
  return false;
}

/** The units of the target that are in the inventory. */
function unitsOf(tg: Target): AntennaUnit[] {
  const which = new Set(tg.ids);
  return (antennaStore.getState().file?.units ?? []).filter((u) => which.has(u.id));
}

const clickedUnit = (tg: Target): AntennaUnit | undefined =>
  antennaStore.getState().file?.units.find((u) => u.id === tg.clicked);

const isHidden = (id: string): boolean => antennaStore.getState().hidden[id] === true;

/** Accept or reject every unit; when all are in that status already, return them to draft. */
function decide(tg: Target, status: Exclude<AntennaStatus, 'draft'>): void {
  const units = unitsOf(tg);
  const next: AntennaStatus = units.every((u) => u.status === status) ? 'draft' : status;
  for (const u of units) void setUnitStatus(u.id, next);
}

function focusField(tg: Target, key: 'azimuthGridDeg' | 'downtiltDeg'): void {
  showAntennaField(tg.clicked, key);
}

const actions: readonly Action[] = [
  defineAction<'antennas'>({
    id: 'antenna.flyTo',
    label: 'actions.antenna.flyTo',
    icon: 'target',
    section: 'view',
    targets: ['antennas'],
    multi: true,
    run: (tg) => {
      requestFly(tg.ids);
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.hide',
    label: 'actions.antenna.hide',
    icon: 'eye',
    section: 'view',
    targets: ['antennas'],
    multi: true,
    appliesTo: (tg) => tg.ids.some((id) => !isHidden(id)),
    run: (tg) => {
      for (const id of tg.ids) if (!isHidden(id)) toggleAntennaHidden(id);
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.show',
    label: 'actions.antenna.show',
    icon: 'eye',
    section: 'view',
    targets: ['antennas'],
    multi: true,
    appliesTo: (tg) => tg.ids.every(isHidden),
    run: (tg) => {
      for (const id of tg.ids) if (isHidden(id)) toggleAntennaHidden(id);
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.soloKind',
    label: 'actions.antenna.soloKind',
    section: 'view',
    targets: ['antennas'],
    appliesTo: (tg) => clickedUnit(tg) !== undefined,
    run: (tg) => {
      const kind = clickedUnit(tg)?.kind;
      if (!kind) return;
      setAntennaSolo(antennaStore.getState().solo === kind ? null : kind);
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.editAzimuth',
    label: 'actions.antenna.editAzimuth',
    section: 'edit',
    targets: ['antennas'],
    disabled: blocked,
    run: (tg) => {
      focusField(tg, 'azimuthGridDeg');
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.editDowntilt',
    label: 'actions.antenna.editDowntilt',
    section: 'edit',
    targets: ['antennas'],
    appliesTo: (tg) => clickedUnit(tg)?.kind !== 'dish',
    disabled: blocked,
    run: (tg) => {
      focusField(tg, 'downtiltDeg');
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.accept',
    label: 'actions.antenna.accept',
    section: 'edit',
    targets: ['antennas'],
    multi: true,
    disabled: blocked,
    run: (tg) => {
      decide(tg, 'accepted');
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.reject',
    label: 'actions.antenna.reject',
    section: 'edit',
    targets: ['antennas'],
    multi: true,
    disabled: blocked,
    run: (tg) => {
      decide(tg, 'rejected');
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.redraw',
    label: 'actions.antenna.redraw',
    section: 'edit',
    targets: ['antennas'],
    disabled: () => redrawBlocked(),
    run: (tg) => {
      beginFlag(tg.clicked);
    },
  }),
  defineAction<'antennas'>({
    id: 'antenna.delete',
    label: 'actions.antenna.delete',
    icon: 'trash',
    section: 'danger',
    targets: ['antennas'],
    multi: true,
    disabled: blocked,
    run: (tg) => {
      askDeleteAntennas(tg.ids);
    },
  }),
];

/** Register the antenna row actions. */
export function registerAntennaActions(): () => void {
  return registerActions(actions);
}
