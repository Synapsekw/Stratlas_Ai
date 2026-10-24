import { useState, type CSSProperties, type DragEvent } from 'react';
import type { DateTag } from '@aio/workspace';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import {
  DatasetTree,
  VisibilityEye,
  isMenuKey,
  keyMenuPoint,
  menuPoint,
  type DatasetTreeProps,
  type GroupFold,
  type MeasureTreeProps,
  type MenuPoint,
} from './DatasetTree';
import { RenameField } from './RenameField';
import { EVERY_DATE, dateIcon, dropCapture, type DateFolder } from './dateModel';
import {
  datableLayerIds,
  groupDatableLayerIds,
  groupMeasureIds,
  type TreeGroup,
  type TreeGroupKind,
  type TreeItem,
} from './model';

/** A folder's menu was asked for: where, and how the folder stands in the tree right now. */
export interface DateFolderMenuRequest extends MenuPoint {
  folder: DateFolder;
  expanded: boolean;
  /** Open or close the folder (the tree keeps that state). */
  toggle: () => void;
}

/** A move menu was asked for: a row's, or a whole group's from its header. */
export interface DateItemMenuRequest extends MenuPoint {
  /** The heading of the menu: the row's name, or the group with how many datasets it moves. */
  name: string;
  /** The row, when the menu is a row's; not set for a group header. */
  item?: TreeItem | undefined;
  /** The layers the move files under a date. */
  layerIds: string[];
  /** The folder the row or group sits in (`EVERY_DATE` or a capture id). */
  from: string;
  /** Set for a group header: its fold state, for Expand and Collapse. */
  fold?: GroupFold | undefined;
  /** Set for a group header: which group. */
  group?: TreeGroupKind | undefined;
}

export interface DateTreeProps extends Omit<
  DatasetTreeProps,
  | 'groups'
  | 'collapsed'
  | 'nested'
  | 'dragIds'
  | 'onDragItem'
  | 'onItemMenu'
  | 'dragGroupIds'
  | 'onGroupMenu'
> {
  folders: readonly DateFolder[];
  tags: Readonly<Record<string, DateTag>>;
  focus: string | null;
  onFocus: (capture: string) => void;
  /**
   * File layers under another survey date (null: under none). With it, rows and group headers
   * drag onto the date folders. Left out in a read-only project.
   */
  onMove?: ((layerIds: string[], capture: string | null) => void) | undefined;
  /**
   * File measurements under another survey date. With it (and `measures.dragMeasureIds`) a
   * measurement drag is offered to every date folder but its own. An antenna measurement is shown
   * refused on them, and a drop still reaches here: the caller says why it stays.
   */
  onMoveMeasures?: ((ids: string[], capture: string) => void) | undefined;
  /** Right-click, the menu key or the "more" button on a folder. */
  onFolderMenu?: ((m: DateFolderMenuRequest) => void) | undefined;
  /** Right-click or the menu key on a dataset row or a group header that can be filed under a date. */
  onItemMenu?: ((m: DateItemMenuRequest) => void) | undefined;
  /** The capture whose folder shows its name field. */
  renaming?: string | null | undefined;
  /** F2 on a folder name. Left out in a read-only project. */
  onRenameStart?: ((capture: string) => void) | undefined;
  /** The name field was committed with this text (empty: no name, the date alone). */
  onRename?: ((capture: string, name: string) => void) | undefined;
  /** The name field closed (committed or cancelled). */
  onRenameEnd?: (() => void) | undefined;
  /**
   * Groups of no survey date (Measurements), drawn once below the date folders in the same tree,
   * with the same row props.
   */
  after?: readonly TreeGroup[] | undefined;
}

export function DateTree(props: DateTreeProps) {
  const {
    folders,
    tags,
    focus,
    onFocus,
    hidden,
    onMove,
    onMoveMeasures,
    onFolderMenu,
    onItemMenu,
    renaming,
    onRenameStart,
    onRename,
    onRenameEnd,
    after,
    ...rest
  } = props;
  const t = useT();
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({
    [EVERY_DATE]: true,
    ...(focus ? { [focus]: true } : {}),
  }));
  /** The rows being dragged and the folder they came from. */
  const [drag, setDrag] = useState<{
    kind: 'layers' | 'measurements';
    ids: string[];
    from: string;
    telecom: boolean;
  } | null>(null);
  /** The folder the drag is over, when it would take the drop. */
  const [over, setOver] = useState<string | null>(null);

  /** The folder a reveal had to open: its tree mounts with the reveal still to honour. */
  const [revealOpened, setRevealOpened] = useState<string | null>(null);
  // A new focus opens its folder and collapses the rest. Adjusted during render, not in an effect.
  const [seen, setSeen] = useState(focus);
  if (focus !== seen) {
    setSeen(focus);
    setRevealOpened(null);
    if (focus) setOpen((o) => ({ [EVERY_DATE]: o[EVERY_DATE] ?? true, [focus]: true }));
  }

  // A reveal of a measurement opens the date folder holding it. Adjusted during render, as the
  // focus is; a folder it had to open mounts its tree with the reveal still to honour.
  const reveal = rest.measures?.reveal;
  const [seenReveal, setSeenReveal] = useState(reveal?.seq ?? 0);
  if (reveal && reveal.seq !== seenReveal) {
    setSeenReveal(reveal.seq);
    const id = reveal.id;
    const holder =
      id === null
        ? undefined
        : folders.find((f) =>
            f.groups.some((g) => g.kind === 'measurements' && groupMeasureIds(g).includes(id)),
          );
    if (holder) {
      if (open[holder.id] !== true) setRevealOpened(holder.id);
      setOpen((o) => ({ ...o, [holder.id]: true }));
    }
  }

  /** The measurement tree props of the tree under folder `from`: its drags report here. */
  const measuresFor = (from: string): MeasureTreeProps | undefined => {
    const mp = rest.measures;
    if (!mp) return mp;
    // a new-folder request that names no measurement belongs to the focused date alone
    const nf = mp.newFolder?.ids.length === 0 && from !== focus ? null : mp.newFolder;
    if (!onMoveMeasures) return nf === mp.newFolder ? mp : { ...mp, newFolder: nf };
    return {
      ...mp,
      newFolder: nf,
      onDragMeasures: (d) => {
        mp.onDragMeasures?.(d);
        if (d) setDrag({ kind: 'measurements', ids: d.ids, from, telecom: d.telecom });
        else {
          setDrag(null);
          setOver(null);
        }
      },
    };
  };

  /**
   * Whether the drag is offered to a folder: a layer drag to every folder but its own; a
   * measurement drag to every date folder (one with a capture) but its own.
   */
  const offers = (id: string, capture: string | null) => {
    if (!drag || drag.from === id) return false;
    if (drag.kind === 'layers') return onMove !== undefined;
    return onMoveMeasures !== undefined && capture !== null;
  };

  /** Drop wiring of a folder: every folder takes the drag but the one it came from. */
  const dropOn = (id: string, capture: string | null) => {
    if (!drag || !offers(id, capture)) return {};
    return {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (over !== id) setOver(id);
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        const to = e.relatedTarget;
        if (to instanceof Node && e.currentTarget.contains(to)) return;
        setOver((o) => (o === id ? null : o));
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        const ids = drag.ids;
        const kind = drag.kind;
        setDrag(null);
        setOver(null);
        if (kind === 'layers') onMove?.(ids, capture);
        else if (capture !== null) onMoveMeasures?.(ids, capture);
      },
    };
  };
  const dropClass = (id: string, capture: string | null) => {
    if (!drag || !offers(id, capture)) return '';
    // an antenna measurement is shown refused; the drop still reaches the caller, who says why
    if (drag.kind === 'measurements' && drag.telecom) return ' drop-no';
    return over === id ? ' drop-can drop-over' : ' drop-can';
  };

  // No Every date folder (every layer is dated): a drag still needs somewhere to drop "no date".
  const spareEvery =
    onMove &&
    drag?.kind === 'layers' &&
    drag.from !== EVERY_DATE &&
    !folders.some((f) => f.id === EVERY_DATE);

  return (
    <div
      className={`tree dtree${drag ? ' dragging' : ''}`}
      role="tree"
      aria-label={t('tree.dates.label')}
      aria-multiselectable={rest.onMark ? true : undefined}
    >
      {folders.map((f) => {
        const expanded = open[f.id] === true;
        const focused = f.id === focus;
        // a date with only its issues is not empty: its Annotations group shows
        const empty = f.capture !== null && f.layerIds.length === 0 && f.groups.length === 0;
        const tag = f.capture ? tags[f.capture.id] : undefined;
        const icon = dateIcon(tag?.icon);
        const on = f.capture && !focused ? f.layerIds.filter((id) => !hidden[id]).length : 0;
        const editing = f.capture !== null && renaming === f.capture.id;
        const toggle = () => {
          setOpen((o) => ({ ...o, [f.id]: !expanded }));
          setRevealOpened(null);
        };
        const swatch = icon ? (
          <Icon name={icon} size={14} className="dicon" />
        ) : (
          <span className={tag ? 'dtag' : 'dtag every'} aria-hidden="true" />
        );
        return (
          <div
            key={f.id}
            role="treeitem"
            aria-expanded={expanded}
            aria-selected={focused}
            className={`dfolder${focused ? ' focused' : ''}${empty ? ' empty' : ''}${dropClass(f.id, dropCapture(f))}`}
            data-testid={`date-folder-${f.id}`}
            aria-description={
              drag?.kind === 'measurements' && drag.telecom && offers(f.id, dropCapture(f))
                ? t('tree.measure.move.telecom')
                : undefined
            }
            style={tag ? ({ '--dtag': tag.colour } as CSSProperties) : undefined}
            {...dropOn(f.id, dropCapture(f))}
          >
            <div
              className="dfolder-row"
              onContextMenu={
                onFolderMenu
                  ? (e) => {
                      e.preventDefault();
                      // empty space around the folders must not also open the project menu
                      e.stopPropagation();
                      onFolderMenu({ folder: f, expanded, toggle, ...menuPoint(e) });
                    }
                  : undefined
              }
              onKeyDown={
                onFolderMenu
                  ? (e) => {
                      if (!isMenuKey(e)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      onFolderMenu({
                        folder: f,
                        expanded,
                        toggle,
                        ...keyMenuPoint(e.currentTarget),
                      });
                    }
                  : undefined
              }
            >
              <button
                type="button"
                className="dchev"
                aria-label={t(expanded ? 'tree.dates.collapse' : 'tree.dates.expand', {
                  date: f.label,
                })}
                onClick={toggle}
              >
                <Icon name="chev-r" size={12} className="chev" />
              </button>
              {editing && f.capture ? (
                <span className="dname editing">
                  {swatch}
                  <span className="dlbl">{f.label}</span>
                  <RenameField
                    initial={f.sub ?? ''}
                    label={t('tree.dates.nameOf', { date: f.label })}
                    placeholder={t('tree.dates.namePlaceholder')}
                    testId="date-rename"
                    onCommit={(name) => {
                      if (f.capture) onRename?.(f.capture.id, name);
                    }}
                    onEnd={() => {
                      onRenameEnd?.();
                    }}
                  />
                </span>
              ) : (
                <button
                  type="button"
                  className="dname"
                  data-testid={`date-name-${f.id}`}
                  aria-current={focused ? 'date' : undefined}
                  title={
                    f.capture
                      ? [t('tree.dates.focus', { date: f.label }), f.lineUp]
                          .filter(Boolean)
                          .join('\n')
                      : undefined
                  }
                  onClick={() => {
                    if (f.capture) {
                      // Focusing an already-focused date changes nothing, so re-open it here.
                      if (focused) setOpen((o) => ({ ...o, [f.id]: true }));
                      onFocus(f.capture.id);
                    } else toggle();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'F2' && f.capture && onRenameStart) {
                      e.preventDefault();
                      onRenameStart(f.capture.id);
                    }
                  }}
                >
                  {swatch}
                  <span className="dlbl">{f.label}</span>
                  {f.sub && <span className="dsub">{f.sub}</span>}
                </button>
              )}
              {f.status && (
                <span className="dstatus" data-testid={`date-status-${f.id}`}>
                  {f.status}
                </span>
              )}
              {on > 0 && (
                <span className="don" data-testid={`date-on-${f.id}`}>
                  {t('tree.dates.on', { count: on })}
                </span>
              )}
              {onFolderMenu && (
                <button
                  type="button"
                  className="dmore"
                  aria-haspopup="menu"
                  aria-label={t('tree.dates.more', { date: f.label })}
                  title={t('tree.dates.more', { date: f.label })}
                  data-testid={`date-more-${f.id}`}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    onFolderMenu({ folder: f, expanded, toggle, x: r.left, y: r.bottom + 2 });
                  }}
                >
                  <Icon name="more" size={14} />
                </button>
              )}
              {f.layerIds.length > 0 && props.onSetVisible && (
                <VisibilityEye
                  layerIds={f.layerIds}
                  hidden={hidden}
                  onSet={props.onSetVisible}
                  labels={{
                    all: t('tree.eye.hideDate', { date: f.label }),
                    none: t('tree.eye.showDate', { date: f.label }),
                    mixed: t('tree.eye.showDateMixed', { date: f.label }),
                  }}
                />
              )}
            </div>
            {expanded && empty && <p className="dempty">{t('tree.dates.empty')}</p>}
            {expanded && f.groups.length > 0 && (
              <DatasetTree
                {...rest}
                measures={measuresFor(f.id)}
                honourReveal={revealOpened === f.id}
                hidden={hidden}
                groups={f.groups}
                collapsed={false}
                nested
                dragIds={onMove ? datableLayerIds : undefined}
                dragGroupIds={onMove || onItemMenu ? groupDatableLayerIds : undefined}
                onDragItem={
                  onMove
                    ? (ids) => {
                        setDrag(ids ? { kind: 'layers', ids, from: f.id, telecom: false } : null);
                        if (!ids) setOver(null);
                      }
                    : undefined
                }
                onItemMenu={
                  onItemMenu
                    ? (item, at) => {
                        onItemMenu({
                          name: item.name,
                          item,
                          layerIds: datableLayerIds(item),
                          from: f.id,
                          ...at,
                        });
                      }
                    : undefined
                }
                onGroupMenu={
                  onItemMenu
                    ? (g, layerIds, at, fold) => {
                        onItemMenu({
                          name: t('tree.dates.move.group', {
                            group: g.label,
                            count: layerIds.length,
                          }),
                          layerIds,
                          from: f.id,
                          fold,
                          group: g.kind,
                          ...at,
                        });
                      }
                    : undefined
                }
              />
            )}
          </div>
        );
      })}
      {/* Below the folders, so nothing moves under the pointer when the drag starts. */}
      {spareEvery && (
        <div
          className={`dfolder dfolder-spare${dropClass(EVERY_DATE, null)}`}
          data-testid={`date-folder-${EVERY_DATE}`}
          {...dropOn(EVERY_DATE, null)}
        >
          <div className="dfolder-row">
            <span className="dchev" aria-hidden="true" />
            <span className="dname">
              <span className="dtag every" aria-hidden="true" />
              <span className="dlbl">{t('tree.dates.every')}</span>
              <span className="dsub">{t('tree.dates.dropNoDate')}</span>
            </span>
          </div>
        </div>
      )}
      {/* each its own tree ("Needs a date", Stockpiles): its own fold, "more" and reveal */}
      {after?.map((g) => (
        <DatasetTree
          key={g.id ?? g.kind}
          {...rest}
          measures={measuresFor('needs-date')}
          hidden={hidden}
          groups={[g]}
          collapsed={false}
          nested
        />
      ))}
    </div>
  );
}
