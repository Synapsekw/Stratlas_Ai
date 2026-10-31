/**
 * The Clean up panel's place on the stage: binds the cleanup stage tools while the panel is open
 * and hands the engine to the panel's tab (CleanupTab, in the sidebar), and draws the bar of a
 * drawn selection and the notice with Undo. The recipes load with
 * the project, not here (cleanupStore.ts `followProjectForCleanup`, from bootstrap).
 */
import type { EngineStage } from '@aio/engine';
import { ASPRS_CLASSES, classColour } from '@aio/pointcloud';
import { Icon, Menu, useT } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import { applyPending, mountCleanupScene } from './cleanupScene';
import { setCleanupStage } from './cleanupStage';
import { cleanup, useCleanup } from './cleanupStore';
import './cleanup.css';

const SHOW_MS = 8000;

/** Binds the stage tools while the panel is open, draws the selection bar and the notice. */
export function CleanupHost({ engine }: { engine: EngineStage | null }) {
  const open = useCleanup((s) => s.panelOpen);
  useEffect(() => (open && engine ? mountCleanupScene(engine) : undefined), [open, engine]);
  useEffect(() => {
    setCleanupStage(engine);
    return () => {
      setCleanupStage(null);
    };
  }, [engine]);
  return (
    <>
      {open && <SelectionBar />}
      <CleanupNotice />
    </>
  );
}

/** "N loaded points selected" with Hide, Delete, Set class and Cancel, bottom centre. */
function SelectionBar() {
  const t = useT();
  const pending = useCleanup((s) => s.pending);
  const [classes, setClasses] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  // a new selection starts with the class list closed
  const [seen, setSeen] = useState(pending);
  if (seen !== pending) {
    setSeen(pending);
    setClasses(false);
  }
  if (!pending) return null;
  return (
    <div
      className="cleanup-bar overlay-box"
      data-surface="dark"
      role="toolbar"
      aria-label={t('cleanup.select.title')}
      data-testid="cleanup-selection-bar"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (classes) setClasses(false);
        else cleanup.setPending(null);
      }}
    >
      <span className="cleanup-bar-count" data-testid="cleanup-selection-count">
        {t('cleanup.select.count', { count: pending.count })}
      </span>
      <button
        type="button"
        className="btn sm"
        data-testid="cleanup-hide"
        onClick={() => {
          void applyPending(cleanup, { kind: 'hide' });
        }}
      >
        {t('cleanup.select.hide')}
      </button>
      <button
        type="button"
        className="btn sm danger"
        data-testid="cleanup-delete"
        onClick={() => {
          void applyPending(cleanup, { kind: 'delete' });
        }}
      >
        {t('cleanup.select.delete')}
      </button>
      <button
        ref={opener}
        type="button"
        className="btn sm"
        data-testid="cleanup-set-class"
        onClick={() => {
          setClasses(!classes);
        }}
      >
        {t('cleanup.select.setClass')}
        <Icon name="chevup" size={12} />
      </button>
      <Menu
        open={classes}
        onClose={() => {
          setClasses(false);
        }}
        opener={opener}
        anchor="above"
        label={t('cleanup.select.setClass')}
        testId="cleanup-class-list"
        items={ASPRS_CLASSES.map((c) => ({
          id: String(c.code),
          label: `${String(c.code)} ${c.name}`,
          lead: <i className="cleanup-swatch" style={{ background: classColour(c.code) }} />,
          testId: `cleanup-class-${String(c.code)}`,
          onSelect: () => {
            void applyPending(cleanup, { kind: 'class', value: c.code });
          },
        }))}
      />
      <button
        type="button"
        className="btn ghost sm"
        data-testid="cleanup-cancel"
        onClick={() => {
          cleanup.setPending(null);
        }}
      >
        {t('cleanup.select.cancel')}
      </button>
    </div>
  );
}

/** "Points deleted from saves and exports." with Undo, top centre; errors stay until dismissed. */
export function CleanupNotice() {
  const t = useT();
  const notice = useCleanup((s) => s.notice);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(cleanup.dismiss, SHOW_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      className={`cleanup-notice notice${notice.error ? ' warn' : ''}`}
      role="status"
      data-testid="cleanup-notice"
    >
      <span>{notice.text}</span>
      {notice.undo && notice.layerId && (
        <button
          type="button"
          className="btn ghost sm"
          data-testid="cleanup-notice-undo"
          onClick={() => {
            const id = notice.layerId;
            cleanup.dismiss();
            if (id) void cleanup.undo(id);
          }}
        >
          {t('cleanup.notice.undo')}
        </button>
      )}
      <button
        type="button"
        className="btn ghost icon sm"
        aria-label={t('cleanup.notice.dismiss')}
        onClick={cleanup.dismiss}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
