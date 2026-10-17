import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { t } from './i18n';
import { Icon, type IconName } from './icons/Icon';
import { Menu, type MenuEntry } from './Menu';

export interface TabItem<K extends string> {
  id: K;
  label: string;
  count?: number;
  icon?: IconName;
  live?: boolean; // accent dot with a text label (aria-label t('tabs.live'))
  pinned?: boolean;
  onPinChange?: (pinned: boolean) => void; // shows a pin toggle
  onClose?: () => void; // shows a close button; click or middle-click only, no shortcut
  testId?: string; // the tab's data-testid, for specs that name it
}

export interface TabsProps<K extends string> {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (id: K) => void;
  label: string; // the tablist's name
  idPrefix: string; // tab ids `${idPrefix}-tab-${id}`, panels `${idPrefix}-panel-${id}`
  overflow?: 'wrap' | 'menu'; // default 'wrap'; 'menu' keeps one row, non-fitting tabs go to a "⋯ n" Menu
  overflowOrder?: (id: K) => number; // higher leaves first; the selected tab never leaves
}

/** Gap between tabs (matches `.tabs` in parts/tabs.css) and the room kept for the "⋯ n" button. */
const GAP = 2;
const MORE_WIDTH = 56;

/** Which tabs do not fit `avail`. Widest-order first; the selected tab never leaves. */
function overflowing<K extends string>(
  items: readonly TabItem<K>[],
  value: K,
  widths: ReadonlyMap<K, number>,
  avail: number,
  order: (id: K) => number,
): Set<K> {
  const w = (id: K) => widths.get(id) ?? 0;
  let used = items.reduce((sum, it) => sum + w(it.id), 0) + GAP * Math.max(0, items.length - 1);
  const out = new Set<K>();
  if (avail <= 0 || used <= avail) return out;
  used += MORE_WIDTH + GAP;
  const leaving = items
    .filter((it) => it.id !== value)
    .map((it, i) => ({ id: it.id, i, o: order(it.id) }))
    .sort((a, b) => b.o - a.o || b.i - a.i);
  for (const { id } of leaving) {
    if (used <= avail) break;
    out.add(id);
    used -= w(id) + GAP;
  }
  return out;
}

const sameSet = <K,>(a: ReadonlySet<K>, b: ReadonlySet<K>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
  overflow = 'wrap',
  overflowOrder,
}: TabsProps<K>): ReactElement {
  const boxRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const widths = useRef(new Map<K, number>());
  const [hidden, setHidden] = useState<ReadonlySet<K>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);

  const measureRef = useRef<() => void>(() => undefined);

  // Re-fit after every render; setHidden bails out when nothing changed.
  useLayoutEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      if (!box || overflow !== 'menu') return;
      for (const el of box.querySelectorAll<HTMLElement>('.tab-wrap[data-tab]')) {
        widths.current.set(el.dataset.tab as K, el.offsetWidth);
      }
      const next = overflowing(
        items,
        value,
        widths.current,
        box.clientWidth,
        (id) => overflowOrder?.(id) ?? items.findIndex((it) => it.id === id),
      );
      setHidden((prev) => (sameSet(prev, next) ? prev : next));
    };
    measureRef.current = measure;
    measure();
  });
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (overflow !== 'menu' || !box || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      measureRef.current();
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
    };
  }, [overflow]);

  const shown = overflow === 'menu' ? items.filter((it) => !hidden.has(it.id)) : items;
  const tucked = overflow === 'menu' ? items.filter((it) => hidden.has(it.id)) : [];

  const go = (id: K) => {
    onChange(id);
    document.getElementById(`${idPrefix}-tab-${id}`)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>, id: K) => {
    const i = shown.findIndex((it) => it.id === id);
    const dir =
      e.currentTarget.closest('[dir]')?.getAttribute('dir') ?? document.documentElement.dir;
    const flip = dir === 'rtl' ? -1 : 1;
    let to: number | null = null;
    if (e.key === 'ArrowRight') to = i + flip;
    else if (e.key === 'ArrowLeft') to = i - flip;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = shown.length - 1;
    if (to === null || shown.length === 0) return;
    e.preventDefault();
    const target = shown[(to + shown.length) % shown.length];
    if (target) go(target.id);
  };

  // The menu cannot stay open with nothing in it, or it would reopen by itself on the next overflow.
  if (tucked.length === 0 && menuOpen) setMenuOpen(false);

  const menuItems: MenuEntry[] = tucked.map((it) => ({
    id: it.id,
    label: [
      it.label,
      it.count !== undefined ? String(it.count) : null,
      it.live ? t('tabs.live') : null,
    ]
      .filter(Boolean)
      .join(' · '),
    ...(it.pinned ? { checked: true } : {}),
    ...(it.icon ? { icon: it.icon } : {}),
    onSelect: () => {
      onChange(it.id);
    },
  }));

  return (
    <div ref={boxRef} className="tabs" data-overflow={overflow}>
      {/* A tablist may hold only tabs, and each tab's pin and close sit beside it: so the tablist
          owns the tabs through aria-owns, and the row keeps tab, pin, close in keyboard order. */}
      <div
        className="tabs-owner"
        role="tablist"
        aria-label={label}
        aria-owns={shown.map((it) => `${idPrefix}-tab-${it.id}`).join(' ')}
      />
      <div className="tabs-list">
        {shown.map((it) => {
          const selected = it.id === value;
          return (
            <div
              key={it.id}
              className="tab-wrap"
              data-tab={it.id}
              data-selected={selected ? '' : undefined}
              onMouseDown={(e: MouseEvent) => {
                if (e.button === 1 && it.onClose) e.preventDefault();
              }}
              onAuxClick={(e: MouseEvent) => {
                if (e.button !== 1 || !it.onClose) return;
                e.preventDefault();
                it.onClose();
              }}
            >
              <button
                type="button"
                role="tab"
                className="tab"
                id={`${idPrefix}-tab-${it.id}`}
                data-testid={it.testId}
                aria-selected={selected}
                aria-controls={`${idPrefix}-panel-${it.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  onChange(it.id);
                }}
                onKeyDown={(e) => {
                  onKeyDown(e, it.id);
                }}
              >
                {it.icon ? <Icon name={it.icon} size={14} /> : null}
                {it.label}
                {it.live ? (
                  <span className="tab-live" role="img" aria-label={t('tabs.live')}>
                    <i />
                  </span>
                ) : null}
                {it.count !== undefined ? <span className="tab-count mono">{it.count}</span> : null}
              </button>
              {it.onPinChange ? (
                <button
                  type="button"
                  className="tab-pin"
                  aria-pressed={!!it.pinned}
                  aria-label={t('tabs.pin', { label: it.label })}
                  onClick={() => {
                    it.onPinChange?.(!it.pinned);
                  }}
                >
                  <Icon name="pin" size={12} />
                </button>
              ) : null}
              {it.onClose ? (
                <button
                  type="button"
                  className="tab-x"
                  aria-label={t('tabs.close', { label: it.label })}
                  onClick={() => {
                    it.onClose?.();
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {tucked.length > 0 ? (
        <>
          <button
            ref={moreRef}
            type="button"
            className={tucked.some((it) => it.live) ? 'tabs-more acc' : 'tabs-more'}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('tabs.more')}
            onClick={() => {
              setMenuOpen((o) => !o);
            }}
          >
            <Icon name="more" size={14} />
            <span className="mono">{tucked.length}</span>
          </button>
          <Menu
            open={menuOpen}
            onClose={() => {
              setMenuOpen(false);
            }}
            opener={moreRef}
            label={t('tabs.more')}
            items={menuItems}
          />
        </>
      ) : null}
    </div>
  );
}
