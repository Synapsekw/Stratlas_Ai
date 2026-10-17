import { Icon, useT } from '@aio/ui';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { lineUpApp, type LineUpStore } from './lineUpStore';

function Offer({ store }: { store: StoreApi<LineUpStore> }) {
  const t = useT();
  const offer = useStore(store, (s) => s.offer);
  if (!offer) return null;
  return (
    <div className="toast" data-testid="lineup-offer">
      <div className="toast-h">
        <Icon name="crosshair" size={14} />
        <b>{t('lineUp.title')}</b>
      </div>
      <div className="toast-p" data-testid="lineup-offer-text" dir="auto">
        {offer.text}
      </div>
      <div className="toast-p pm-acts">
        <button
          type="button"
          className="btn sm primary"
          data-testid="lineup-offer-go"
          onClick={() => void store.getState().acceptOffer()}
        >
          {t('lineUp.action')}
        </button>
        <button
          type="button"
          className="btn sm"
          data-testid="lineup-offer-later"
          onClick={() => {
            store.getState().notNow();
          }}
        >
          {t('lineUp.notNow')}
        </button>
      </div>
    </div>
  );
}

/**
 * The background check's notice (spec call 4): a new survey date does not line up with the date
 * it most overlaps, with Line up dates and Not now. Never blocks; Not now is remembered for the
 * pair. Without a `store` it shows the app's (`lineUpApp`).
 */
export function LineUpOffer(props: { store?: StoreApi<LineUpStore> }) {
  const app = useStore(lineUpApp, (s) => s.store);
  const store = props.store ?? app;
  return store ? <Offer store={store} /> : null;
}
