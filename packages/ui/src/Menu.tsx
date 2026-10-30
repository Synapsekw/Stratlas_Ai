import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from 'react';
import { Icon, type IconName } from './icons/Icon';
import { Popover } from './Popover';
import { shortcutHint, type ShortcutId } from './shortcuts';

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: ShortcutId;
  checked?: boolean;
  danger?: boolean;
  disabledReason?: string;
  /** Runs after the menu closed. Not called for an item with `children`. */
  onSelect?: () => void;
  /** A submenu ("Position >", "File under >"): Right arrow, Enter or a hover opens it. */
  children?: readonly MenuEntry[];
  testId?: string;
}

export type MenuEntry = MenuItem | 'separator';

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  opener: RefObject<HTMLElement | null>;
  label: string;
  items: readonly MenuEntry[];
  anchor?: 'above' | 'below'; // default 'below'
  testId?: string;
}

/** A typed prefix is forgotten after this pause, so the next letter starts a new search. */
export const TYPEAHEAD_RESET_MS = 500;
/** Gap kept between a submenu and the window edge. */
const EDGE = 8;

/** The opener is a plain button: it carries aria-haspopup and aria-expanded for the menu. */
function isButton(el: HTMLElement): boolean {
  const role = el.getAttribute('role');
  return role === 'button' || (role === null && el.tagName === 'BUTTON');
}

/**
 * A menu of actions on the one floating surface. Arrow keys rove between the items (only the
 * current one is in the tab order), Home and End go to the ends, typing a letter jumps to the next
 * item that starts with what was typed, and Tab closes it. An item with `children` opens a
 * submenu (Right arrow, Enter, a click or a hover); Left arrow or Escape closes the submenu and
 * returns to its item. Choosing an item closes the menu first and then runs it, so what it opens
 * (a dialog) stacks above a menu that is already gone.
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
  // the button that opens it says so, and says whether the menu is open
  useEffect(() => {
    const el = opener.current;
    if (!el || !isButton(el)) return;
    el.setAttribute('aria-haspopup', 'menu');
    el.setAttribute('aria-expanded', String(open));
  }, [open, opener]);
  return (
    <Popover open={open} onClose={onClose} opener={opener} anchor={anchor} className="menu-pop">
      <MenuLevel items={items} label={label} onClose={onClose} opener={opener} testId={testId} />
    </Popover>
  );
}

interface LevelProps {
  items: readonly MenuEntry[];
  label: string;
  onClose: () => void;
  /** The menu's opener: focus goes back to it before a chosen item runs. */
  opener: RefObject<HTMLElement | null>;
  testId?: string | undefined;
  id?: string;
  /** In a submenu: close it and focus its item. */
  onBack?: () => void;
  /** Focus the first item when mounted (a submenu opened from the keyboard or a click). */
  focusFirst?: boolean;
}

interface OpenSub {
  id: string;
  /** Move focus into it (opened by key or click, not by hover). */
  focus: boolean;
}

function MenuLevel({
  items,
  label,
  onClose,
  opener,
  testId,
  id,
  onBack,
  focusFirst,
}: LevelProps): ReactElement {
  const list = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [sub, setSub] = useState<OpenSub | null>(null);
  const subId = useId();
  const typed = useRef({ text: '', at: 0 });
  const rows = () => [
    ...(list.current?.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]') ?? []),
  ];
  const entries = items.filter((x): x is MenuItem => x !== 'separator');
  const openable = (it: MenuItem | undefined) =>
    it?.children !== undefined && it.disabledReason === undefined;

  // when the submenu appears from a key or a click, or a hovered one is then entered by key
  useEffect(() => {
    if (focusFirst) rows()[0]?.focus();
  }, [focusFirst]);

  // keys are handled on the element itself, before the popover's own Tab and Escape handling
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useLayoutEffect(() => {
    onKey.current = (e: KeyboardEvent) => {
      const el = list.current;
      if (!el || e.target === null || !el.contains(e.target as Node)) return;
      const all = rows();
      const at = all.indexOf(document.activeElement as HTMLElement);
      const rtl = getComputedStyle(el).direction === 'rtl';
      const inward = rtl ? 'ArrowLeft' : 'ArrowRight';
      const outward = rtl ? 'ArrowRight' : 'ArrowLeft';
      const go = (i: number) => {
        const n = all.length;
        if (n === 0) return;
        setSub(null);
        all[((i % n) + n) % n]?.focus();
      };
      const used = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'ArrowDown') {
        used();
        go(at + 1);
      } else if (e.key === 'ArrowUp') {
        used();
        go(at < 0 ? -1 : at - 1);
      } else if (e.key === 'Home') {
        used();
        go(0);
      } else if (e.key === 'End') {
        used();
        go(-1);
      } else if (e.key === inward) {
        const it = entries[at];
        if (!openable(it) || !it) return;
        used();
        setSub({ id: it.id, focus: true });
      } else if ((e.key === outward || e.key === 'Escape') && onBack) {
        used();
        onBack();
      } else if (e.key === 'Tab') {
        used();
        onClose();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        const fresh = now - typed.current.at > TYPEAHEAD_RESET_MS;
        // Space presses the item, unless it is part of a name being typed ("cut a")
        if (e.key === ' ' && (fresh || typed.current.text === '')) return;
        used();
        const text = (fresh ? '' : typed.current.text) + e.key.toLowerCase();
        typed.current = { text, at: now };
        // a new search starts after the current item; a longer prefix may match the current one
        const from = text.length === 1 ? at + 1 : Math.max(at, 0);
        for (let k = 0; k < entries.length; k++) {
          const i = (from + k) % entries.length;
          if (entries[i]?.label.toLowerCase().startsWith(text)) {
            go(i);
            break;
          }
        }
      }
    };
  });
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      onKey.current(e);
    };
    el.addEventListener('keydown', handler);
    return () => {
      el.removeEventListener('keydown', handler);
    };
  }, []);

  const openItem = sub ? entries.find((x) => x.id === sub.id) : undefined;
  const parentEl = () => rows().find((r) => r.dataset.item === sub?.id) ?? null;
  const indexOf = new Map(entries.map((x, i) => [x.id, i]));
  return (
    <>
      <div
        ref={list}
        id={id}
        role="menu"
        aria-label={label}
        className="menu-list"
        data-testid={testId}
      >
        {items.map((it, i) => {
          if (it === 'separator')
            return <div key={`sep-${String(i)}`} className="menu-sep" role="separator" />;
          const index = indexOf.get(it.id) ?? -1;
          const disabled = it.disabledReason !== undefined;
          const parent = it.children !== undefined;
          const expanded = sub?.id === it.id;
          return (
            <button
              key={it.id}
              type="button"
              role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              tabIndex={index === active ? 0 : -1}
              aria-checked={it.checked}
              aria-disabled={disabled ? true : undefined}
              aria-description={it.disabledReason}
              aria-haspopup={parent ? 'menu' : undefined}
              aria-expanded={parent ? expanded : undefined}
              aria-controls={parent && expanded ? subId : undefined}
              className="row"
              data-kind="menu"
              data-item={it.id}
              data-danger={it.danger ? '' : undefined}
              data-testid={it.testId}
              onFocus={() => {
                setActive(index);
              }}
              onPointerEnter={() => {
                if (parent && !disabled) setSub({ id: it.id, focus: false });
                else if (sub) setSub(null);
              }}
              onClick={() => {
                if (disabled) return;
                if (parent) {
                  setSub({ id: it.id, focus: true });
                  return;
                }
                onClose();
                // focus back on the opener first, so a dialog the item opens returns focus there
                opener.current?.focus();
                it.onSelect?.();
              }}
            >
              <span className="menu-lead">
                {it.checked === true ? (
                  <Icon name="check" size={14} />
                ) : it.icon ? (
                  <Icon name={it.icon} size={14} />
                ) : null}
              </span>
              <span className="row-label">{it.label}</span>
              {it.shortcut && <span className="menu-kbd">{shortcutHint(it.shortcut)}</span>}
              {parent && (
                <span className="menu-kbd menu-chev">
                  <Icon name="chev-r" size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {openItem?.children && sub && (
        <SubMenu
          key={openItem.id}
          id={subId}
          anchor={parentEl}
          items={openItem.children}
          label={openItem.label}
          onClose={onClose}
          opener={opener}
          focusFirst={sub.focus}
          onBack={() => {
            const back = parentEl();
            setSub(null);
            back?.focus();
          }}
        />
      )}
    </>
  );
}

interface SubMenuProps extends Omit<LevelProps, 'testId'> {
  id: string;
  anchor: () => HTMLElement | null;
}

/**
 * A submenu beside its item, on the inline-end side (the other when it does not fit), inside the
 * root menu's box so a press on it is not a press outside the menu.
 */
function SubMenu({ anchor, ...level }: SubMenuProps): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', opacity: 0 });
  useLayoutEffect(() => {
    const a = anchor()?.getBoundingClientRect();
    const b = box.current;
    if (!a || !b) return;
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const rtl = getComputedStyle(b).direction === 'rtl';
    const after = a.right + EDGE + w <= window.innerWidth;
    const before = a.left - w - EDGE >= 0;
    const left = (rtl ? !before && after : after || !before) ? a.right : a.left - w;
    setStyle({
      position: 'fixed',
      left: `${String(Math.max(EDGE, left))}px`,
      top: `${String(Math.max(EDGE, Math.min(a.top - 4, window.innerHeight - h - EDGE)))}px`,
      maxHeight: `${String(window.innerHeight - 2 * EDGE)}px`,
      overflowY: 'auto',
    });
    // placed once when it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={box} className="surface-pop menu-pop menu-sub" style={style}>
      <MenuLevel {...level} />
    </div>
  );
}
