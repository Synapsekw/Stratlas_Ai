/**
 * Full-size photo viewer over the whole app, opened from a photo on the issue card: fit, zoom
 * (wheel, pinch, buttons, + and -), pan (drag), the issue's boxes and masks on or off (M), the
 * previous and next photo of the same issue (arrow keys), Esc to close. A modal dialog: focus
 * stays inside while it is open and returns to the photo that opened it.
 */
import { PhotoViewer, type PhotoViewerHandle } from '@aio/annotate';
import { Icon, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { shell } from '../shell';
import { issueEvidence, photoEvidence } from './model';
import { lightboxDispatch, useLightbox } from './state';

const ZOOM = 1.25;

export function Lightbox() {
  const t = useT();
  const state = useLightbox();
  const project = useWorkspace((s) => s.project);
  const issue = useWorkspace((s) =>
    state ? s.issues.find((i) => i.id === state.issueId) : undefined,
  );
  const photos = useMemo(
    () => (project && issue ? photoEvidence(issueEvidence(project.manifest, issue)) : []),
    [project, issue],
  );
  const viewer = useRef<PhotoViewerHandle>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const open = state !== null && photos.length > 0;

  // the project closed or the issue went away: nothing to show
  useEffect(() => {
    if (state && (!project || !issue || photos.length === 0)) lightboxDispatch({ type: 'close' });
  }, [state, project, issue, photos.length]);

  useEffect(() => {
    if (open) dialog.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open || !project || !issue) return null;
  const index = Math.min(state.index, photos.length - 1);
  const ev = photos[index];
  if (!ev) return null;
  const count = photos.length;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // the stage and app shortcuts stay out while the dialog is open
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') lightboxDispatch({ type: 'close' });
    else if (k === 'ArrowRight' || k === 'PageDown')
      lightboxDispatch({ type: 'step', dir: 1, count });
    else if (k === 'ArrowLeft' || k === 'PageUp')
      lightboxDispatch({ type: 'step', dir: -1, count });
    else if (k === 'f' || k === 'F' || k === '0') viewer.current?.fit();
    else if (k === '+' || k === '=') viewer.current?.zoom(ZOOM);
    else if (k === '-') viewer.current?.zoom(1 / ZOOM);
    else if (k === 'm' || k === 'M') lightboxDispatch({ type: 'marks' });
    else if (k === 'Tab') {
      // keep focus inside the dialog
      const focusables = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog.current)
      ) {
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
      } else return;
    } else return;
    e.preventDefault();
  };

  return (
    <div
      className="lb-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) lightboxDispatch({ type: 'close' });
      }}
    >
      <div
        ref={dialog}
        className="lb"
        role="dialog"
        aria-modal="true"
        aria-label={t('lightbox.label', { code: issue.code, photo: ev.photo })}
        data-testid="lightbox"
        tabIndex={-1}
        onKeyDown={onKey}
      >
        <header className="lb-h">
          <div className="lb-t">
            <b className="mono">{issue.code}</b>
            <span className="lb-title">{issue.title}</span>
            <span className="faint mono" data-testid="lightbox-counter">
              {ev.photo} · {t('lightbox.counter', { index: index + 1, total: count })}
            </span>
          </div>
          <div className="lb-acts">
            <button
              type="button"
              className="btn icon sm ghost"
              aria-label={t('lightbox.prev')}
              title={`${t('lightbox.prev')} (←)`}
              disabled={count < 2}
              onClick={() => {
                lightboxDispatch({ type: 'step', dir: -1, count });
              }}
            >
              <Icon name="back" size={14} />
            </button>
            <button
              type="button"
              className="btn icon sm ghost"
              aria-label={t('lightbox.next')}
              title={`${t('lightbox.next')} (→)`}
              disabled={count < 2}
              onClick={() => {
                lightboxDispatch({ type: 'step', dir: 1, count });
              }}
            >
              <Icon name="fwd" size={14} />
            </button>
            <span className="lb-sep" />
            <button
              type="button"
              className="btn icon sm ghost"
              aria-label={t('lightbox.zoomOut')}
              title={`${t('lightbox.zoomOut')} (-)`}
              onClick={() => viewer.current?.zoom(1 / ZOOM)}
            >
              <Icon name="minus" size={14} />
            </button>
            <button
              type="button"
              className="btn sm ghost"
              title={`${t('lightbox.fit')} (F)`}
              onClick={() => viewer.current?.fit()}
            >
              {t('lightbox.fit')}
            </button>
            <button
              type="button"
              className="btn icon sm ghost"
              aria-label={t('lightbox.zoomIn')}
              title={`${t('lightbox.zoomIn')} (+)`}
              onClick={() => viewer.current?.zoom(ZOOM)}
            >
              <Icon name="plus" size={14} />
            </button>
            <span className="lb-sep" />
            <button
              type="button"
              className="btn sm ghost"
              aria-pressed={state.marks}
              title={`${t('lightbox.marksTip')} (M)`}
              data-testid="lightbox-marks"
              onClick={() => {
                lightboxDispatch({ type: 'marks' });
              }}
            >
              <Icon name="box" size={14} />
              {t('lightbox.marks')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              title={t('lightbox.openInMediaTip')}
              onClick={() => {
                lightboxDispatch({ type: 'close' });
                workspace.getState().select({ kind: 'photo', id: ev.photo, layer: ev.layer });
                shell.getState().go('media');
              }}
            >
              <Icon name="media" size={14} />
              {t('lightbox.openInMedia')}
            </button>
            <span className="lb-sep" />
            <button
              type="button"
              className="btn icon sm ghost"
              aria-label={t('lightbox.close')}
              title={`${t('lightbox.close')} (Esc)`}
              data-testid="lightbox-close"
              onClick={() => {
                lightboxDispatch({ type: 'close' });
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </header>
        <div className="lb-stage">
          <PhotoViewer
            key={ev.key}
            layerId={ev.layer}
            photoId={ev.photo}
            viewOnly
            projected={false}
            marks={state.marks}
            handle={viewer}
            className="lb-viewer"
          />
        </div>
        <footer className="lb-keys faint small">{t('lightbox.keys')}</footer>
      </div>
    </div>
  );
}
