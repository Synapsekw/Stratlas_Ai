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
import { DATE_COLOURS, dateTags, useWorkspace, type DateTag } from '@aio/workspace';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useGraphics } from '../graphics';
import { useShell } from '../shell';
import { useCaptureIndex } from '../workspace/compare';
import {
  COMPARE_WITH_ACTIONS,
  compareTargets,
  compareWith,
  type CompareContext,
  type CompareRequest,
} from '../workspace/compareWith';
import { DEFAULT_SPLIT } from '../workspace/splitModel';
import { useStagePrefs } from '../workspace/stagePrefs';
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

function dateLabel(c: Capture): string {
  return c.label !== c.date ? `${formatDate(c.date)} · ${c.label}` : formatDate(c.date);
}

/** What "Compare with" reads: the project's layers and dates, the stage and the saved split. */
function useCompareContext(): CompareContext | null {
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const id = useWorkspace((s) => s.project?.id);
  const index = useCaptureIndex();
  const stageMode = useShell((s) => s.stageMode);
  const saved = useStagePrefs((s) => (id ? s.byProject[id]?.split : undefined));
  const tier = useGraphics((s) => s.tier);
  return useMemo(
    () =>
      layers && index ? { layers, index, stageMode, split: saved ?? DEFAULT_SPLIT, tier } : null,
    [layers, index, stageMode, saved, tier],
  );
}

/** A date can be compared when it is one of at least two survey dates. */
function canCompare(ctx: CompareContext | null, from: string | null): ctx is CompareContext {
  return (
    ctx !== null &&
    from !== null &&
    ctx.index.captures.length > 1 &&
    ctx.index.captures.some((c) => c.id === from)
  );
}

/** After the view switches the pressed button is gone: put focus on the first item of the new view. */
function useViewFocus(list: RefObject<HTMLDivElement | null>, view: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    list.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [list, view]);
}

interface CompareListProps {
  from: string;
  /** The layers to compare; none compares the whole date. */
  layers?: readonly string[];
  ctx: CompareContext;
  onBack: () => void;
  onClose: () => void;
}

/** The dates to compare with, newest first; a disabled one says why. Replaces the menu's items. */
function CompareList({ from, layers, ctx, onBack, onClose }: CompareListProps) {
  const t = useT();
  const targets = compareTargets(from, layers, ctx);
  const byId = new Map(ctx.index.captures.map((c) => [c.id, c]));
  const tags = dateTags(ctx.index.captures);
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="dmenu-item"
        data-testid="compare-back"
        onClick={onBack}
      >
        <Icon name="back" size={14} />
        <span>{t('tree.dates.menu.back')}</span>
      </button>
      <div className="dmenu-h faint">
        {t('tree.dates.menu.compareTitle', { date: formatDate(byId.get(from)?.date ?? from) })}
      </div>
      <div className="dmenu-scroll">
        {targets.map(({ capture, reason }) => {
          const c = byId.get(capture);
          const request: CompareRequest = layers
            ? { from, to: capture, layers }
            : { from, to: capture };
          return (
            <div key={capture}>
              <button
                type="button"
                role="menuitem"
                className="dmenu-item"
                disabled={reason !== null}
                data-testid={`compare-to-${capture}`}
                onClick={() => {
                  onClose();
                  compareWith(request);
                }}
              >
                <span
                  className="sw"
                  style={{ '--sw': tags[capture]?.colour ?? 'var(--fg-3)' } as CSSProperties}
                />
                <span>{c ? dateLabel(c) : capture}</span>
                {reason && <span className="faint">{t(reason)}</span>}
              </button>
              {reason === null &&
                COMPARE_WITH_ACTIONS.map((Action, i) => (
                  <Action key={i} request={request} close={onClose} />
                ))}
            </div>
          );
        })}
      </div>
    </>
  );
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
  const [view, setView] = useState<'menu' | 'compare'>('menu');
  useViewFocus(list, view);
  const ctx = useCompareContext();

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
  const compare = canCompare(ctx, capture?.id ?? null);

  return createPortal(
    <div
      ref={list}
      className="dmenu"
      role="menu"
      aria-label={t('tree.dates.menu.label', { date: folder.label })}
      style={place(menu.x, menu.y, edit || view === 'compare' ? 340 : compare ? 200 : 170)}
      data-testid="date-menu"
      onKeyDown={menuKeys}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      {view === 'compare' && compare && capture ? (
        <CompareList
          from={capture.id}
          ctx={ctx}
          onBack={() => {
            setView('menu');
          }}
          onClose={onClose}
        />
      ) : (
        <>
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
          {compare && (
            <button
              type="button"
              role="menuitem"
              className="dmenu-item"
              data-testid="date-menu-compare"
              onClick={() => {
                setView('compare');
              }}
            >
              <Icon name="split" size={14} />
              <span>{t('tree.dates.menu.compare')}</span>
            </button>
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
  /** False in a read-only project: compare only, no filing under a date. */
  canEdit: boolean;
  onClose: () => void;
  onMove: (layerIds: string[], capture: string | null) => void;
}

/**
 * Right-click (or the menu key) on a dataset or a group header: file it under another survey date,
 * or under none. The same move as dragging the row onto a date folder, for the keyboard.
 */
export function LayerDateMenu({
  menu,
  captures,
  tags,
  every,
  canEdit,
  onClose,
  onMove,
}: LayerDateMenuProps) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  useMenu(list, onClose);
  const [view, setView] = useState<'menu' | 'compare'>('menu');
  useViewFocus(list, view);
  const ctx = useCompareContext();
  const compare = canCompare(ctx, menu.from);
  // read-only and nothing to compare: there is nothing to show, so do not open an empty menu
  const empty = !canEdit && !compare;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
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
  if (empty) return null;
  return createPortal(
    <div
      ref={list}
      className="dmenu"
      role="menu"
      aria-label={t('tree.dates.move.label', { name: menu.name })}
      style={place(menu.x, menu.y, Math.min(90 + (captures.length + 1) * 30, 340))}
      data-testid="move-menu"
      onKeyDown={menuKeys}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      {view === 'compare' && compare && menu.from ? (
        <CompareList
          from={menu.from}
          layers={menu.layerIds}
          ctx={ctx}
          onBack={() => {
            setView('menu');
          }}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="dmenu-h faint">
            {canEdit ? `${t('tree.dates.move.title')} · ${menu.name}` : menu.name}
          </div>
          {compare && (
            <button
              type="button"
              role="menuitem"
              className="dmenu-item"
              data-testid="move-compare"
              onClick={() => {
                setView('compare');
              }}
            >
              <Icon name="split" size={14} />
              <span>{t('tree.dates.move.compare')}</span>
            </button>
          )}
          {canEdit && (
            <>
              {compare && <div className="dmenu-sep" role="separator" />}
              <div className="dmenu-h faint">{t('tree.dates.move.fileUnder')}</div>
              <div className="dmenu-scroll">
                {row(every, null, t('tree.dates.move.none'), <span className="sw none" />)}
                {newestFirst.map((c) =>
                  row(
                    c.id,
                    c.id,
                    dateLabel(c),
                    <span
                      className="sw"
                      style={{ '--sw': tags[c.id]?.colour ?? 'var(--fg-3)' } as CSSProperties}
                    />,
                  ),
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
