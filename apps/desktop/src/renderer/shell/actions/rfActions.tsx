import { defineAction, registerActions, t, type Action } from '@aio/ui';
import { openRfTab } from '../../rf/rfTab';
import { rfStore } from '../../rf/rfStore';

/*
 * The entry to RF coverage: Coverage... in the project menu opens the RF tab. It reads only what
 * the RF store already knows (`antennas` is null when the project has no `telecom/antennas.json`),
 * so there is no extra bridge call. While a coverage run is going it is greyed with the reason.
 */

const actions: readonly Action[] = [
  defineAction({
    id: 'rf.coverage',
    label: 'actions.rf.coverage',
    icon: 'target',
    section: 'view',
    targets: ['project'],
    appliesTo: () => rfStore.getState().antennas !== null,
    disabled: () => (rfStore.getState().running ? t('actions.rf.running') : false),
    run: () => {
      openRfTab();
    },
  }),
];

/** Register the RF coverage entry action. */
export function registerRfActions(): () => void {
  return registerActions(actions);
}
