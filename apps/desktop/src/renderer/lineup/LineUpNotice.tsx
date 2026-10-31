import { Button, useT } from '@aio/ui';
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { otherUndo } from '../builder/AlignToNotice';
import { useToastNotice } from '../exports/useToastNotice';
import { lineUpApp, type LineUpStore } from './lineUpStore';

function NoticeBody({ store }: { store: StoreApi<LineUpStore> }) {
  const t = useT();
  const notice = useStore(store, (s) => s.notice);
  if (!notice) return null;
  return (
    <>
      <div data-testid="lineup-text" dir="auto">
        {notice.text}
      </div>
      {notice.action && (
        <div className="q-toast-acts">
          <Button
            variant="quiet"
            icon="undo"
            data-testid={`lineup-${notice.action.kind}`}
            onClick={() => void store.getState().apply()}
          >
            {notice.action.kind === 'undo' ? t('align.direction.undo') : t('align.direction.redo')}
          </Button>
        </div>
      )}
    </>
  );
}

function Notice({ store }: { store: StoreApi<LineUpStore> }) {
  const t = useT();
  const notice = useStore(store, (s) => s.notice);
  useEffect(() => {
    if (!notice?.action) return;
    const kind = notice.action.kind;
    const onKey = (e: KeyboardEvent) => {
      // the line-up step open over the notice owns the keys (its date may be the one Undo writes)
      if (!(e.ctrlKey || e.metaKey) || otherUndo(e) || store.getState().dialog) return;
      const k = e.key.toLowerCase();
      const undo = k === 'z' && !e.shiftKey;
      const redo = k === 'y' || (k === 'z' && e.shiftKey);
      if ((undo && kind === 'undo') || (redo && kind === 'redo')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void store.getState().apply();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [notice, store]);
  const Body = useMemo(
    () =>
      function LineUpNoticeBody() {
        return <NoticeBody store={store} />;
      },
    [store],
  );
  useToastNotice(
    'lineup-notice',
    notice
      ? {
          message: t('lineUp.title'),
          icon: 'crosshair',
          testId: 'lineup-notice',
          body: Body,
          closeLabel: t('syncNotice.dismiss'),
          onDismiss: () => {
            store.getState().dismiss();
          },
        }
      : null,
    notice,
  );
  return null;
}

/**
 * "Survey 13 April 2026 lined up with Survey 2 March 2026 (2.00 m)." with Undo; Ctrl+Z and Ctrl+Y
 * while it shows, as Drop to ground. Without a `store` it shows the app's (`lineUpApp`).
 */
export function LineUpNotice(props: { store?: StoreApi<LineUpStore> }) {
  const app = useStore(lineUpApp, (s) => s.store);
  const store = props.store ?? app;
  return store ? <Notice store={store} /> : null;
}
