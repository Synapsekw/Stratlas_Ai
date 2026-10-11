/**
 * Start one pipeline for the open project: the pipeline's own fields, never a project folder.
 * Opened with `processing.getState().openDialog(draft)` from the screen the work belongs to
 * (Detections, road setup). When the job has started, the Processing drawer opens on it.
 */
import { Icon, t, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef } from 'react';
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
  const dlg = useRef<HTMLDivElement>(null);
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
  // the trap needs the dialog in the DOM; the first field takes the focus, not the close button
  useFocusTrap(dlg, here, {
    onEscape: close,
    initial: () => dlg.current?.querySelector<HTMLElement>('.dlg-b :is(input, select, textarea)'),
  });
  if (!here) return null;
  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dlg}
        className="dlg proc-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proc-dlg-h"
        data-testid="pipeline-dialog"
      >
        <div className="dlg-h">
          <Icon name="clock" size={16} />
          <h2 id="proc-dlg-h">{jobTitle(req.pipeline)}</h2>
          <span className="sub" dir="auto">
            {t('processing.dialog.runsIn', { name })}
          </span>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('processing.close')}
            onClick={close}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="dlg-b">
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
        </div>
      </div>
    </div>
  );
}
