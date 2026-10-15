import { formatBytes, Icon, useFocusTrap, useT } from '@aio/ui';
import { useRef, useState } from 'react';
import { shell } from '../shell';
import type { EntryDialogProps } from './projectMenuModel';

export function DeleteDialog({ entry, onClose, returnTo }: EntryDialogProps) {
  const t = useT();
  const dlg = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) onClose();
  };
  // the safe choice has focus first: Enter on a dialog that just opened deletes nothing
  useFocusTrap(dlg, true, { onEscape: cancel, returnTo, initial: () => keep.current });

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
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dlg}
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-delete-title"
        aria-describedby="project-delete-text"
        data-testid="project-delete"
      >
        <div className="dlg-h">
          <Icon name="trash" size={16} />
          <h2 id="project-delete-title" dir="auto">
            {t('library.delete.title', { project: entry.name })}
          </h2>
        </div>
        <div className="dlg-b">
          <p id="project-delete-text" style={{ margin: 0 }}>
            {t('library.delete.text')}
          </p>
          <dl className="kv" style={{ margin: 0 }}>
            <dt>{t('library.delete.folder')}</dt>
            <dd className="mono pm-path">{entry.path}</dd>
            {entry.sizeBytes !== undefined && (
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
        </div>
        <div className="dlg-f">
          <span className="grow" />
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
        </div>
      </div>
    </div>
  );
}
