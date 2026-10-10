import { ariaKeys, Icon, shortcutHint, useT, type MessageKey, type ShortcutId } from '@aio/ui';

export type PanelSide = 'left' | 'right';

/** `id` of each side panel, for the controls that fold it away (`aria-controls`). */
export const PANEL_ID: Record<PanelSide, string> = {
  left: 'app-sidebar',
  right: 'right-panel',
};

const LABELS: Record<PanelSide, { collapse: MessageKey; expand: MessageKey }> = {
  left: { collapse: 'panel.collapseLeft', expand: 'panel.expandLeft' },
  right: { collapse: 'panel.collapseRight', expand: 'panel.expandRight' },
};

/** What the handle does next, in words: "Collapse left sidebar", "Expand right sidebar". */
export function panelHandleLabel(side: PanelSide, collapsed: boolean): MessageKey {
  return collapsed ? LABELS[side].expand : LABELS[side].collapse;
}

export interface PanelHandleProps {
  /** The side of the window the panel sits on (in a right-to-left layout the sides swap). */
  side: PanelSide;
  collapsed: boolean;
  /** The shortcut that does the same, shown in the tool tip. */
  shortcut: ShortcutId;
  onToggle: () => void;
}

/**
 * The tab on the inner edge of a side panel: one click folds the panel away or brings it back.
 * The same control on both sides, mirrored. It sits on the border between the panel and the main
 * view and stays there when the panel is folded (at the window edge for a panel that folds to
 * nothing), so a panel is never lost. Its chevron points the way the edge will move.
 */
export function PanelHandle({ side, collapsed, shortcut, onToggle }: PanelHandleProps) {
  const t = useT();
  const label = t(panelHandleLabel(side, collapsed));
  return (
    <button
      type="button"
      className="ph"
      data-side={side}
      data-testid={`panel-handle-${side}`}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={PANEL_ID[side]}
      aria-keyshortcuts={ariaKeys(shortcut)}
      onClick={onToggle}
    >
      <span className="ph-tab">
        <Icon name="chev-r" size={12} className="ph-chev" />
      </span>
      <span className="tip">
        {label} <span className="kbd">{shortcutHint(shortcut)}</span>
      </span>
    </button>
  );
}
