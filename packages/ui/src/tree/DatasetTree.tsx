import { Fragment, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import {
  eyeTarget,
  groupLayerIds,
  visibilityOf,
  type TreeGroup,
  type TreeGroupKind,
  type TreeItem,
  type Visibility,
} from './model';
import type { MarkMods } from './marks';

export interface DatasetTreeProps {
  groups: readonly TreeGroup[];
  hidden: Readonly<Record<string, true>>;
  selectedId: string | null;
  activeClip: string | null;
  /** Icon rail mode: groups show as icons with tooltips. */
  collapsed: boolean;
  onToggleVisible: (layerId: string, visible: boolean) => void;
  /**
   * Show or hide many layers at once (one store update). With it, every group header gets an eye
   * over its layers.
   */
  onSetVisible?: ((layerIds: string[], visible: boolean) => void) | undefined;
  onSelect: (item: TreeItem) => void;
  /** Called when a group is activated in rail mode (expand the sidebar and open the group). */
  onRailGroup?: (kind: TreeGroupKind) => void;
  /**
   * The eye on a flight row shows and hides that flight's path in 3D (its clips keep their own
   * eyes). Without it the flight eye hides every clip of the flight.
   */
  flightPath?:
    { shown: (flightId: string) => boolean; onToggle: (flightId: string) => void } | undefined;
  /** A settings button on point cloud rows (colour, size, budget, EDL). */
  onLayerSettings?: ((item: TreeItem) => void) | undefined;
  /**
   * A settings button on the plan rows of drawings (opacity, on top, place, side by side). The
   * caller shows the controls through `rowExtra`.
   */
  onDrawingSettings?: ((item: TreeItem) => void) | undefined;
  /** A block drawn under a row (the drawing controls of the row that has them open). */
  rowExtra?: ((item: TreeItem) => ReactNode) | undefined;
  /** One action on a group header (Add drawing on Drawings); none for a header without one. */
  groupAction?:
    ((group: TreeGroup) => { label: string; onClick: () => void } | undefined) | undefined;
  /** Groups open at first; defaults to models, maps, drawings, video and annotations. */
  defaultOpen?: readonly TreeGroupKind[] | undefined;
  /** Rendered inside a date folder: the root is a group, not a second tree. */
  nested?: boolean | undefined;
  /**
   * Rows that can be dragged (onto a survey date folder): the layers a row carries, none for a
   * row that stays put. With `onDragItem`, which hears the layers when a drag starts and null when
   * it ends.
   */
  dragIds?: ((item: TreeItem) => string[]) | undefined;
  onDragItem?: ((layerIds: string[] | null) => void) | undefined;
  /** Right-click, or the menu key, on a row: where to put its menu. */
  onItemMenu?: ((item: TreeItem, at: MenuPoint) => void) | undefined;
  /**
   * Group headers that can be dragged (onto a survey date folder): the layers a header carries,
   * none for a header that stays put. A drag is reported through `onDragItem`, like a row's.
   */
  dragGroupIds?: ((group: TreeGroup) => string[]) | undefined;
  /** Right-click, or the menu key, on a group header that carries layers. */
  onGroupMenu?: ((group: TreeGroup, layerIds: string[], at: MenuPoint) => void) | undefined;
  /** The one badge a row carries (a walk's placing state), or null for none. */
  rowBadge?: ((item: TreeItem) => TreeRowBadge | null) | undefined;
  /**
   * The actions of a walk row: open it in the 360 video pane, place it, remove it (the caller
   * asks first, in the shared removal dialog). Place and Remove are left out where nothing may
   * change (a package, a reviewer who may only look).
   */
  walkActions?: WalkRowActions | undefined;
  /** Layer ids marked for a group action (Delete). */
  marked?: ReadonlySet<string> | undefined;
  /**
   * Ctrl+click or Shift+click on a layer row, Ctrl+Space or Shift+ArrowUp/Down on a focused one
   * (the arrow marks the row it moves to); without it a modified click selects as before.
   * `order` is the layer rows drawn in the whole tree, top to bottom: rows in a closed group,
   * flight or date folder, or behind "more", are not in it (a Shift range runs over it).
   */
  onMark?: ((layerId: string, mods: MarkMods, order: readonly string[]) => void) | undefined;
}

/**
 * The layer rows drawn under the tree around `row`, top to bottom. The trees are not virtualised,
 * so every row drawn is in the DOM; a virtualised tree must pass its order another way.
 */
function drawnRows(row: HTMLElement): HTMLElement[] {
  const tree = row.closest('[role="tree"]') ?? row.parentElement;
  if (!tree) return [];
  return [...tree.querySelectorAll<HTMLElement>('[data-mark]')].filter((el) => el.dataset.mark);
}
const drawnOrder = (row: HTMLElement) => drawnRows(row).map((el) => el.dataset.mark ?? '');

/** A short state word on a row: `info` for a step still to take, `warn` for something to check. */
export interface TreeRowBadge {
  text: string;
  tone: 'info' | 'warn';
}

export interface WalkRowActions {
  onOpen: (item: TreeItem) => void;
  onPlace?: ((item: TreeItem) => void) | undefined;
  onRemove?: ((item: TreeItem) => void) | undefined;
}

/** Where a context menu opens, in window pixels. */
export interface MenuPoint {
  x: number;
  y: number;
}

/**
 * Where the menu of a `contextmenu` event goes: the pointer, or (the menu key and Shift+F10 give
 * no pointer) just inside the row.
 */
export function menuPoint(e: MouseEvent<HTMLElement>): MenuPoint {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left + 24, y: r.bottom };
}

// 360 walks are open so a walk's "Needs placing" badge is seen without a click
const DEFAULT_OPEN: TreeGroupKind[] = [
  'models',
  'maps',
  'drawings',
  'video',
  'walks',
  'annotations',
];
/** Rows shown per group before a "more" row; selected and active rows always show. */
const ROW_LIMIT = 8;

const EYE_ICON = { all: 'eye', none: 'eye-off', mixed: 'eye-mixed' } as const;

/**
 * An eye over many layers: open when all show, crossed when none do, half-filled when some do.
 * A click hides them all when all show, else shows them all.
 */
export function VisibilityEye({
  layerIds,
  hidden,
  onSet,
  labels,
  className,
}: {
  layerIds: readonly string[];
  hidden: Readonly<Record<string, true>>;
  onSet: (layerIds: string[], visible: boolean) => void;
  /** Accessible names for the click in each state (hide all; show all; show all from mixed). */
  labels: Record<Visibility, string>;
  className?: string;
}) {
  if (layerIds.length === 0) return null;
  const v = visibilityOf(layerIds, hidden);
  return (
    <button
      type="button"
      className={`eye${v === 'all' ? '' : v === 'none' ? ' off' : ' mixed'}${className ? ` ${className}` : ''}`}
      aria-label={labels[v]}
      aria-pressed={v === 'all' ? true : v === 'none' ? false : 'mixed'}
      title={labels[v]}
      data-visibility={v}
      onClick={(e) => {
        e.stopPropagation();
        onSet([...layerIds], eyeTarget(v));
      }}
    >
      <Icon name={EYE_ICON[v]} size={14} />
    </button>
  );
}

/** Datasets of the open project grouped by kind, with counts, visibility and selection. */
export function DatasetTree(props: DatasetTreeProps) {
  const { groups, hidden, selectedId, activeClip, collapsed } = props;
  const t = useT();
  const [open, setOpen] = useState<Partial<Record<TreeGroupKind, boolean>>>({});
  const isOpen = (k: TreeGroupKind) => open[k] ?? (props.defaultOpen ?? DEFAULT_OPEN).includes(k);
  const [showAll, setShowAll] = useState<Partial<Record<TreeGroupKind, boolean>>>({});
  /** Flight rows the user opened or closed; others open while they hold the active clip. */
  const [flightOpen, setFlightOpen] = useState<Record<string, boolean>>({});
  /**
   * Open, Place walk and Remove walk on a walk row; they stand in for the length and badge on
   * hover. Remove only hands the row over: the caller asks in the shared removal dialog.
   */
  const walkButtons = (it: TreeItem) => {
    const acts = it.layerKind === 'walk' ? props.walkActions : undefined;
    if (!acts) return null;
    const button = (
      kind: 'open' | 'place' | 'remove',
      icon: 'split' | 'pin' | 'trash',
      label: string,
      tip: string,
      run: () => void,
    ) => (
      <button
        type="button"
        className={`eye tact${kind === 'remove' ? ' tact-remove' : ''}`}
        aria-label={label}
        title={tip}
        data-testid={`walk-${kind}-${it.id}`}
        // Enter and Space press this button, not the row around it
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          run();
        }}
      >
        <Icon name={icon} size={14} />
      </button>
    );
    const { onPlace, onRemove } = acts;
    return (
      <span className="tacts">
        {button('open', 'split', t('walk.open', { name: it.name }), t('walk.row.open'), () => {
          acts.onOpen(it);
        })}
        {onPlace &&
          button(
            'place',
            'pin',
            t('walk.row.place', { name: it.name }),
            t('walk.row.placeTip'),
            () => {
              onPlace(it);
            },
          )}
        {onRemove &&
          button(
            'remove',
            'trash',
            t('walk.row.remove', { name: it.name }),
            t('walk.row.removeTip'),
            () => {
              onRemove(it);
            },
          )}
      </span>
    );
  };

  /** Drag and menu wiring of a row; nothing when the tree is not editable. */
  const moving = (it: TreeItem) => {
    const ids = props.onDragItem ? (props.dragIds?.(it) ?? []) : [];
    const menu = props.onItemMenu;
    return {
      ...(ids.length > 0
        ? {
            draggable: true,
            onDragStart: (e: DragEvent<HTMLElement>) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', it.name);
              props.onDragItem?.(ids);
            },
            onDragEnd: () => {
              props.onDragItem?.(null);
            },
          }
        : {}),
      ...(menu
        ? {
            onContextMenu: (e: MouseEvent<HTMLElement>) => {
              e.preventDefault();
              e.stopPropagation();
              menu(it, menuPoint(e));
            },
          }
        : {}),
    };
  };

  const row = (it: TreeItem, sub: boolean) => {
    const off = it.layerId ? hidden[it.layerId] === true : false;
    const sel = it.id === selectedId;
    const marked = it.layerId !== undefined && props.marked?.has(it.layerId) === true;
    const extra = props.rowExtra?.(it) ?? null;
    const badge = props.rowBadge?.(it) ?? null;
    const walkActs = walkButtons(it);
    const drawingSettings = it.drawing === true ? props.onDrawingSettings : undefined;
    const line = (
      <div
        key={it.id}
        role="treeitem"
        aria-selected={sel || marked}
        // the badge hides behind the row actions on hover and focus; the name still carries it
        aria-label={badge ? [it.name, it.meta, badge.text].filter(Boolean).join(', ') : undefined}
        tabIndex={0}
        className={`titem${sub ? ' sub' : ''}${sel ? ' sel' : ''}${marked ? ' marked' : ''}${off ? ' hidden' : ''}${walkActs ? ' has-acts' : ''}`}
        title={it.name}
        data-testid={it.layerId ? `tree-row-${it.layerId}` : undefined}
        data-mark={props.onMark ? it.layerId : undefined}
        {...moving(it)}
        onClick={(e) => {
          const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
          if ((mods.ctrl || mods.shift) && props.onMark && it.layerId) {
            e.preventDefault();
            props.onMark(it.layerId, mods, drawnOrder(e.currentTarget));
            return;
          }
          props.onSelect(it);
        }}
        onKeyDown={(e) => {
          // keys on a button inside the row are the button's
          if (e.target !== e.currentTarget) return;
          const onMark = props.onMark;
          const id = it.layerId;
          if (onMark && id !== undefined && e.key === ' ' && (e.ctrlKey || e.metaKey)) {
            // Ctrl+Space (Meta+Space on a Mac) toggles this row's mark
            e.preventDefault();
            onMark(id, { ctrl: true, shift: false }, drawnOrder(e.currentTarget));
            return;
          }
          if (
            onMark &&
            id !== undefined &&
            e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            (e.key === 'ArrowDown' || e.key === 'ArrowUp')
          ) {
            // Shift+ArrowUp/Down moves to the next drawn row and marks the range up to it
            e.preventDefault();
            const drawn = drawnRows(e.currentTarget);
            const at = drawn.indexOf(e.currentTarget);
            const to = at < 0 ? undefined : drawn[at + (e.key === 'ArrowDown' ? 1 : -1)];
            const toId = to?.dataset.mark;
            if (!to || toId === undefined) return;
            to.focus();
            onMark(
              toId,
              { ctrl: false, shift: true, from: id },
              drawn.map((el) => el.dataset.mark ?? ''),
            );
            return;
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onSelect(it);
          }
        }}
      >
        {it.layerId === activeClip && it.layerKind === 'video' && (
          <span className="live" title="Active clip" />
        )}
        <span className="tn">{it.name}</span>
        {it.meta && <span className="tm">{it.meta}</span>}
        {badge && (
          <span
            className={`tbadge ${badge.tone}`}
            data-testid={it.layerId ? `tree-badge-${it.layerId}` : undefined}
          >
            {badge.text}
          </span>
        )}
        {walkActs}
        {it.layerKind === 'pointcloud' && props.onLayerSettings && (
          <button
            type="button"
            className="eye tact"
            aria-label={`Point cloud colour and display: ${it.name}`}
            title="Colour by RGB, elevation, intensity or flight; size and budget"
            onClick={(e) => {
              e.stopPropagation();
              props.onLayerSettings?.(it);
            }}
          >
            <Icon name="settings" size={14} />
          </button>
        )}
        {drawingSettings && (
          <button
            type="button"
            className="eye tact"
            aria-label={`Drawing display and placement: ${it.name}`}
            aria-expanded={extra !== null}
            title="Opacity, on top, place on the site, open side by side"
            data-testid={`drawing-settings-${it.id}`}
            onClick={(e) => {
              e.stopPropagation();
              drawingSettings(it);
            }}
          >
            <Icon name="settings" size={14} />
          </button>
        )}
        {it.layerId ? (
          <button
            type="button"
            className={`eye${off ? ' off' : ''}`}
            aria-label={`${off ? 'Show' : 'Hide'} ${it.name}`}
            aria-pressed={!off}
            title={off ? 'Show' : 'Hide'}
            onClick={(e) => {
              e.stopPropagation();
              if (it.layerId) props.onToggleVisible(it.layerId, off);
            }}
          >
            <Icon name={off ? 'eye-off' : 'eye'} size={14} />
          </button>
        ) : (
          <span className="eye-sp" />
        )}
      </div>
    );
    if (extra === null) return line;
    return (
      <Fragment key={it.id}>
        {line}
        <div className="titem-extra" role="none">
          {extra}
        </div>
      </Fragment>
    );
  };

  const flightRow = (it: TreeItem, children: TreeItem[]) => {
    const live = children.some((c) => c.layerId === activeClip);
    const open = flightOpen[it.id] ?? (live || children.some((c) => c.id === selectedId));
    const ids = children.flatMap((c) => (c.layerId ? [c.layerId] : []));
    const clipsOff = ids.every((id) => hidden[id] === true);
    const path = props.flightPath && it.flightId !== undefined ? props.flightPath : null;
    const pathOff = path && it.flightId !== undefined ? !path.shown(it.flightId) : false;
    const off = path ? pathOff : clipsOff;
    const eyeLabel = path
      ? `${off ? 'Show' : 'Hide'} the flight path of ${it.name}`
      : `${off ? 'Show' : 'Hide'} ${it.name}`;
    return (
      <div key={it.id} role="treeitem" aria-expanded={open} aria-selected={false}>
        <div
          tabIndex={0}
          className={`titem flight${clipsOff ? ' hidden' : ''}`}
          title={it.name}
          {...moving(it)}
          onClick={() => {
            setFlightOpen((o) => ({ ...o, [it.id]: !open }));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setFlightOpen((o) => ({ ...o, [it.id]: !open }));
            }
          }}
        >
          <Icon name="chev-r" size={12} className={`chev${open ? ' open' : ''}`} />
          {live && <span className="live" title="Holds the active clip" />}
          <span className="tn">{it.name}</span>
          {it.meta && <span className="tm">{it.meta}</span>}
          <button
            type="button"
            className={`eye${off ? ' off' : ''}`}
            aria-label={eyeLabel}
            aria-pressed={!off}
            title={path ? `${off ? 'Show' : 'Hide'} this flight path in 3D` : off ? 'Show' : 'Hide'}
            onClick={(e) => {
              e.stopPropagation();
              if (path && it.flightId !== undefined) path.onToggle(it.flightId);
              else for (const id of ids) props.onToggleVisible(id, off);
            }}
          >
            <Icon name={off ? 'eye-off' : 'eye'} size={14} />
          </button>
        </div>
        {open && (
          <div role="group" className="titems-sub">
            {children.map((c) => row(c, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={props.nested ? 'tree tree-nested' : 'tree'}
      role={props.nested ? 'group' : 'tree'}
      aria-label={props.nested ? undefined : 'Datasets'}
      aria-multiselectable={!props.nested && props.onMark ? true : undefined}
    >
      {groups.map((g) => {
        const expanded = !collapsed && isOpen(g.kind);
        const all = showAll[g.kind] === true || g.items.length <= ROW_LIMIT + 1;
        const rows = all
          ? g.items
          : g.items.filter(
              (it, i) =>
                i < ROW_LIMIT ||
                it.id === selectedId ||
                it.layerId === activeClip ||
                it.children?.some((c) => c.layerId === activeClip || c.id === selectedId),
            );
        const hiddenRows = g.items.length - rows.length;
        // a header carries its whole group, the rows behind "more" too; never in rail mode
        const carried = collapsed ? [] : (props.dragGroupIds?.(g) ?? []);
        const groupMenu = carried.length > 0 ? props.onGroupMenu : undefined;
        const groupDrag = carried.length > 0 && props.onDragItem !== undefined;
        const action = collapsed ? undefined : props.groupAction?.(g);
        return (
          <div key={g.kind} role="treeitem" aria-expanded={expanded} aria-selected={false}>
            <div
              className="tgroup-row"
              data-testid={`tree-group-${g.kind}`}
              {...(groupDrag
                ? {
                    draggable: true,
                    onDragStart: (e: DragEvent<HTMLElement>) => {
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', g.label);
                      props.onDragItem?.(carried);
                    },
                    onDragEnd: () => {
                      props.onDragItem?.(null);
                    },
                  }
                : {})}
              {...(groupMenu
                ? {
                    onContextMenu: (e: MouseEvent<HTMLElement>) => {
                      e.preventDefault();
                      e.stopPropagation();
                      groupMenu(g, carried, menuPoint(e));
                    },
                  }
                : {})}
            >
              <button
                type="button"
                className="tgroup-btn"
                aria-expanded={expanded}
                data-testid={`tree-group-toggle-${g.kind}`}
                onClick={() => {
                  if (collapsed) {
                    setOpen((o) => ({ ...o, [g.kind]: true }));
                    props.onRailGroup?.(g.kind);
                  } else setOpen((o) => ({ ...o, [g.kind]: !isOpen(g.kind) }));
                }}
              >
                <Icon name="chev-r" size={12} className="chev" />
                <Icon name={g.icon} />
                <span className="glbl">{g.label}</span>
                <span className="gcount">{g.count}</span>
                <span className="tip">
                  {g.label} · {g.count}
                </span>
              </button>
              {action && (
                <button
                  type="button"
                  className="eye tgroup-act"
                  aria-label={action.label}
                  title={action.label}
                  data-testid={`tree-group-add-${g.kind}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    action.onClick();
                  }}
                >
                  <Icon name="plus" size={14} />
                </button>
              )}
              {props.onSetVisible && !collapsed && (
                <VisibilityEye
                  layerIds={groupLayerIds(g)}
                  hidden={hidden}
                  onSet={props.onSetVisible}
                  labels={{
                    all: t('tree.eye.hideGroup', { group: g.label }),
                    none: t('tree.eye.showGroup', { group: g.label }),
                    mixed: t('tree.eye.showGroupMixed', { group: g.label }),
                  }}
                />
              )}
            </div>
            {expanded && (
              <div className="titems" role="group">
                {rows.map((it) => (it.children ? flightRow(it, it.children) : row(it, false)))}
                {(hiddenRows > 0 || (showAll[g.kind] && g.items.length > ROW_LIMIT + 1)) && (
                  <button
                    type="button"
                    className="titem more"
                    onClick={() => {
                      setShowAll((s) => ({ ...s, [g.kind]: !s[g.kind] }));
                    }}
                  >
                    <span className="tn">
                      {hiddenRows > 0 ? `${String(hiddenRows)} more` : 'Show fewer'}
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
