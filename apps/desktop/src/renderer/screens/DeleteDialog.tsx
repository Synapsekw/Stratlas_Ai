import { Dialog, formatBytes, Icon, useT } from '@aio/ui';
import { useRef, useState } from 'react';
import { shell } from '../shell';
import { deleteText } from './deleteText';
import type { EntryDialogProps } from './projectMenuModel';

export function DeleteDialog({ entry, onClose, returnTo }: EntryDialogProps) {
  const t = useT();
  const what = deleteText(entry);
  const keep = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) onClose();
  };

  const confirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void shell
      .getState()
      .deleteProject(entry)
      .then((failed) => {
        if (failed === null) onClose();
        else {
          setBusy(false);
          setError(failed);
        }
      });
  };

  return (
    <Dialog
      open
      role="alertdialog"
      title={<span dir="auto">{t('library.delete.title', { project: entry.name })}</span>}
      describedBy="project-delete-text"
      testId="project-delete"
      hideClose
      // the safe choice has focus first: Enter on a dialog that just opened deletes nothing
      initialFocus={keep}
      returnFocus={returnTo}
      onClose={cancel}
      footer={
        <>
          <button
            ref={keep}
            type="button"
            className="btn ghost"
            onClick={cancel}
            disabled={busy}
            data-testid="project-delete-cancel"
          >
            {t('library.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={confirm}
            disabled={busy}
            data-testid="project-delete-confirm"
          >
            <Icon name="trash" size={14} />
            {busy ? t('library.delete.busy') : t('library.delete.confirm')}
          </button>
        </>
      }
    >
      <p id="project-delete-text" style={{ margin: 0 }}>
        {t(what.text)}
      </p>
      <dl className="kv" style={{ margin: 0 }}>
        {what.path !== null && (
          <>
            <dt>{t(what.label)}</dt>
            <dd className="mono pm-path" data-testid="project-delete-path">
              {what.path}
            </dd>
          </>
        )}
        {/* the size is of the listed path: not shown for a demo copy other than the card's */}
        {entry.sizeBytes !== undefined && what.path === entry.path && (
          <>
            <dt>{t('library.delete.size')}</dt>
            <dd className="mono">{formatBytes(entry.sizeBytes)}</dd>
          </>
        )}
      </dl>
      <p className="help" style={{ margin: 0 }}>
        {t('library.delete.restore')}
      </p>
      {error && (
        <p className="notice danger" role="alert" style={{ margin: 0 }}>
          <Icon name="warn" size={14} />
          <span>
            <b>{t('library.delete.failed')}</b> {error}
          </span>
        </p>
      )}
    </Dialog>
  );
}
