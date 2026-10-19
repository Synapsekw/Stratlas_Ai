import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { announce } from '../announce';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { Tip } from '../Tip';
import {
  eyeTarget,
  folderMeasureIds,
  groupLayerIds,
  groupMeasureIds,
  itemMeasureIds,
  measureMark,
  visibilityOf,
  type TreeGroup,
  type TreeGroupKind,
  type TreeItem,
  type Visibility,
} from './model';
import type { MarkMods } from './marks';
import { RenameField } from './RenameField';

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
  onGroupMenu?:
    ((group: TreeGroup, layerIds: string[], at: MenuPoint, fold: GroupFold) => void) | undefined;
  /** The layer whose name is a field now, and its F2, save and close. */
  renamingLayer?: string | null | undefined;
  onRenameLayerStart?: ((layerId: string) => void) | undefined;
  onRenameLayer?: ((layerId: string, name: string) => void) | undefined;
  onRenameLayerEnd?: (() => void) | undefined;
  /**
   * Ask the confirm of Remove placement on a walk row (a menu item does): a new `seq` opens it
   * for `id`.
   */
  unplaceRequest?: { id: string; seq: number } | null | undefined;
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
  /**
   * The rows of the Measurements group: their eyes, selection, menu, rename, folders. Marks go
   * through `onMark` as `measureMark(id)`, so a Shift range runs over layers and measurements.
   */
  measures?: MeasureTreeProps | undefined;
}

/** What the tree needs to draw the Measurements group (measurement rows and their folders). */
export interface MeasureTreeProps {
  /** Ids hidden by their own eye (measureStore.hiddenMeasurements as a record). */
  hidden: Readonly<Record<string, true>>;
  /** measureStore.focus, drawn selected. */
  selectedId: string | null;
  onSetVisible: (ids: string[], visible: boolean) => void;
  onSelect: (id: string) => void;
  onMenu: (id: string, at: MenuPoint) => void;
  /** The measurement whose name is a field now; F2 starts it (undefined: read-only). */
  renaming: string | null;
  onRenameStart?: ((id: string) => void) | undefined;
  onRename: (id: string, label: string) => void;
  onRenameEnd: () => void;
  /** A new folder row in rename mode at the top of the group; onNewFolder(null) on cancel. */
  newFolder: { ids: readonly string[]; seq: number } | null;
  onNewFolder: (name: string | null) => void;
  /** Open the group (and the folder holding `id`), show the row past "more", scroll it into view. */
  reveal: { id: string | null; seq: number } | null;
  /**
   * The filter box at the top of the open group (no box without `onQuery`). The caller builds
   * the group's rows from it (`measurementsGroup` with every id): under a filter the folders show
   * open and every match shows, past "more".
   */
  query?: string | undefined;
  onQuery?: ((query: string) => void) | undefined;
}

/** Measurement labels and folder names take up to 200 characters. */
const MEASURE_NAME_MAX = 200;

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
  /** The walk has a saved placement: Place walk becomes Edit placement and Remove placement shows. */
  placed?: ((item: TreeItem) => boolean) | undefined;
  onRemovePlacement?: ((item: TreeItem) => void) | undefined;
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
  return keyMenuPoint(e.currentTarget);
}

/** Shift+F10 and the Menu key: open the focused element's menu. */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return (e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu';
}

/**
 * A row with no menu of its own (the Measurements heading, a measurement folder): the right-click
 * and the menu keys stop there, so the tree's empty-space Project menu does not open over it.
 */
const noMenu = {
  onContextMenu: (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
  },
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
    if (!isMenuKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
  },
};

/** Where a menu opened from the keyboard goes: just inside the element, under it. */
export function keyMenuPoint(el: HTMLElement): MenuPoint {
  const r = el.getBoundingClientRect();
  return { x: r.left + 24, y: r.bottom };
}

/** A group's fold state, handed to its menu so Expand and Collapse can act on it. */
export interface GroupFold {
  expanded: boolean;
  toggle: () => void;
}

// 360 walks are open so a walk's "Needs placing" badge is seen without a click, and panoramas so
// an import's stitch status shows
const DEFAULT_OPEN: TreeGroupKind[] = [
  'models',
  'maps',
  'drawings',
  'video',
  'walks',
  'panoramas',
  'annotations',
];
/** Rows shown per group before a "more" row; selected and active rows always show. */
const ROW_LIMIT = 8;

/** The rows drawn of a list capped at `ROW_LIMIT`, and how many wait behind "more". */
function capRows(
  items: readonly TreeItem[],
  all: boolean,
  keep: (it: TreeItem) => boolean,
): { rows: readonly TreeItem[]; behind: number } {
  if (all || items.length <= ROW_LIMIT + 1) return { rows: items, behind: 0 };
  const rows = items.filter((it, i) => i < ROW_LIMIT || keep(it));
  return { rows, behind: items.length - rows.length };
}

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
   * The walk row whose Remove placement waits for its confirm, shown under the row. Remove walk
   * goes to the caller's shared removal dialog, but Remove placement deletes nothing (the walk and
   * its files stay), so it asks in the row.
   */
  const [unplacing, setUnplacing] = useState<string | null>(null);
  // a menu item asks for the confirm: adjusted during render, not in an effect
  const [seenUnplace, setSeenUnplace] = useState(props.unplaceRequest?.seq ?? 0);
  if (props.unplaceRequest && props.unplaceRequest.seq !== seenUnplace) {
    setSeenUnplace(props.unplaceRequest.seq);
    setUnplacing(props.unplaceRequest.id);
  }
  /** The rows drawn now, by item id: where focus goes back to when the confirm closes. */
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  /** The row focus goes back to once the confirm has left the page (its buttons held focus till then). */
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    rowEls.current.get(id)?.focus();
  });

  const measures = props.measures;
  // how many the filter matches is said through the app's live region, which is always mounted
  // (a status line added together with its text is often not read)
  const measureGroup = measures ? groups.find((g) => g.kind === 'measurements') : undefined;
  const matched = measureGroup?.matched;
  const matchTotal = measureGroup?.count ?? 0;
  useEffect(() => {
    if (matched === undefined) return;
    announce(
      matched === 0
        ? t('tree.measure.filterNone')
        : t('tree.measure.filterMatches', { shown: matched, total: matchTotal }),
    );
  }, [matched, matchTotal, t]);
  /** Measurement folders opened or closed by hand (open by default), and those showing every row. */
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>({});
  const [folderAll, setFolderAll] = useState<Record<string, boolean>>({});
  /**
   * The measurement a reveal asked for: it shows past "more" from then on. Adjusted during render
   * on a new `seq`, as the unplace request is: open the group and the folder that holds it.
   */
  const [revealed, setRevealed] = useState<string | null>(null);
  const [seenReveal, setSeenReveal] = useState(measures?.reveal?.seq ?? 0);
  if (measures?.reveal && measures.reveal.seq !== seenReveal) {
    const { id, seq } = measures.reveal;
    setSeenReveal(seq);
    setRevealed(id);
    setOpen((o) => ({ ...o, measurements: true }));
    const holder =
      id === null
        ? undefined
        : groups
            .find((g) => g.kind === 'measurements')
            ?.items.find((it) => it.folder !== undefined && itemMeasureIds(it).includes(id));
    const name = holder?.folder;
    if (name !== undefined) {
      setFolderOpen((o) => ({ ...o, [name]: true }));
      setFolderAll((o) => ({ ...o, [name]: true }));
    }
  }
  /** The reveal last scrolled to; a later one scrolls once its row (or the group) is drawn. */
  const scrolledReveal = useRef(seenReveal);
  const measureHead = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (scrolledReveal.current === seenReveal || collapsed) return;
    const el = revealed === null ? measureHead.current : rowEls.current.get(measureMark(revealed));
    if (!el) return;
    scrolledReveal.current = seenReveal;
    // jsdom has no scrollIntoView
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  });
  /** The new folder request whose field has closed (the caller clears the request after). */
  const [newFolderDone, setNewFolderDone] = useState<number | null>(null);
  const [seenNewFolder, setSeenNewFolder] = useState<number | null>(null);
  const newFolderSeq = measures?.newFolder?.seq ?? null;
  if (newFolderSeq !== null && newFolderSeq !== seenNewFolder) {
    setSeenNewFolder(newFolderSeq);
    setOpen((o) => ({ ...o, measurements: true }));
  }

  /**
   * Ctrl+Space (Meta+Space on a Mac) toggles the focused row's mark; Shift+ArrowUp/Down moves to
   * the next drawn row and marks the range up to it. True when the key was a mark key.
   */
  const markKey = (e: KeyboardEvent<HTMLElement>, id: string): boolean => {
    const onMark = props.onMark;
    if (!onMark) return false;
    if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onMark(id, { ctrl: true, shift: false }, drawnOrder(e.currentTarget));
      return true;
    }
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const drawn = drawnRows(e.currentTarget);
      const at = drawn.indexOf(e.currentTarget);
      const to = at < 0 ? undefined : drawn[at + (e.key === 'ArrowDown' ? 1 : -1)];
      const toId = to?.dataset.mark;
      if (!to || toId === undefined) return true;
      to.focus();
      onMark(
        toId,
        { ctrl: false, shift: true, from: id },
        drawn.map((el) => el.dataset.mark ?? ''),
      );
      return true;
    }
    return false;
  };

  /** A "more" row under capped rows, and "Show fewer" once they all show. */
  const moreRow = (behind: number, showingAll: boolean, count: number, toggle: () => void) =>
    behind > 0 || (showingAll && count > ROW_LIMIT + 1) ? (
      <button type="button" className="titem more" onClick={toggle}>
        <span className="tn">
          {behind > 0 ? t('tree.row.more', { count: behind }) : t('tree.row.fewer')}
        </span>
      </button>
    ) : null;

  /**
   * Open, Place walk (Edit placement and Remove placement once placed) and Remove walk on a walk
   * row; they stand in for the length and badge on hover. Remove only hands the row over: the
   * caller asks in the shared removal dialog.
   */
  const walkButtons = (it: TreeItem) => {
    const acts = it.layerKind === 'walk' ? props.walkActions : undefined;
    if (!acts) return null;
    const button = (
      kind: 'open' | 'place' | 'edit' | 'unplace' | 'remove',
      icon: 'split' | 'pin' | 'x' | 'trash',
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
    const { onPlace, onRemove, onRemovePlacement } = acts;
    const isPlaced = acts.placed?.(it) === true;
    return (
      <span className="tacts">
        {button('open', 'split', t('walk.open', { name: it.name }), t('walk.row.open'), () => {
          acts.onOpen(it);
        })}
        {onPlace &&
          button(
            isPlaced ? 'edit' : 'place',
            'pin',
            t(isPlaced ? 'walk.row.edit' : 'walk.row.place', { name: it.name }),
            t(isPlaced ? 'walk.row.editTip' : 'walk.row.placeTip'),
            () => {
              onPlace(it);
            },
          )}
        {isPlaced &&
          onRemovePlacement &&
          button(
            'unplace',
            'x',
            t('walk.row.unplace', { name: it.name }),
            t('walk.row.unplaceTip'),
            () => {
              setUnplacing(it.id);
            },
          )}
        {onRemove &&
          button(
            'remove',
            'trash',
            t('walk.row.remove', { name: it.name }),
            t('walk.row.removeTip'),
            () => {
              setUnplacing(null);
              onRemove(it);
            },
          )}
      </span>
    );
  };

  /** The inline question of Remove placement: the walk itself stays, so the yes button is calm. */
  const unplaceConfirm = (it: TreeItem) => {
    const onRemovePlacement =
      it.layerKind === 'walk' ? props.walkActions?.onRemovePlacement : undefined;
    if (!onRemovePlacement || unplacing !== it.id) return null;
    const close = () => {
      setUnplacing(null);
      pendingFocus.current = it.id;
    };
    return (
      <div className="trow-confirm" role="group" data-testid="walk-unplace-confirm">
        <span className="trow-confirm-q">{t('walk.row.unplaceConfirm', { name: it.name })}</span>
        <span className="trow-confirm-acts">
          <button
            type="button"
            className="btn sm"
            data-testid="walk-unplace-yes"
            onClick={() => {
              setUnplacing(null);
              onRemovePlacement(it);
              pendingFocus.current = it.id;
            }}
          >
            {t('walk.row.unplaceYes')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            data-testid="walk-unplace-cancel"
            autoFocus
            onClick={close}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
            }}
          >
            {t('walk.row.unplaceNo')}
          </button>
        </span>
      </div>
    );
  };

  /** Drag and menu wiring of a row; nothing when the tree is not editable. */
  const moving = (it: TreeItem) => {
    // a row being renamed is not draggable: the field takes the pointer
    const renaming = it.layerId !== undefined && props.renamingLayer === it.layerId;
    const ids = props.onDragItem && !renaming ? (props.dragIds?.(it) ?? []) : [];
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
    const extra = unplaceConfirm(it) ?? props.rowExtra?.(it) ?? null;
    const badge = props.rowBadge?.(it) ?? null;
    const walkActs = walkButtons(it);
    const renamingHere = it.layerId !== undefined && props.renamingLayer === it.layerId;
    const drawingSettings = it.drawing === true ? props.onDrawingSettings : undefined;
    const line = (
      <div
        key={it.id}
        role="treeitem"
        aria-selected={sel || marked}
        // the badge hides behind the row actions on hover and focus; the name still carries it
        aria-label={badge ? [it.name, it.meta, badge.text].filter(Boolean).join(', ') : undefined}
        ref={(el) => {
          if (el) rowEls.current.set(it.id, el);
          else rowEls.current.delete(it.id);
        }}
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
          if (isMenuKey(e) && props.onItemMenu) {
            e.preventDefault();
            e.stopPropagation();
            props.onItemMenu(it, keyMenuPoint(e.currentTarget));
            return;
          }
          if (e.key === 'F2' && it.layerId && props.onRenameLayerStart) {
            e.preventDefault();
            props.onRenameLayerStart(it.layerId);
            return;
          }
          if (it.layerId !== undefined && markKey(e, it.layerId)) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onSelect(it);
          }
        }}
      >
        {it.layerId === activeClip && it.layerKind === 'video' && (
          <span className="live" title="Active clip" />
        )}
        {renamingHere ? (
          <RenameField
            testId="layer-rename"
            initial={it.name}
            label={t('tree.renameLayer', { name: it.name })}
            placeholder={it.name}
            onCommit={(n) => {
              props.onRenameLayer?.(it.layerId ?? '', n);
            }}
            onEnd={(how) => {
              props.onRenameLayerEnd?.();
              if (how !== 'blur') pendingFocus.current = it.id;
            }}
          />
        ) : (
          <span className="tn">{it.name}</span>
        )}
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
            aria-label={t('tree.row.cloud', { name: it.name })}
            title={t('tree.row.cloudTip')}
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
            aria-label={t('tree.row.drawing', { name: it.name })}
            aria-expanded={extra !== null}
            title={t('tree.row.drawingTip')}
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
            aria-label={t(off ? 'tree.row.show' : 'tree.row.hide', { name: it.name })}
            aria-pressed={!off}
            title={t(off ? 'tree.row.showTip' : 'tree.row.hideTip')}
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
            if (e.target !== e.currentTarget) return;
            if (isMenuKey(e) && props.onItemMenu) {
              e.preventDefault();
              e.stopPropagation();
              props.onItemMenu(it, keyMenuPoint(e.currentTarget));
              return;
            }
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

  /** A measurement row: swatch, label (or its name field), value and its own eye. */
  const measureRow = (it: TreeItem, mp: MeasureTreeProps, sub: boolean) => {
    const ms = it.measure;
    if (!ms) return null;
    const off = mp.hidden[ms.id] === true;
    const sel = ms.id === mp.selectedId;
    const mark = measureMark(ms.id);
    const marked = props.marked?.has(mark) === true;
    const renamingHere = mp.renaming === ms.id;
    const line = (
      <div
        key={it.id}
        role="treeitem"
        aria-selected={sel || marked}
        ref={(el) => {
          if (el) rowEls.current.set(it.id, el);
          else rowEls.current.delete(it.id);
        }}
        tabIndex={0}
        className={`titem${sub ? ' sub' : ''}${sel ? ' sel' : ''}${marked ? ' marked' : ''}${off ? ' hidden' : ''}${ms.dimmed ? ' dim' : ''}`}
        data-testid="measure-row"
        data-id={ms.id}
        data-mark={props.onMark ? mark : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          mp.onMenu(ms.id, menuPoint(e));
        }}
        onClick={(e) => {
          const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
          if ((mods.ctrl || mods.shift) && props.onMark) {
            e.preventDefault();
            props.onMark(mark, mods, drawnOrder(e.currentTarget));
            return;
          }
          mp.onSelect(ms.id);
        }}
        onKeyDown={(e) => {
          // keys on the eye or in the name field are theirs
          if (e.target !== e.currentTarget) return;
          if (isMenuKey(e)) {
            e.preventDefault();
            e.stopPropagation();
            mp.onMenu(ms.id, keyMenuPoint(e.currentTarget));
            return;
          }
          if (e.key === 'F2' && mp.onRenameStart) {
            e.preventDefault();
            mp.onRenameStart(ms.id);
            return;
          }
          if (markKey(e, mark)) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            mp.onSelect(ms.id);
          }
        }}
      >
        <span className="tsw" style={{ '--sw': ms.color } as CSSProperties} aria-hidden="true" />
        {renamingHere ? (
          <RenameField
            testId="measure-rename"
            initial={it.name}
            label={t('tree.renameLayer', { name: it.name })}
            placeholder={it.name}
            maxLength={MEASURE_NAME_MAX}
            onCommit={(n) => {
              mp.onRename(ms.id, n);
            }}
            onEnd={(how) => {
              mp.onRenameEnd();
              if (how !== 'blur') pendingFocus.current = it.id;
            }}
          />
        ) : (
          <span className="tn">{it.name}</span>
        )}
        {it.meta && <span className="tm">{it.meta}</span>}
        <button
          type="button"
          className={`eye${off ? ' off' : ''}`}
          aria-label={t(off ? 'tree.row.show' : 'tree.row.hide', { name: it.name })}
          aria-pressed={!off}
          data-testid="measure-row-eye"
          onClick={(e) => {
            e.stopPropagation();
            mp.onSetVisible([ms.id], off);
          }}
        >
          <Icon name={off ? 'eye-off' : 'eye'} size={14} />
        </button>
      </div>
    );
    // The app's tip, not a native title: the full name, or for a dimmed row why it is dimmed (its
    // survey date is hidden; its own eye stays as it was). Always wrapped, so dimming never
    // remounts the row under keyboard focus.
    const why = ms.dimmed ? ms.dimmedWhy : undefined;
    return (
      <Tip key={it.id} content={why ?? it.name} repeatsName={why === undefined}>
        {line}
      </Tip>
    );
  };

  /** The selected, renaming and revealed measurement rows show past "more". */
  const keepMeasure = (mp: MeasureTreeProps) => (it: TreeItem) => {
    const id = it.measure?.id;
    return id !== undefined && (id === mp.selectedId || id === mp.renaming || id === revealed);
  };

  /** A folder of measurements: opens and closes (open at first), with an eye over its rows. */
  const measureFolderRow = (
    it: TreeItem,
    name: string,
    mp: MeasureTreeProps,
    filtering: boolean,
  ) => {
    const ids = itemMeasureIds(it);
    // under a filter the eye still acts on the whole folder, the rows it hides too
    const eyeIds = folderMeasureIds(it);
    // a folder holding matches shows them, though it was folded by hand
    const open = filtering || (folderOpen[name] ?? true);
    const allOff = eyeIds.length > 0 && eyeIds.every((id) => mp.hidden[id] === true);
    const kids = it.children ?? [];
    const showingAll = filtering || folderAll[name] === true;
    const { rows, behind } = capRows(kids, showingAll, keepMeasure(mp));
    // under a filter a folder holding matches stays open: folding it there would only fold it
    // for later, once the filter is cleared
    const toggle = () => {
      if (!filtering) setFolderOpen((o) => ({ ...o, [name]: !open }));
    };
    return (
      <div key={it.id} role="treeitem" aria-expanded={open} aria-selected={false}>
        <div
          tabIndex={0}
          className={`titem flight${allOff ? ' hidden' : ''}`}
          data-testid="measure-folder"
          data-folder={name}
          onClick={toggle}
          onContextMenu={noMenu.onContextMenu}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (isMenuKey(e)) {
              noMenu.onKeyDown(e);
              return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          }}
        >
          {/* the fold: under a filter it does nothing, and says so */}
          <span
            className="tfold"
            data-testid="measure-folder-fold"
            aria-disabled={filtering || undefined}
          >
            <Icon
              name="chev-r"
              size={12}
              className={`chev${open ? ' open' : ''}${filtering ? ' chev-off' : ''}`}
            />
          </span>
          <Icon name="folder" size={14} />
          <span className="tn">{name}</span>
          <span className="tm">
            {filtering
              ? t('tree.measure.filterCount', { shown: ids.length, total: eyeIds.length })
              : t('tree.measure.folderCount', { count: ids.length })}
          </span>
          <VisibilityEye
            layerIds={eyeIds}
            hidden={mp.hidden}
            onSet={mp.onSetVisible}
            labels={{
              all: t('tree.eye.hideGroup', { group: name }),
              none: t('tree.eye.showGroup', { group: name }),
              mixed: t('tree.eye.showGroupMixed', { group: name }),
            }}
          />
        </div>
        {open && (
          <div role="group" className="titems-sub">
            {rows.map((c) => measureRow(c, mp, true))}
            {!filtering &&
              moreRow(behind, showingAll, kids.length, () => {
                setFolderAll((o) => ({ ...o, [name]: !showingAll }));
              })}
          </div>
        )}
      </div>
    );
  };

  /** The name field of a folder being made, at the top of the group; Escape or empty cancels. */
  const newFolderRow = (mp: MeasureTreeProps) => {
    const nf = mp.newFolder;
    if (!nf || nf.seq === newFolderDone) return null;
    let named = false;
    return (
      <div
        key={`measure-folder-new-${String(nf.seq)}`}
        role="treeitem"
        aria-selected={false}
        className="titem flight"
      >
        <Icon name="chev-r" size={12} className="chev" />
        <Icon name="folder" size={14} />
        <RenameField
          testId="measure-folder-new"
          initial=""
          label={t('tree.measure.folderName')}
          placeholder={t('tree.measure.folderName')}
          maxLength={MEASURE_NAME_MAX}
          onCommit={(name) => {
            named = true;
            mp.onNewFolder(name);
          }}
          onEnd={(how) => {
            setNewFolderDone(nf.seq);
            if (!named) mp.onNewFolder(null);
            // focus goes back to the row the folder was asked for
            const first = nf.ids[0];
            if (how !== 'blur' && first !== undefined) pendingFocus.current = measureMark(first);
          }}
        />
      </div>
    );
  };

  /**
   * The filter box at the top of the open Measurements group: the clear button and Escape empty
   * it. Escape on an empty box does nothing here (the tree's own keys leave a field's keys alone).
   */
  const filterBox = (mp: MeasureTreeProps, onQuery: (query: string) => void) => {
    const query = mp.query ?? '';
    return (
      <div className="tfilter">
        <Icon name="search" size={12} className="tfilter-icon" />
        <input
          type="search"
          className="input"
          data-testid="measure-filter"
          aria-label={t('tree.measure.filter')}
          placeholder={t('tree.measure.filter')}
          value={query}
          spellCheck={false}
          onChange={(e) => {
            onQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || query === '') return;
            e.preventDefault();
            e.stopPropagation();
            onQuery('');
          }}
        />
        {query !== '' && (
          <button
            type="button"
            className="tfilter-clear"
            aria-label={t('tree.measure.filterClear')}
            data-testid="measure-filter-clear"
            onClick={() => {
              onQuery('');
            }}
          >
            <Icon name="x" size={12} />
          </button>
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
        // the Measurements group draws its own rows; its folders always show, loose rows are capped
        const mg = g.kind === 'measurements' ? measures : undefined;
        // the group under its filter: every match shows (no "more"), the header counts them
        const filtering = mg !== undefined && g.matched !== undefined;
        const folders = mg ? g.items.filter((it) => it.folder !== undefined) : [];
        const capped = mg ? g.items.filter((it) => it.folder === undefined) : g.items;
        const showingAll = filtering || showAll[g.kind] === true;
        const { rows, behind } = capRows(
          capped,
          showingAll,
          mg
            ? keepMeasure(mg)
            : (it) =>
                it.id === selectedId ||
                it.layerId === activeClip ||
                it.children?.some((c) => c.layerId === activeClip || c.id === selectedId) === true,
        );
        // a header carries its whole group, the rows behind "more" too; never in rail mode
        const carried = collapsed ? [] : (props.dragGroupIds?.(g) ?? []);
        // every heading of datasets has a menu, one without layers too (the caller picks its
        // items); the Measurements heading holds no datasets, so it has none
        const groupMenu = mg ? undefined : props.onGroupMenu;
        const groupDrag = carried.length > 0 && props.onDragItem !== undefined;
        const action = collapsed ? undefined : props.groupAction?.(g);
        const fold: GroupFold = {
          expanded,
          toggle: () => {
            setOpen((o) => ({
              ...o,
              [g.kind]: !(o[g.kind] ?? (props.defaultOpen ?? DEFAULT_OPEN).includes(g.kind)),
            }));
          },
        };
        return (
          <div key={g.kind} role="treeitem" aria-expanded={expanded} aria-selected={false}>
            <div
              className="tgroup-row"
              data-testid={`tree-group-${g.kind}`}
              ref={mg ? measureHead : undefined}
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
                      groupMenu(g, carried, menuPoint(e), fold);
                    },
                    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
                      if (!isMenuKey(e)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      groupMenu(g, carried, keyMenuPoint(e.currentTarget), fold);
                    },
                  }
                : mg
                  ? noMenu
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
                <span className="gcount">
                  {filtering
                    ? t('tree.measure.filterCount', { shown: g.matched ?? 0, total: g.count })
                    : g.count}
                </span>
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
              {mg && !collapsed && (
                <VisibilityEye
                  layerIds={groupMeasureIds(g)}
                  hidden={mg.hidden}
                  onSet={mg.onSetVisible}
                  labels={{
                    all: t('tree.eye.hideGroup', { group: g.label }),
                    none: t('tree.eye.showGroup', { group: g.label }),
                    mixed: t('tree.eye.showGroupMixed', { group: g.label }),
                  }}
                />
              )}
              {!mg && props.onSetVisible && !collapsed && (
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
            {expanded && mg?.onQuery && filterBox(mg, mg.onQuery)}
            {expanded && filtering && g.matched === 0 && (
              <p className="tfilter-none" data-testid="measure-filter-none">
                {t('tree.measure.filterNone')}
              </p>
            )}
            {expanded && (
              <div className="titems" role="group">
                {mg ? (
                  <>
                    {newFolderRow(mg)}
                    {folders.map((it) =>
                      it.folder !== undefined
                        ? measureFolderRow(it, it.folder, mg, filtering)
                        : null,
                    )}
                    {rows.map((it) => measureRow(it, mg, false))}
                  </>
                ) : (
                  rows.map((it) => (it.children ? flightRow(it, it.children) : row(it, false)))
                )}
                {!filtering &&
                  moreRow(behind, showingAll, capped.length, () => {
                    setShowAll((s) => ({ ...s, [g.kind]: !s[g.kind] }));
                  })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
