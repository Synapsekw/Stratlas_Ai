// The progress card over the stage while the report's pictures are taken (spec section 7). Taking
// them opens the Scene, which unmounts the Reports screen, so the card has its own root on the
// document for the length of the run.
import { Icon, t } from '@aio/ui';
import { createRoot } from 'react-dom/client';
import { useStore } from 'zustand';
import { pictureRun } from './captureViews';

function PictureProgressCard() {
  const { done, total } = useStore(pictureRun);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="dlg-scrim vre-progress-scrim">
      <div
        className="dlg vre-progress"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="vre-progress-h"
        aria-describedby="vre-progress-b"
        data-testid="volumetric-picture-progress"
      >
        <div className="dlg-h">
          <Icon name="camera" size={16} />
          <h2 id="vre-progress-h">{t('vreport.pictures.progressTitle')}</h2>
        </div>
        <div className="dlg-b" id="vre-progress-b">
          <p className="muted small">{t('vreport.pictures.progressText')}</p>
          <p className="small" role="status">
            {t('vreport.pictures.taking', { done, total })}
          </p>
          <span className="bar" aria-hidden="true">
            <i style={{ width: `${String(pct)}%` }} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Show the progress card until the returned function is called. */
export function showPictureProgress(): () => void {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<PictureProgressCard />);
  return () => {
    root.unmount();
    host.remove();
  };
}
