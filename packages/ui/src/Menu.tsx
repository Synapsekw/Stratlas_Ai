import { useRef, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import { arrowFocus } from './focus';
import { Icon, type IconName } from './icons/Icon';
import { Popover } from './Popover';
import { shortcutHint, type ShortcutId } from './shortcuts';

export type MenuEntry =
  | {
      id: string;
      label: string;
      icon?: IconName;
      shortcut?: ShortcutId;
      checked?: boolean;
      danger?: boolean;
      disabledReason?: string;
      onSelect: () => void;
    }
  | 'separator';

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  opener: RefObject<HTMLElement | null>;
  label: string;
  items: readonly MenuEntry[];
  anchor?: 'above' | 'below'; // default 'below'
  testId?: string;
}

/**
 * A menu of actions on the one floating surface. Choosing an item closes the menu first and then
 * runs it, so what it opens (a dialog) stacks above a menu that is already gone.
 */
export function Menu({
  open,
  onClose,
  opener,
  label,
  items,
  anchor = 'below',
  testId,
}: MenuProps): ReactElement | null {
  const list = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (arrowFocus(e.currentTarget, e.key)) e.preventDefault();
  };
  return (
    <Popover open={open} onClose={onClose} opener={opener} anchor={anchor} className="menu-pop">
      <div
        ref={list}
        role="menu"
        aria-label={label}
        className="menu-list"
        data-testid={testId}
        onKeyDown={onKey}
      >
        {items.map((it, i) => {
          if (it === 'separator')
            return <div key={`sep-${String(i)}`} className="menu-sep" role="separator" />;
          const disabled = it.disabledReason !== undefined;
          return (
            <button
              key={it.id}
              type="button"
              role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={it.checked}
              aria-disabled={disabled ? true : undefined}
              aria-description={it.disabledReason}
              className="row"
              data-kind="menu"
              data-danger={it.danger ? '' : undefined}
              onClick={() => {
                if (disabled) return;
                onClose();
                it.onSelect();
              }}
            >
              <span className="menu-lead">
                {it.checked === true ? (
                  <Icon name="check" size={14} />
                ) : it.icon ? (
                  <Icon name={it.icon} size={14} />
                ) : null}
              </span>
              <span className="menu-label">{it.label}</span>
              {it.shortcut && <span className="menu-kbd">{shortcutHint(it.shortcut)}</span>}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
