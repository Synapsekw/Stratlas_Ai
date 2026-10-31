import { findingPoint } from '@aio/annotate';
import { spaceOfIssue } from '@aio/schema';
import { defineAction, registerActions, t, type Action } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { shell } from '../../shell';
import { setActiveSpace } from '../../spaces/activeSpace';
import { startMovePoint } from '../../flyability/movePoint';
import { offerPlacement } from '../../placement';
import { editBlocked } from './reasons';

/*
 * The right-click actions of the finding rows in the issue register: Place on model (the offer the
 * register's own menu made before, now a registry action) and Move point (pick the finding's new
 * place on the point cloud). Both act on the issues the menu opened on.
 */

const clickedIssue = (id: string) => workspace.getState().issues.find((i) => i.id === id);

const actions: readonly Action[] = [
  defineAction<'issues'>({
    id: 'issue.placeOnModel',
    label: (tg) => t('place.menu', { count: tg.ids.length }),
    section: 'edit',
    targets: ['issues'],
    multi: true,
    testId: 'issue-place-on-model',
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg) => {
      offerPlacement(tg.ids, 'menu');
    },
  }),
  defineAction<'issues'>({
    id: 'finding.movePoint',
    label: 'fly.move.action',
    icon: 'target',
    section: 'edit',
    targets: ['issues'],
    testId: 'finding-move-point',
    appliesTo: (tg) => {
      const issue = clickedIssue(tg.clicked);
      return issue !== undefined && (findingPoint(issue) !== null || issue.external !== undefined);
    },
    disabled: (_tg, ctx) => editBlocked(ctx),
    run: (tg) => {
      // the pick needs the 3D view, showing the space the finding is in
      const ws = workspace.getState();
      const issue = clickedIssue(tg.clicked);
      if (ws.project && issue) {
        setActiveSpace(ws.project.id, spaceOfIssue(ws.project.manifest, issue));
      }
      shell.getState().go('scene');
      startMovePoint(tg.clicked);
    },
  }),
];

/** Register the finding row actions. */
export function registerFindingActions(): () => void {
  return registerActions(actions);
}
