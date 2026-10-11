/**
 * Start one pipeline for the open project: the pipeline's own fields, never a project folder.
 * Opened with `processing.getState().openDialog(draft)` from the screen the work belongs to
 * (Detections, road setup). When the job has started, the Processing drawer opens on it.
 */
import { Icon, t, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useRef } from 'react';
import { PipelineForm } from './PipelineForm';
import { jobTitle } from './pipelines';
import { processing, useProcessing } from './store';
import './processing.css';

export function PipelineDialog() {
  useT();
  const req = useProcessing((s) => s.dialog);
  const name = useWorkspace((s) => s.project?.manifest.name);
  const dlg = useRef<HTMLDivElement>(null);
  const close = () => {
    processing.getState().closeDialog();
  };
  // the trap needs the dialog in the DOM, which it is only when there is a project to run in
  useFocusTrap(dlg, req !== null && name !== undefined, { onEscape: close });
  if (!req || name === undefined) return null;
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
