import { arrowFocus, Icon, useFocusTrap } from '@aio/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
  const list = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
    };
  }, [open]);
  // the first item takes focus, Esc closes and focus returns to the Export button
  useFocusTrap(list, open, {
    onEscape: () => {
      setOpen(false);
    },
    returnTo: () => button.current,
  });
  /** Up, Down, Home and End move between the items, as in any menu. */
  const arrows = (e: KeyboardEvent<HTMLDivElement>) => {
    if (list.current && arrowFocus(list.current, e.key)) e.preventDefault();
  };

  if (!actions.length) return null;
  return (
    <div className="xmenu" ref={root}>
      <button
        ref={button}
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
        <div ref={list} className="xmenu-list" role="menu" aria-label="Export" onKeyDown={arrows}>
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
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={legend}
              className="xmenu-opt"
              onClick={() => {
                setLegend(!legend);
              }}
            >
              <Icon name={legend ? 'check' : 'box'} size={14} />
              Legend on the 3D snapshot
            </button>
          )}
        </div>
      )}
    </div>
  );
}
