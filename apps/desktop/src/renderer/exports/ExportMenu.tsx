import { Icon } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import { useShell } from '../shell';
import { allowedActions } from './exportModel';
import { runExportAction } from './exports';

/**
 * "Export" button with every export format (Issues screen header); inside a package only the
 * exports its header allows, and no button when it allows none.
 */
export function ExportMenu() {
  const pkg = useShell((s) => s.pkg);
  const actions = allowedActions(pkg);
  const [open, setOpen] = useState(false);
  const [legend, setLegend] = useState(true);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!actions.length) return null;
  return (
    <div className="xmenu" ref={root}>
      <button
        type="button"
        className="btn sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="download" size={14} />
        Export
      </button>
      {open && (
        <div className="xmenu-list" role="menu" aria-label="Export">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className="xmenu-item"
              onClick={() => {
                setOpen(false);
                runExportAction(a.id, { legend });
              }}
            >
              <Icon name={a.icon} size={14} />
              <span>{a.label}</span>
              <span className="muted">{a.hint}</span>
            </button>
          ))}
          {actions.some((a) => a.id === 'snapshot') && (
            <label className="xmenu-opt">
              <input
                type="checkbox"
                checked={legend}
                onChange={(e) => {
                  setLegend(e.target.checked);
                }}
              />
              Legend on the 3D snapshot
            </label>
          )}
        </div>
      )}
    </div>
  );
}
