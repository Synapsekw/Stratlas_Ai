/**
 * Start one pipeline for the open project: the pipeline's own fields, never a project folder.
 * Opened with `processing.getState().openDialog(draft)` from the screen the work belongs to
 * (Detections, road setup). When the job has started, the Processing drawer opens on it.
 */
import { Dialog, Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, type RefObject } from 'react';
import { sameFolder } from '../jobs';
import { openProcessingTools } from '../processingTools';
import { useJobs, useShell } from '../shell';
import { PipelineForm } from './PipelineForm';
import { jobTitle } from './pipelines';
import { processing, useProcessing } from './store';
import './processing.css';

export function PipelineDialog() {
  useT();
  const req = useProcessing((s) => s.dialog);
  const project = useWorkspace((s) => s.project?.root ?? null);
  const name = useWorkspace((s) => s.project?.manifest.name);
  const pkg = useShell((s) => s.pkg !== null);
  const toolsMissing = useJobs((s) => s.runtime?.found === false);
  // the first field takes the focus, not the "update the tools" button above the form
  const firstField = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return document.querySelector<HTMLElement>(
          '[data-testid="pipeline-dialog"] .q-dialog-body :is(input, select, textarea)',
        );
      },
    }),
    [],
  );
  const close = () => {
    processing.getState().closeDialog();
  };
  // a request is for the project that was open when it was made. In a read-only package, with no
  // project, or in another project, it is dropped, so it never reappears over the next one
  const here =
    req !== null &&
    name !== undefined &&
    !pkg &&
    project !== null &&
    sameFolder(req.project, project);
  useEffect(() => {
    if (req !== null && !here) processing.getState().closeDialog();
  }, [req, here]);
  if (!here) return null;
  return (
    <Dialog
      open
      className="proc-dlg"
      testId="pipeline-dialog"
      title={jobTitle(req.pipeline)}
      description={<span dir="auto">{t('processing.dialog.runsIn', { name })}</span>}
      closeLabel={t('processing.close')}
      initialFocus={firstField}
      onClose={close}
    >
      {toolsMissing && (
        <div className="proc-tools" data-testid="dialog-tools">
          <Icon name="warn" size={14} />
          <span>{t('processing.toolsMissing')}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              close();
              openProcessingTools();
            }}
          >
            {t('processing.toolsUpdate')}
          </button>
        </div>
      )}
      <PipelineForm
        key={req.pipeline}
        fixed
        draft={req}
        onClose={close}
        onStarted={(id) => {
          processing.getState().openDrawer(id);
        }}
      />
    </Dialog>
  );
}
