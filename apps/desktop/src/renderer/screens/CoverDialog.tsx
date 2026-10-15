import { Icon, useFocusTrap, useT } from '@aio/ui';
import { useMemo, useRef, useState } from 'react';
import { coverBytes, coverPalette, type CoverChoice } from '../library/cover';
import { CoverPicker } from '../library/CoverPicker';
import { shell, useShell } from '../shell';
import type { EntryDialogProps } from './projectMenuModel';

/** Change thumbnail: a built-in cover, an image or the last 3D view of the project for its card. */
export function CoverDialog({ entry, onClose, returnTo }: EntryDialogProps) {
  const t = useT();
  // taken as the project's scene was last left (library/lastView.ts)
  const lastView = useShell((s) => s.lastViews[entry.id]);
  const dlg = useRef<HTMLDivElement>(null);
  const palette = useMemo(
    () => coverPalette(entry.purpose, entry.kind),
    [entry.purpose, entry.kind],
  );
  const [choice, setChoice] = useState<CoverChoice>({ kind: 'builtin', id: 'contours' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (!busy) onClose();
  };
  useFocusTrap(dlg, true, { onEscape: cancel, returnTo });

  const save = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      let failed: string | null;
      try {
        const bytes = await coverBytes(choice, palette);
        // the dialog never offers "No cover"; nothing to send is nothing to change
        failed = bytes === undefined ? null : await shell.getState().setThumbnail(entry.id, bytes);
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      }
      if (failed === null) onClose();
      else {
        setBusy(false);
        setError(failed);
      }
    })();
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-cover-title"
        data-testid="cover-dialog"
      >
        <div className="dlg-h">
          <Icon name="photo" size={16} />
          <h2 id="project-cover-title">{t('library.cover.title')}</h2>
          <span className="sub" dir="auto">
            {entry.name}
          </span>
        </div>
        <div className="dlg-b">
          <CoverPicker
            palette={palette}
            value={choice}
            onChange={(c) => {
              setError(null);
              setChoice(c);
            }}
            allowReset={entry.customCover === true}
            lastView={lastView ?? null}
          />
          {error && (
            <p className="notice danger" role="alert" style={{ margin: 0 }}>
              <Icon name="warn" size={14} />
              <span>
                <b>{t('library.cover.failed')}</b> {error}
              </span>
            </p>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button
            type="button"
            className="btn ghost"
            onClick={cancel}
            disabled={busy}
            data-testid="cover-cancel"
          >
            {t('library.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={save}
            disabled={busy}
            data-testid="cover-save"
          >
            <Icon name="check" size={14} />
            {t('library.cover.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
