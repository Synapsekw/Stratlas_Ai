import { Icon } from '@aio/ui';
import { farNotice, useFarNotice } from './farSession';

/**
 * A layer far from the project origin, with "Re-centre project here" and "Keep"; photos far from
 * the survey data get "Ignore their GPS" instead.
 */
export function FarContentNotice() {
  const n = useFarNotice((s) => s.notice);
  if (!n) return null;
  return (
    <div className="toast" data-testid="far-content-notice">
      <div className="toast-h">
        <Icon name="target" size={14} />
        <b>{n.done ? 'Project origin' : 'Far from the project origin'}</b>
        <span className="toast-grow" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label="Dismiss"
          onClick={() => {
            farNotice.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="far-content-text">
        {n.text}
      </div>
      {!n.done && (
        <div className="toast-p pm-acts">
          {n.canRecentre && (
            <button
              type="button"
              className="btn sm primary"
              disabled={n.busy}
              onClick={() => void farNotice.getState().recentre()}
            >
              Re-centre project here
            </button>
          )}
          {n.photoLayers.length > 0 && (
            <button
              type="button"
              className="btn sm primary"
              disabled={n.busy}
              onClick={() => void farNotice.getState().ignorePhotoGps()}
            >
              Ignore their GPS
            </button>
          )}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              farNotice.getState().dismiss();
            }}
          >
            Keep
          </button>
        </div>
      )}
    </div>
  );
}
