import { useRef, useState, type CSSProperties, type DragEvent } from 'react';
import type { DateTag } from '@aio/workspace';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import {
  DatasetTree,
  VisibilityEye,
  menuPoint,
  type DatasetTreeProps,
  type MenuPoint,
} from './DatasetTree';
import { EVERY_DATE, dateIcon, dropCapture, type DateFolder } from './dateModel';
import { datableLayerIds, type TreeItem } from './model';

/** A folder's menu was asked for: where, and how the folder stands in the tree right now. */
export interface DateFolderMenuRequest extends MenuPoint {
  folder: DateFolder;
  expanded: boolean;
  /** Open or close the folder (the tree keeps that state). */
  toggle: () => void;
}

/** A row's menu was asked for: the row, the layers it can file under a date, and its folder. */
export interface DateItemMenuRequest extends MenuPoint {
  item: TreeItem;
  layerIds: string[];
  /** The folder the row sits in (`EVERY_DATE` or a capture id). */
  from: string;
}

export interface DateTreeProps extends Omit<
  DatasetTreeProps,
  'groups' | 'collapsed' | 'nested' | 'dragIds' | 'onDragItem' | 'onItemMenu'
> {
  folders: readonly DateFolder[];
  tags: Readonly<Record<string, DateTag>>;
  focus: string | null;
  onFocus: (capture: string) => void;
  /**
   * File layers under another survey date (null: under none). With it, rows drag onto the date
   * folders. Left out in a read-only project.
   */
  onMove?: ((layerIds: string[], capture: string | null) => void) | undefined;
  /** Right-click, the menu key or the "more" button on a folder. */
  onFolderMenu?: ((m: DateFolderMenuRequest) => void) | undefined;
  /** Right-click or the menu key on a dataset row that can be filed under a date. */
  onItemMenu?: ((m: DateItemMenuRequest) => void) | undefined;
  /** The capture whose folder shows its name field. */
  renaming?: string | null | undefined;
  /** F2 on a folder name. Left out in a read-only project. */
  onRenameStart?: ((capture: string) => void) | undefined;
  /** The name field was committed with this text (empty: no name, the date alone). */
  onRename?: ((capture: string, name: string) => void) | undefined;
  /** The name field closed (committed or cancelled). */
  onRenameEnd?: (() => void) | undefined;
}

/** The inline name field of a folder: Enter or leaving it saves, Escape cancels. */
function RenameField({
  initial,
  label,
  placeholder,
  onCommit,
  onEnd,
}: {
  initial: string;
  label: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onEnd: () => void;
}) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    if (value !== null && value.trim() !== initial) onCommit(value.trim());
    onEnd();
  };
  return (
    <input
      className="input drename"
      type="text"
      defaultValue={initial}
      maxLength={80}
      aria-label={label}
      placeholder={placeholder}
      data-testid="date-rename"
      // the field stands where the name was: the person who asked to rename types right away
      autoFocus
      onFocus={(e) => {
        e.currentTarget.select();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => {
        finish(e.currentTarget.value);
      }}
    />
  );
}

export function DateTree(props: DateTreeProps) {
  const {
    folders,
    tags,
    focus,
    onFocus,
    hidden,
    onMove,
    onFolderMenu,
    onItemMenu,
    renaming,
    onRenameStart,
    onRename,
    onRenameEnd,
    ...rest
  } = props;
  const t = useT();
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({
    [EVERY_DATE]: true,
    ...(focus ? { [focus]: true } : {}),
  }));
  /** The rows being dragged and the folder they came from. */
  const [drag, setDrag] = useState<{ ids: string[]; from: string } | null>(null);
  /** The folder the drag is over, when it would take the drop. */
  const [over, setOver] = useState<string | null>(null);

  // A new focus opens its folder and collapses the rest. Adjusted during render, not in an effect.
  const [seen, setSeen] = useState(focus);
  if (focus !== seen) {
    setSeen(focus);
    if (focus) setOpen((o) => ({ [EVERY_DATE]: o[EVERY_DATE] ?? true, [focus]: true }));
  }

  /** Drop wiring of a folder: every folder takes the drag but the one it came from. */
  const dropOn = (id: string, capture: string | null) => {
    if (!onMove || !drag || drag.from === id) return {};
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
        setDrag(null);
        setOver(null);
        onMove(ids, capture);
      },
    };
  };
  const dropClass = (id: string) =>
    !onMove || !drag || drag.from === id ? '' : over === id ? ' drop-can drop-over' : ' drop-can';

  // No Every date folder (every layer is dated): a drag still needs somewhere to drop "no date".
  const spareEvery =
    onMove && drag && drag.from !== EVERY_DATE && !folders.some((f) => f.id === EVERY_DATE);

  return (
    <div
      className={`tree dtree${drag ? ' dragging' : ''}`}
      role="tree"
      aria-label={t('tree.dates.label')}
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
            className={`dfolder${focused ? ' focused' : ''}${empty ? ' empty' : ''}${dropClass(f.id)}`}
            data-testid={`date-folder-${f.id}`}
            style={tag ? ({ '--dtag': tag.colour } as CSSProperties) : undefined}
            {...dropOn(f.id, dropCapture(f))}
          >
            <div
              className="dfolder-row"
              onContextMenu={
                onFolderMenu
                  ? (e) => {
                      e.preventDefault();
                      onFolderMenu({ folder: f, expanded, toggle, ...menuPoint(e) });
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
                  title={f.capture ? t('tree.dates.focus', { date: f.label }) : undefined}
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
              {on > 0 && (
                <span className="don" data-testid={`date-on-${f.id}`}>
                  {t('tree.dates.on', { count: on })}
                </span>
              )}
              {onFolderMenu && (
                <button
                  type="button"
                  className="eye dmore"
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
                hidden={hidden}
                groups={f.groups}
                collapsed={false}
                nested
                dragIds={onMove ? datableLayerIds : undefined}
                onDragItem={
                  onMove
                    ? (ids) => {
                        setDrag(ids ? { ids, from: f.id } : null);
                        if (!ids) setOver(null);
                      }
                    : undefined
                }
                onItemMenu={
                  onItemMenu
                    ? (item, at) => {
                        const layerIds = datableLayerIds(item);
                        if (layerIds.length > 0) onItemMenu({ item, layerIds, from: f.id, ...at });
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
          className={`dfolder dfolder-spare${dropClass(EVERY_DATE)}`}
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
    </div>
  );
}
