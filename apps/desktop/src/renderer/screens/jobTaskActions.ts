/**
 * Where each task of **New job** takes the person: the guided screen that already starts its
 * pipelines. Nothing here starts a job by itself.
 */
import { builder } from '../builder/state';
import { openChangesTab } from '../change';
import { openModelBuilder } from '../modeller/ModellerLayer';
import { photoUi } from '../photogrammetry/store';
import { shell } from '../shell';
import { openCompareDialog } from '../survey/compareStore';
import { openExportDialog } from '../survey/ExportDialog';
import { setOverlaysOpen } from '../survey/overlaysStore';
import { openQaPanel } from '../survey/qaStore';
import type { JobTaskId } from './jobTasks';

/** The survey panels live on the Scene: go there, then open the panel. */
function onScene(open: () => void): void {
  shell.getState().go('scene');
  open();
}

/** After the Scene has mounted (two frames): for panels that only hear a request once shown. */
function afterScene(open: () => void): void {
  shell.getState().go('scene');
  requestAnimationFrame(() => {
    requestAnimationFrame(open);
  });
}

export function openJobTask(id: JobTaskId): void {
  switch (id) {
    case 'photo-maps':
      photoUi.getState().openWizard();
      return;
    case 'model':
      openModelBuilder();
      return;
    case 'changes':
      afterScene(() => {
        // the Changes tab is in the right panel
        if (shell.getState().rightCollapsed) shell.getState().toggleRight();
        openChangesTab();
      });
      return;
    case 'site-cut-fill':
      onScene(() => {
        openCompareDialog('site');
      });
      return;
    case 'survey-check':
      onScene(() => {
        openQaPanel('qa');
      });
      return;
    case 'overlays':
      onScene(() => {
        setOverlaysOpen(true);
      });
      return;
    case 'stockpiles':
      builder.getState().openWizard();
      return;
    case 'import':
      void builder.getState().pickAndImport();
      return;
    case 'export':
      onScene(() => {
        openExportDialog(true);
      });
      return;
  }
}
