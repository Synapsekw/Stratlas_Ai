import { Icon, RemoveDialog, formatBytes, formatDate, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { removal, useRemoval } from './removal';
import './removal.css';

/** The removal dialog of the window, open while the removal store holds targets. */
export function RemoveHost() {
  const targets = useRemoval((s) => s.targets);
  const plan = useRemoval((s) => s.plan);
  const busy = useRemoval((s) => s.busy);
  const error = useRemoval((s) => s.error);
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  if (targets === null) return null;
  const dateLabel = (id: string) => {
    const c = captures?.find((x) => x.id === id);
    return c ? formatDate(c.date) : id;
  };
  return createPortal(
    <RemoveDialog
      targets={targets}
      plan={plan}
      busy={busy}
      error={error}
      dateLabel={dateLabel}
      onCancel={() => {
        removal.getState().cancel();
      }}
      onConfirm={() => void removal.getState().confirm()}
    />,
    document.body,
  );
}

/** "Delete the project trash for good?": the Datasets footer and the library menu open it. */
export function EmptyTrashDialog({
  projectId,
  onClose,
  returnTo,
}: {
  projectId: string;
  onClose: () => void;
  returnTo?: () => HTMLElement | null;
}) {
  const t = useT();
  const trash = useRemoval((s) => s.trash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dlg = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  /** The library menu can open it on a project whose trash is empty: then it only says so. */
  const nothing = trash !== null && trash.entries === 0;
  const cancel = () => {
    if (!busy) onClose();
  };
  useFocusTrap(dlg, true, {
    onEscape: cancel,
    initial: () => keep.current,
    ...(returnTo ? { returnTo } : {}),
  });
  // the library menu opens it for a project that may not be open: read that project's trash
  useEffect(() => {
    void removal.getState().loadTrash(projectId);
  }, [projectId]);
  const confirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void removal
      .getState()
      .emptyTrash(projectId)
      .then((failed) => {
        setBusy(false);
        if (failed === null) onClose();
        else setError(failed);
      });
  };
  return createPortal(
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
        aria-labelledby="trash-empty-title"
        aria-describedby="trash-empty-text"
        data-testid="trash-empty"
      >
        <div className="dlg-h">
          <Icon name="trash" size={16} />
          <h2 id="trash-empty-title">{t('trash.confirm.title')}</h2>
        </div>
        <div className="dlg-b">
          <p id="trash-empty-text" style={{ margin: 0 }}>
            {nothing
              ? t('trash.none')
              : t('trash.confirm.text', {
                  size: formatBytes(trash?.bytes ?? 0),
                  count: trash?.entries ?? 0,
                })}
          </p>
          {error && (
            <p className="notice danger" role="alert" style={{ margin: 0 }}>
              <Icon name="warn" size={14} />
              <span>{error}</span>
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
            data-testid="trash-empty-cancel"
          >
            {nothing ? t('remove.close') : t('remove.cancel')}
          </button>
          {!nothing && (
            <button
              type="button"
              className="btn danger"
              onClick={confirm}
              disabled={busy}
              data-testid="trash-empty-confirm"
            >
              <Icon name="trash" size={14} />
              {busy ? t('trash.confirm.busy') : t('trash.confirm.yes')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
