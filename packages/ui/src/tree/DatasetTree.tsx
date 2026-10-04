import { useState } from 'react';
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
  /** Groups open at first; defaults to models, maps, video and annotations. */
  defaultOpen?: readonly TreeGroupKind[] | undefined;
}

const DEFAULT_OPEN: TreeGroupKind[] = ['models', 'maps', 'video', 'annotations'];
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

  const row = (it: TreeItem, sub: boolean) => {
    const off = it.layerId ? hidden[it.layerId] === true : false;
    const sel = it.id === selectedId;
    return (
      <div
        key={it.id}
        role="treeitem"
        aria-selected={sel}
        tabIndex={0}
        className={`titem${sub ? ' sub' : ''}${sel ? ' sel' : ''}${off ? ' hidden' : ''}`}
        title={it.name}
        onClick={() => {
          props.onSelect(it);
        }}
        onKeyDown={(e) => {
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
    <div className="tree" role="tree" aria-label="Datasets">
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
        return (
          <div key={g.kind} role="treeitem" aria-expanded={expanded} aria-selected={false}>
            <div className="tgroup-row">
              <button
                type="button"
                className="tgroup-btn"
                aria-expanded={expanded}
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
