import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { dismissNotice, undoClassEdit, useClasses } from './store';

const SHOW_MS = 8000;

/** "Class X created." with Undo, bottom centre; errors stay until dismissed (ANN-7). */
export function ClassNotice() {
  const t = useT();
  const notice = useClasses((s) => s.notice);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(dismissNotice, SHOW_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      className={`class-notice notice${notice.error ? ' warn' : ''}`}
      role="status"
      data-testid="class-notice"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <span>{notice.text}</span>
      {notice.undo && (
        <button
          type="button"
          className="btn ghost sm"
          data-testid="class-notice-undo"
          onClick={() => {
            void undoClassEdit();
          }}
        >
          {t('classes.undo')}
        </button>
      )}
      <button
        type="button"
        className="btn ghost icon sm"
        aria-label={t('classes.dismiss')}
        onClick={dismissNotice}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
