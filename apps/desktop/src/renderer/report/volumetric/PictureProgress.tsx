// The progress card over the stage while the report's pictures are taken and its file is written
// (layout plan 2026-11-20, section 5). Taking them opens the Scene, which unmounts the Reports
// screen, so the card has its own root on the document for the length of the run. It is a modal
// Dialog: focus stays on it, and Escape or Stop asks the run to stop after the current picture
// (nothing is saved and the view comes back). It says what is pictured ("Pile 4 of 31: Pile D")
// with the count and a bar; once the pictures are in, "Writing the PDF" until the file is saved,
// which Stop no longer stops.
import { Button, Dialog, Icon, t } from '@aio/ui';
import { createRoot } from 'react-dom/client';
import { useStore } from 'zustand';
import { pictureRun, resetPictureStop, stopPictures } from './captureViews';
import { exportRun } from './editorView';

function PictureProgressCard() {
  const { done, total, stopping, label } = useStore(pictureRun);
  const { phase, format } = useStore(exportRun);
  const writing = phase === 'writing';
  const writingText =
    format === 'volumetric-html'
      ? t('vreport.pictures.progressWritingHtml')
      : t('vreport.pictures.progressWritingPdf');
  // no figure to show while the 3D view opens (no picture planned yet) and while the file is written
  const counted = !writing && total > 0;
  const pct = counted ? Math.round((done / total) * 100) : 0;
  const what = writing ? writingText : stopping ? t('vreport.pictures.stopping') : label;
  return (
    <Dialog
      open
      onClose={() => {
        if (!writing) stopPictures();
      }}
      role="alertdialog"
      layer="top"
      size="sm"
      dismissable={false}
      hideClose
      className="vre-progress"
      testId="volumetric-picture-progress"
      data={{ 'data-phase': writing ? 'writing' : stopping ? 'stopping' : 'pictures' }}
      title={
        writing ? (
          t('vreport.title')
        ) : (
          <>
            <Icon name="camera" size={16} /> {t('vreport.pictures.progressTitle')}
          </>
        )
      }
      {...(writing ? {} : { description: t('vreport.pictures.progressText') })}
      footer={
        <Button onClick={stopPictures} {...(writing ? { disabledReason: writingText } : {})}>
          {t('vreport.pictures.stop')}
        </Button>
      }
    >
      <div className="vre-progress-now">
        <p className="vre-progress-what" role="status">
          {what}
        </p>
        {counted && (
          <p className="vre-progress-count faint small">
            {t('vreport.pictures.progressCount', { done: Math.min(done + 1, total), total })}
          </p>
        )}
      </div>
      <span
        className="bar"
        role="progressbar"
        aria-label={writing ? writingText : t('vreport.pictures.progressTitle')}
        {...(counted
          ? { 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done }
          : { 'data-busy': 'true' })}
      >
        <i style={counted ? { width: `${String(pct)}%` } : undefined} />
      </span>
    </Dialog>
  );
}

/** Show the progress card until the returned function is called. */
export function showPictureProgress(): () => void {
  resetPictureStop();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<PictureProgressCard />);
  return () => {
    root.unmount();
    host.remove();
  };
}
