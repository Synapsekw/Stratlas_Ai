import { Icon, Menu, type MenuEntry } from '@aio/ui';
import { useRef, useState } from 'react';
import { useWorkspace } from '@aio/workspace';
import { useShell } from '../shell';
import { allowedActions, exportUnavailable } from './exportModel';
import { runExportAction } from './exports';

/**
 * "Export" button with every export format (Issues screen header); inside a package only the
 * exports its header allows, and no button when it allows none.
 */
export function ExportMenu() {
  const pkg = useShell((s) => s.pkg);
  const actions = allowedActions(pkg);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const issues = useWorkspace((s) => s.issues);
  const why = (id: (typeof actions)[number]['id']) =>
    manifest ? exportUnavailable(id, manifest, issues) : null;
  const [open, setOpen] = useState(false);
  const [legend, setLegend] = useState(true);
  const button = useRef<HTMLButtonElement>(null);

  if (!actions.length) return null;
  const items: MenuEntry[] = actions.map((a) => {
    // greyed with its reason where it would make an empty report (as on Reports)
    const reason = why(a.id);
    return {
      id: a.id,
      label: a.label,
      icon: a.icon,
      hint: reason ?? a.hint,
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => {
        runExportAction(a.id, { legend });
      },
    };
  });
  if (actions.some((a) => a.id === 'snapshot'))
    items.push('separator', {
      id: 'legend',
      label: 'Legend on the 3D snapshot',
      checked: legend,
      keepOpen: true,
      onSelect: () => {
        setLegend((v) => !v);
      },
    });
  return (
    <div className="xmenu">
      <button
        ref={button}
        type="button"
        className="btn sm"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="download" size={14} />
        Export
      </button>
      <Menu
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        opener={button}
        label="Export"
        items={items}
        anchor="below"
      />
    </div>
  );
}
