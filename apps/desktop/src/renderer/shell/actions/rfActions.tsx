import { defineAction, registerActions, type Action } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { openRfTab } from '../../rf/rfTab';
import { rfStore } from '../../rf/rfStore';

/*
 * The entry to RF coverage: Coverage... in the project menu opens the RF tab. It reads only what
 * the RF store already knows (`antennas` is null when the project has no `telecom/antennas.json`),
 * so there is no extra bridge call; it shows only while the store holds the open project. It only
 * opens the tab, so a coverage run going does not grey it.
 */

const actions: readonly Action[] = [
  defineAction({
    id: 'rf.coverage',
    label: 'actions.rf.coverage',
    icon: 'target',
    section: 'view',
    targets: ['project'],
    appliesTo: () => {
      const s = rfStore.getState();
      return s.antennas !== null && s.projectId === (workspace.getState().project?.id ?? null);
    },
    run: () => {
      openRfTab();
    },
  }),
];

/** Register the RF coverage entry action. */
export function registerRfActions(): () => void {
  return registerActions(actions);
}
