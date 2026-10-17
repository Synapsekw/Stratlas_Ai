import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { otherUndo } from '../builder/AlignToNotice';
import { lineUpApp, type LineUpStore } from './lineUpStore';

function Notice({ store }: { store: StoreApi<LineUpStore> }) {
  const t = useT();
  const notice = useStore(store, (s) => s.notice);
  useEffect(() => {
    if (!notice?.action) return;
    const kind = notice.action.kind;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || otherUndo(e)) return;
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
  if (!notice) return null;
  return (
    <div className="toast" data-testid="lineup-notice">
      <div className="toast-h">
        <Icon name="crosshair" size={14} />
        <b>{t('lineUp.title')}</b>
        <span className="toast-grow" />
        {notice.action && (
          <button
            type="button"
            className="btn ghost sm"
            data-testid={`lineup-${notice.action.kind}`}
            onClick={() => void store.getState().apply()}
          >
            <Icon name="undo" size={12} />
            {notice.action.kind === 'undo' ? t('align.direction.undo') : t('align.direction.redo')}
          </button>
        )}
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('syncNotice.dismiss')}
          onClick={() => {
            store.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="lineup-text" dir="auto">
        {notice.text}
      </div>
    </div>
  );
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
