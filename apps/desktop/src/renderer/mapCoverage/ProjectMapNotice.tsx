import { formatBytes, Icon, t } from '@aio/ui';
import { useEffect } from 'react';
import {
  acceptOffer,
  dismissOffer,
  reviewOffer,
  startProjectMapOffers,
  useProjectMapOffer,
} from './offers';
import { totalBytes } from './plan';
import { mapCoverage } from './store';

/**
 * The open project has no detailed street map: the areas that would be downloaded, their size
 * and where from, with Download and Choose areas. After Download (or straight away with the
 * automatic preference on) it says what is now in Downloads. Lives in the toast stack, bottom
 * right; it never blocks, and closing it is an answer too.
 */
export function ProjectMapNotice() {
  useEffect(startProjectMapOffers, []);
  const offer = useProjectMapOffer();
  if (!offer) return null;
  const size = formatBytes(totalBytes(offer.regions));
  const failed = offer.result?.failed ?? [];
  const startedCount = offer.result?.started.length ?? 0;
  return (
    <div className="toast" data-testid="project-map-notice" data-state={offer.state}>
      <div className="toast-h">
        <Icon name={offer.state === 'ask' ? 'map' : 'download'} size={14} />
        <b>{t(offer.state === 'ask' ? 'maps.offer.title' : 'maps.offer.startedTitle')}</b>
        <span className="toast-grow" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('maps.offer.dismiss')}
          onClick={dismissOffer}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" dir="auto">
        {offer.state === 'ask'
          ? t('maps.offer.text', { project: offer.name, size })
          : offer.state === 'starting'
            ? t('maps.offer.starting', { project: offer.name })
            : t(offer.auto ? 'maps.offer.startedAuto' : 'maps.offer.started', {
                project: offer.name,
                count: startedCount,
                size,
              })}
      </div>
      <ul className="pm-areas">
        {offer.regions.map((r) => (
          <li key={r.id}>
            <span dir="auto">{r.label}</span>
            <span className="mono faint">{formatBytes(r.estimate.bytes)}</span>
          </li>
        ))}
      </ul>
      {failed.map((f) => (
        <div key={f.id} className="toast-p pm-failed" role="alert">
          {t('maps.offer.failed', { label: f.label, error: f.error })}
        </div>
      ))}
      <div className="toast-p pm-acts">
        {offer.state === 'ask' ? (
          <>
            <button type="button" className="btn sm primary" onClick={() => void acceptOffer()}>
              <Icon name="download" size={12} />
              {t('maps.offer.download', { size })}
            </button>
            <button type="button" className="btn sm" onClick={reviewOffer}>
              {t('maps.offer.review')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn sm"
            disabled={offer.state === 'starting'}
            onClick={() => {
              dismissOffer();
              mapCoverage.getState().openPanel();
            }}
          >
            {t('maps.offer.showDownloads')}
          </button>
        )}
      </div>
    </div>
  );
}
