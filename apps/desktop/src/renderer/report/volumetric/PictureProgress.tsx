// The progress card over the stage while the report's pictures are taken (spec section 7). Taking
// them opens the Scene, which unmounts the Reports screen, so the card has its own root on the
// document for the length of the run. It is a modal Dialog: focus stays on it, and Escape or Stop
// asks the run to stop after the current shot (nothing is saved and the view comes back).
import { Button, Dialog, Icon, t } from '@aio/ui';
import { createRoot } from 'react-dom/client';
import { useStore } from 'zustand';
import { pictureRun, resetPictureStop, stopPictures } from './captureViews';

function PictureProgressCard() {
  const { done, total, stopping } = useStore(pictureRun);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <Dialog
      open
      onClose={stopPictures}
      role="alertdialog"
      size="sm"
      dismissable={false}
      hideClose
      className="vre-progress"
      testId="volumetric-picture-progress"
      title={
        <>
          <Icon name="camera" size={16} /> {t('vreport.pictures.progressTitle')}
        </>
      }
      description={t('vreport.pictures.progressText')}
      footer={<Button onClick={stopPictures}>{t('vreport.pictures.stop')}</Button>}
    >
      <p className="small" role="status">
        {stopping ? t('vreport.pictures.stopping') : t('vreport.pictures.taking', { done, total })}
      </p>
      <span className="bar" aria-hidden="true">
        <i style={{ width: `${String(pct)}%` }} />
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
