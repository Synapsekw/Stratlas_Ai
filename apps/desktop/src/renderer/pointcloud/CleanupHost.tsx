/**
 * The Clean up panel's place on the stage: loads the open project's recipes (once per project id),
 * binds the cleanup stage tools while the panel is open, and draws the panel, the bar of a drawn
 * selection and the notice with Undo.
 */
import type { EngineStage } from '@aio/engine';
import { ASPRS_CLASSES, classColour } from '@aio/pointcloud';
import { Icon, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { CleanupPanel } from './CleanupPanel';
import { applyPending, mountCleanupScene } from './cleanupScene';
import { cleanup, useCleanup } from './cleanupStore';
import './cleanup.css';

const SHOW_MS = 8000;

/** Loads the open project's recipes, binds the stage tools while the panel is open, draws the panel. */
export function CleanupHost({ engine }: { engine: EngineStage | null }) {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const open = useCleanup((s) => s.panelOpen);
  useEffect(() => {
    if (!projectId) return;
    // the layers as the project opened; a manifest reload (a saved copy) must not reset the history
    const layers = workspace.getState().project?.manifest.layers ?? [];
    void cleanup.load(projectId, layers);
  }, [projectId]);
  useEffect(() => (open && engine ? mountCleanupScene(engine) : undefined), [open, engine]);
  return (
    <>
      {open && <CleanupPanel stage={engine} />}
      {open && <SelectionBar />}
      <CleanupNotice />
    </>
  );
}

/**
 * The project closed or another opened: close the panel and forget the recipes and the history
 * (the next load reads again). Called once at start-up; returns the unsubscribe.
 */
export function closeCleanupWithProject(): () => void {
  return workspace.subscribe((s, prev) => {
    if ((s.project?.id ?? null) === (prev.project?.id ?? null)) return;
    cleanup.close();
    cleanup.closePanel();
  });
}

/** "N loaded points selected" with Hide, Delete, Set class and Cancel, bottom centre. */
function SelectionBar() {
  const t = useT();
  const pending = useCleanup((s) => s.pending);
  const [classes, setClasses] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  // a new selection starts with the class list closed
  const [seen, setSeen] = useState(pending);
  if (seen !== pending) {
    setSeen(pending);
    setClasses(false);
  }
  useEffect(() => {
    if (!classes) return;
    const away = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setClasses(false);
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [classes]);
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
      <div className="cleanup-class-anchor" ref={anchor}>
        <button
          type="button"
          className="btn sm"
          aria-expanded={classes}
          aria-haspopup="menu"
          data-testid="cleanup-set-class"
          onClick={() => {
            setClasses(!classes);
          }}
        >
          {t('cleanup.select.setClass')}
          <Icon name="chevup" size={12} />
        </button>
        {classes && (
          <div
            className="cleanup-class-list overlay-box"
            role="menu"
            aria-label={t('cleanup.select.setClass')}
            data-testid="cleanup-class-list"
          >
            {ASPRS_CLASSES.map((c) => (
              <button
                key={c.code}
                type="button"
                role="menuitem"
                className="pop-item"
                data-testid={`cleanup-class-${c.code}`}
                onClick={() => {
                  setClasses(false);
                  void applyPending(cleanup, { kind: 'class', value: c.code });
                }}
              >
                <i className="cleanup-swatch" style={{ background: classColour(c.code) }} />
                <span>
                  {c.code} {c.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
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

/** "Points deleted from saves and exports." with Undo, bottom centre; errors stay until dismissed. */
export function CleanupNotice() {
  const t = useT();
  const notice = useCleanup((s) => s.notice);
  // above the selection bar while a selection waits for its action
  const lifted = useCleanup((s) => s.panelOpen && s.pending !== null);
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
      className={`cleanup-notice notice${notice.error ? ' warn' : ''}${lifted ? ' lifted' : ''}`}
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
