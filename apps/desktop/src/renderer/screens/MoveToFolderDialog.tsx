import { Icon, useFocusTrap, useT } from '@aio/ui';
import { useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { shell, useShell } from '../shell';
import { folderCounts } from './libraryFolderModel';
import type { EntryDialogProps } from './projectMenuModel';
import './libraryFolders.css';

/** The radio value of No folder (folder ids are `f_` and ten letters, so it cannot clash). */
const LOOSE = '';

/**
 * Move to folder, from a card's menu: No folder and every folder of the library, the card's own
 * one checked. Move puts the card there; the library is read again after.
 */
export function MoveToFolderDialog({ entry, onClose, returnTo }: EntryDialogProps) {
  const t = useT();
  const folders = useShell((s) => s.folders);
  const library = useShell((s) => s.library);
  const counts = useMemo(() => folderCounts(library ?? []), [library]);
  const dlg = useRef<HTMLDivElement>(null);
  const known = entry.folderId !== undefined && folders.some((f) => f.id === entry.folderId);
  const now = known ? (entry.folderId ?? LOOSE) : LOOSE;
  const [pick, setPick] = useState(now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) onClose();
  };
  useFocusTrap(dlg, true, { onEscape: cancel, returnTo });

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (busy) return;
    if (pick === now) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    void shell
      .getState()
      .moveToFolder(entry, pick === LOOSE ? null : pick)
      .then((failed) => {
        if (failed === null) onClose();
        else {
          setBusy(false);
          setError(failed);
        }
      });
  };

  const options = [
    { id: LOOSE, name: t('library.folders.loose'), count: null as number | null },
    ...folders.map((f) => ({ id: f.id, name: f.name, count: counts.get(f.id) ?? 0 })),
  ];

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
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-folder-title"
        data-testid="move-folder-dialog"
      >
        <form className="dlg-form" onSubmit={submit}>
          <div className="dlg-h">
            <Icon name="folder" size={16} />
            <h2 id="move-folder-title">{t('library.move.title', { project: entry.name })}</h2>
          </div>
          <div className="dlg-b">
            <fieldset className="mf-list" aria-labelledby="move-folder-title">
              {options.map((o) => (
                <label key={o.id || 'loose'} className="mf-opt" data-testid="move-folder-option">
                  <input
                    type="radio"
                    name="move-folder"
                    value={o.id}
                    checked={pick === o.id}
                    autoFocus={pick === o.id}
                    onChange={() => {
                      setPick(o.id);
                    }}
                  />
                  <Icon name={o.id === LOOSE ? 'projects' : 'folder'} size={14} />
                  <span dir="auto">{o.name}</span>
                  {o.count !== null && <span className="ftile-count mono">{o.count}</span>}
                </label>
              ))}
            </fieldset>
            {error && (
              <p className="notice danger" role="alert" style={{ margin: 0 }}>
                <Icon name="warn" size={14} />
                <span>{error}</span>
              </p>
            )}
          </div>
          <div className="dlg-f">
            <span className="grow" />
            <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>
              {t('library.cancel')}
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={busy}
              data-testid="move-folder-confirm"
            >
              {t('library.move.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
