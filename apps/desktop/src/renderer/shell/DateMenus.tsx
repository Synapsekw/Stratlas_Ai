import type { Capture } from '@aio/schema';
import {
  arrowFocus,
  DATE_ICONS,
  formatDate,
  Icon,
  useFocusTrap,
  useT,
  type DateFolder,
  type DateFolderMenuRequest,
  type DateItemMenuRequest,
  type IconName,
} from '@aio/ui';
import { DATE_COLOURS, type DateTag } from '@aio/workspace';
import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
// the menu look is the drone and photo menus' (`.dmenu`)
import '../builder/builder.css';

const WIDTH = 286;

/** Close on a press outside, trap focus inside, Escape closes (as the drone and photo menus). */
function useMenu(list: RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', away, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
    };
  }, [list, close]);
  useFocusTrap(list, true, { onEscape: close });
}

/** Keep the menu inside the window. */
function place(x: number, y: number, height: number): CSSProperties {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    width: WIDTH,
  };
}

/** Up and Down walk the items; Left and Right walk a row of colours or icons. */
function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
  const root = e.currentTarget;
  const at = document.activeElement;
  if (
    (e.key === 'ArrowRight' || e.key === 'ArrowLeft') &&
    at instanceof HTMLElement &&
    at.classList.contains('dmenu-pick')
  ) {
    const next = e.key === 'ArrowRight' ? at.nextElementSibling : at.previousElementSibling;
    if (next instanceof HTMLElement) next.focus();
    e.preventDefault();
    return;
  }
  if (arrowFocus(root, e.key)) e.preventDefault();
}

export interface DateFolderMenuProps {
  menu: DateFolderMenuRequest;
  /** The folder as it is now (the request holds it as it was when the menu opened). */
  folder: DateFolder;
  tag: DateTag | undefined;
  focused: boolean;
  hidden: Readonly<Record<string, true>>;
  /** False in a read-only project: no rename, colour or icon. */
  canEdit: boolean;
  onClose: () => void;
  onFocus: (capture: string) => void;
  onSetVisible: (layerIds: string[], visible: boolean) => void;
  onRename: (capture: string) => void;
  onStyle: (capture: string, patch: { colour?: number | null; icon?: string | null }) => void;
}

/**
 * Right-click on a survey date folder: view the date, open or close the folder, show or hide its
 * layers and, in a project that can be edited, rename it and pick its colour and icon.
 */
export function DateFolderMenu(props: DateFolderMenuProps) {
  const { menu, folder, tag, focused, hidden, canEdit, onClose } = props;
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  useMenu(list, onClose);

  const capture = folder.capture;
  const shown = folder.layerIds.filter((id) => !hidden[id]).length;
  const item = (
    id: string,
    icon: IconName,
    label: string,
    run: () => void,
    o: { disabled?: boolean } = {},
  ): ReactNode => (
    <button
      key={id}
      type="button"
      role="menuitem"
      className="dmenu-item"
      disabled={o.disabled}
      data-testid={`date-menu-${id}`}
      onClick={() => {
        onClose();
        run();
      }}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );
  const edit = canEdit && capture !== null;

  return createPortal(
    <div
      ref={list}
      className="dmenu"
      role="menu"
      aria-label={t('tree.dates.menu.label', { date: folder.label })}
      style={place(menu.x, menu.y, edit ? 340 : 170)}
      data-testid="date-menu"
      onKeyDown={menuKeys}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div className="dmenu-h faint">
        {folder.label}
        {folder.sub ? ` · ${folder.sub}` : ''}
      </div>
      {capture &&
        item(
          'view',
          'target',
          t('tree.dates.menu.view'),
          () => {
            props.onFocus(capture.id);
          },
          { disabled: focused },
        )}
      {item(
        'toggle',
        menu.expanded ? 'chev-r' : 'chev-d',
        t(menu.expanded ? 'tree.dates.menu.collapse' : 'tree.dates.menu.expand'),
        menu.toggle,
      )}
      {folder.layerIds.length > 0 && (
        <>
          {item(
            'show',
            'eye',
            t('tree.dates.menu.showAll'),
            () => {
              props.onSetVisible([...folder.layerIds], true);
            },
            { disabled: shown === folder.layerIds.length },
          )}
          {item(
            'hide',
            'eye-off',
            t('tree.dates.menu.hideAll'),
            () => {
              props.onSetVisible([...folder.layerIds], false);
            },
            { disabled: shown === 0 },
          )}
        </>
      )}
      {edit && (
        <>
          <div className="dmenu-sep" role="separator" />
          {item('rename', 'tag', t('tree.dates.menu.rename'), () => {
            props.onRename(capture.id);
          })}
          <div className="dmenu-row" role="group" aria-label={t('tree.dates.menu.colour')}>
            <span>{t('tree.dates.menu.colour')}</span>
            <div className="dmenu-picks">
              {Array.from({ length: DATE_COLOURS }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  role="menuitemradio"
                  aria-checked={tag?.colourIndex === n}
                  className="dmenu-pick"
                  aria-label={t('tree.dates.menu.colourN', { n })}
                  title={t('tree.dates.menu.colourN', { n })}
                  data-testid={`date-menu-colour-${String(n)}`}
                  onClick={() => {
                    props.onStyle(capture.id, { colour: n });
                  }}
                >
                  <span
                    className="sw"
                    style={{ '--sw': `var(--date-${String(n)})` } as CSSProperties}
                  />
                </button>
              ))}
            </div>
          </div>
          <div className="dmenu-row" role="group" aria-label={t('tree.dates.menu.icon')}>
            <span>{t('tree.dates.menu.icon')}</span>
            <div
              className="dmenu-picks"
              style={tag ? ({ '--sw': tag.colour } as CSSProperties) : undefined}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!tag?.icon}
                className="dmenu-pick"
                aria-label={t('tree.dates.menu.iconNone')}
                title={t('tree.dates.menu.iconNone')}
                data-testid="date-menu-icon-none"
                onClick={() => {
                  props.onStyle(capture.id, { icon: null });
                }}
              >
                <span className="sw" />
              </button>
              {DATE_ICONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="menuitemradio"
                  aria-checked={tag?.icon === name}
                  className="dmenu-pick"
                  aria-label={t('tree.dates.menu.iconN', { name })}
                  title={t('tree.dates.menu.iconN', { name })}
                  data-testid={`date-menu-icon-${name}`}
                  onClick={() => {
                    props.onStyle(capture.id, { icon: name });
                  }}
                >
                  <Icon name={name} size={14} />
                </button>
              ))}
            </div>
          </div>
          {(tag?.picked === true || tag?.icon !== undefined) &&
            item('reset', 'undo', t('tree.dates.menu.reset'), () => {
              props.onStyle(capture.id, { colour: null, icon: null });
            })}
        </>
      )}
    </div>,
    document.body,
  );
}

export interface LayerDateMenuProps {
  menu: DateItemMenuRequest;
  /** The project's survey dates. */
  captures: readonly Capture[];
  tags: Readonly<Record<string, DateTag>>;
  /** The id of the Every date folder (`EVERY_DATE`). */
  every: string;
  onClose: () => void;
  onMove: (layerIds: string[], capture: string | null) => void;
}

/**
 * Right-click (or the menu key) on a dataset: file it under another survey date, or under none.
 * The same move as dragging the row onto a date folder, for the keyboard.
 */
export function LayerDateMenu({
  menu,
  captures,
  tags,
  every,
  onClose,
  onMove,
}: LayerDateMenuProps) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  useMenu(list, onClose);
  const newestFirst = [...captures].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );
  const row = (id: string, capture: string | null, label: string, swatch: ReactNode) => (
    <button
      key={id}
      type="button"
      role="menuitemradio"
      aria-checked={menu.from === id}
      className="dmenu-item"
      disabled={menu.from === id}
      data-testid={`move-to-${id}`}
      onClick={() => {
        onClose();
        onMove(menu.layerIds, capture);
      }}
    >
      {swatch}
      <span>{label}</span>
    </button>
  );
  return createPortal(
    <div
      ref={list}
      className="dmenu"
      role="menu"
      aria-label={t('tree.dates.move.label', { name: menu.item.name })}
      style={place(menu.x, menu.y, Math.min(60 + (captures.length + 1) * 30, 340))}
      data-testid="move-menu"
      onKeyDown={menuKeys}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div className="dmenu-h faint">
        {t('tree.dates.move.title')} · {menu.item.name}
      </div>
      <div className="dmenu-scroll">
        {row(every, null, t('tree.dates.move.none'), <span className="sw none" />)}
        {newestFirst.map((c) =>
          row(
            c.id,
            c.id,
            c.label !== c.date ? `${formatDate(c.date)} · ${c.label}` : formatDate(c.date),
            <span
              className="sw"
              style={{ '--sw': tags[c.id]?.colour ?? 'var(--fg-3)' } as CSSProperties}
            />,
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
