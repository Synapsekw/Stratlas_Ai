// packages/ui/src/actions/ContextMenu.tsx
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { arrowFocus, useFocusTrap } from '../focus';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { SECTION_ORDER, type ResolvedItem, type SubItem } from './types';

export const MENU_WIDTH = 286;
const TYPE_AHEAD_MS = 700;

/** Where a menu of `w` by `h` opened at (x, y) goes so that it stays inside the window. */
export function placeMenu(x: number, y: number, w: number, h: number, vw: number, vh: number) {
  return { left: Math.max(8, Math.min(x, vw - w - 8)), top: Math.max(8, Math.min(y, vh - h - 8)) };
}

export interface ContextMenuProps {
  items: readonly ResolvedItem[];
  x: number;
  y: number;
  /** The menu's accessible name. */
  label: string;
  /** The heading drawn at the top (a name, "3 datasets"). */
  title?: string | undefined;
  /** Default `ctx-menu`; the date and dataset menus keep `date-menu` and `move-menu`. */
  testId?: string | undefined;
  /** Open this item's submenu at once; Escape then closes the menu. */
  initialSub?: string | undefined;
  onClose: () => void;
}

/**
 * The right-click menu (spec section 2): sections in a fixed order with separators, a header,
 * shortcuts, greyed items with their reason; Up, Down, Home, End and type-ahead; Right opens a
 * submenu (its items replace the menu's, with Back), Left and Escape go back; focus returns to
 * the invoker on close.
 */
export function ContextMenu(props: ContextMenuProps) {
  const { items, onClose } = props;
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<string | null>(props.initialSub ?? null);
  const [height, setHeight] = useState<number | null>(null);
  const typed = useRef({ text: '', at: 0 });

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', away, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
    };
  }, [onClose]);
  useFocusTrap(list, true, {
    onEscape: () => {
      if (view !== null && props.initialSub === undefined) setView(null);
      else onClose();
    },
  });
  // measured height once drawn (a picked colour adds Reset; a submenu swaps the items)
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight > 0) setHeight(el.offsetHeight);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  // after a view switch the pressed button is gone: focus the first item of the new view
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    list.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [view]);

  const placed = placeMenu(
    props.x,
    props.y,
    MENU_WIDTH,
    height ?? 300,
    window.innerWidth,
    window.innerHeight,
  );
  const style: CSSProperties = { ...placed, width: MENU_WIDTH };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const root = e.currentTarget;
    const at = document.activeElement;
    if (!(at instanceof HTMLElement)) return;
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && at.classList.contains('dmenu-pick')) {
      const next = e.key === 'ArrowRight' ? at.nextElementSibling : at.previousElementSibling;
      if (next instanceof HTMLElement) next.focus();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight' && at.dataset.sub) {
      e.preventDefault();
      setView(at.dataset.sub);
      return;
    }
    if (e.key === 'ArrowLeft' && view !== null && props.initialSub === undefined) {
      e.preventDefault();
      setView(null);
      return;
    }
    if (arrowFocus(root, e.key)) {
      e.preventDefault();
      return;
    }
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      const text =
        (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : '') + e.key.toLowerCase();
      typed.current = { text, at: now };
      const hit = [...root.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) =>
        (el.getAttribute('data-label') ?? el.textContent).toLowerCase().startsWith(text),
      );
      if (hit) {
        hit.focus();
        e.preventDefault();
      }
    }
  };

  // rows another feature adds under an item: one that throws must not take the menu down
  const rowsAfter = (s: SubItem): ReactNode => {
    try {
      return s.after?.(onClose);
    } catch {
      return null;
    }
  };

  const subButton = (
    s: SubItem,
    onPick: () => void,
    role: 'menuitem' | 'menuitemradio' = 'menuitem',
  ): ReactNode => (
    <Fragment key={s.id}>
      <button
        type="button"
        role={role}
        className="dmenu-item"
        aria-disabled={s.disabled ? true : undefined}
        aria-checked={role === 'menuitemradio' ? s.checked === true : undefined}
        title={s.disabled === false ? undefined : s.disabled}
        data-testid={s.testId}
        data-label={s.label}
        onClick={() => {
          if (!s.disabled) onPick();
        }}
      >
        {s.swatch !== undefined ? (
          <span className="sw" style={{ '--sw': s.swatch } as CSSProperties} />
        ) : s.icon ? (
          <Icon name={s.icon} size={14} />
        ) : null}
        <span>{s.label}</span>
        {s.disabled && <span className="faint">{s.disabled}</span>}
      </button>
      {rowsAfter(s)}
    </Fragment>
  );

  const run = (it: ResolvedItem, sub?: string) => {
    onClose();
    it.run(sub);
  };

  const body = (): ReactNode => {
    const open = view === null ? null : items.find((i) => i.id === view);
    if (open) {
      let group: string | undefined;
      return (
        <>
          {props.initialSub === undefined && (
            <button
              type="button"
              role="menuitem"
              className="dmenu-item"
              data-testid="ctx-back"
              onClick={() => {
                setView(null);
              }}
            >
              <Icon name="back" size={14} />
              <span>{t('tree.dates.menu.back')}</span>
            </button>
          )}
          <div className="dmenu-h faint">{open.subTitle ?? open.label}</div>
          <div className="dmenu-scroll">
            {open.sub.map((s) => {
              const head =
                s.group !== undefined && s.group !== group ? (
                  <div key={`g-${s.group}`} className="dmenu-h faint">
                    {s.group}
                  </div>
                ) : null;
              group = s.group;
              return (
                <Fragment key={s.id}>
                  {head}
                  {subButton(s, () => {
                    run(open, s.id);
                  })}
                </Fragment>
              );
            })}
          </div>
        </>
      );
    }
    const out: ReactNode[] = [];
    let section: string | null = null;
    // sections in their fixed order whoever built the list (the sort is stable)
    const sorted = [...items].sort(
      (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
    );
    for (const it of sorted) {
      if (section !== null && it.section !== section)
        out.push(<div key={`sep-${it.id}`} className="dmenu-sep" role="separator" />);
      section = it.section;
      if (it.present === 'inline') {
        out.push(
          <Fragment key={it.id}>
            <div className="dmenu-h faint">{it.label}</div>
            <div className="dmenu-scroll">
              {it.sub.map((s) =>
                subButton(
                  s,
                  () => {
                    run(it, s.id);
                  },
                  'menuitemradio',
                ),
              )}
            </div>
          </Fragment>,
        );
      } else if (it.present === 'picks') {
        out.push(
          <div key={it.id} className="dmenu-row" role="group" aria-label={it.label}>
            <span>{it.label}</span>
            <div className="dmenu-picks">
              {it.sub.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.checked === true}
                  className="dmenu-pick"
                  aria-label={s.label}
                  title={s.label}
                  data-testid={s.testId}
                  aria-disabled={s.disabled ? true : undefined}
                  onClick={() => {
                    if (!s.disabled) it.run(s.id);
                  }}
                >
                  {s.icon ? (
                    <Icon name={s.icon} size={14} />
                  ) : (
                    <span
                      className="sw"
                      style={
                        s.swatch !== undefined ? ({ '--sw': s.swatch } as CSSProperties) : undefined
                      }
                    />
                  )}
                </button>
              ))}
            </div>
          </div>,
        );
      } else {
        const sub = it.present === 'submenu';
        out.push(
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className={it.section === 'danger' ? 'dmenu-item danger' : 'dmenu-item'}
            aria-disabled={it.disabled ? true : undefined}
            aria-haspopup={sub ? 'menu' : undefined}
            title={it.disabled === false ? undefined : it.disabled}
            data-testid={it.testId}
            data-label={it.label}
            data-sub={sub && !it.disabled ? it.id : undefined}
            onClick={() => {
              if (it.disabled) return;
              if (sub) setView(it.id);
              else run(it);
            }}
          >
            {it.icon && <Icon name={it.icon} size={14} />}
            <span>{it.label}</span>
            {it.shortcut && <span className="dmenu-kbd">{it.shortcut}</span>}
            {sub && <Icon name="chev-r" size={12} className="faint" />}
          </button>,
        );
      }
    }
    return out;
  };

  return createPortal(
    <div
      ref={list}
      className="dmenu"
      role="menu"
      aria-label={props.label}
      style={style}
      data-testid={props.testId ?? 'ctx-menu'}
      onKeyDown={onKey}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      {view === null && props.title && <div className="dmenu-h faint">{props.title}</div>}
      {body()}
    </div>,
    document.body,
  );
}
