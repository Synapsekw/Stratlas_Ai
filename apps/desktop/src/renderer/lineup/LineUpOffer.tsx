import { Button, useT } from '@aio/ui';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { useToastNotice } from '../exports/useToastNotice';
import { lineUpApp, type LineUpStore } from './lineUpStore';

function OfferBody({ store }: { store: StoreApi<LineUpStore> }) {
  const t = useT();
  const offer = useStore(store, (s) => s.offer);
  if (!offer) return null;
  return (
    <>
      <div data-testid="lineup-offer-text" dir="auto">
        {offer.text}
      </div>
      <div className="q-toast-acts">
        <Button
          variant="primary"
          data-testid="lineup-offer-go"
          onClick={() => void store.getState().acceptOffer()}
        >
          {t('lineUp.action')}
        </Button>
        <Button
          data-testid="lineup-offer-later"
          onClick={() => {
            store.getState().notNow();
          }}
        >
          {t('lineUp.notNow')}
        </Button>
      </div>
    </>
  );
}

function Offer({ store }: { store: StoreApi<LineUpStore> }) {
  const t = useT();
  const offer = useStore(store, (s) => s.offer);
  const Body = useMemo(
    () =>
      function LineUpOfferBody() {
        return <OfferBody store={store} />;
      },
    [store],
  );
  // Not now answers it, so it has no close button; Escape is Not now too
  useToastNotice(
    'lineup-offer',
    offer
      ? {
          message: t('lineUp.title'),
          icon: 'crosshair',
          testId: 'lineup-offer',
          body: Body,
          closable: false,
          onDismiss: () => {
            store.getState().notNow();
          },
        }
      : null,
    offer,
  );
  return null;
}

/**
 * The background check's notice (spec call 4): a new survey date does not line up with the date
 * it most overlaps, with Line up dates and Not now. Never blocks; Not now is remembered for the
 * pair. Without a `store` it shows the app's (`lineUpApp`). A toast on the host.
 */
export function LineUpOffer(props: { store?: StoreApi<LineUpStore> }) {
  const app = useStore(lineUpApp, (s) => s.store);
  const store = props.store ?? app;
  return store ? <Offer store={store} /> : null;
}
