import { useState } from 'react';
import { Icon } from '../icons/Icon';
import type { TreeGroup, TreeGroupKind, TreeItem } from './model';

export interface DatasetTreeProps {
  groups: readonly TreeGroup[];
  hidden: Readonly<Record<string, true>>;
  selectedId: string | null;
  activeClip: string | null;
  /** Icon rail mode: groups show as icons with tooltips. */
  collapsed: boolean;
  onToggleVisible: (layerId: string, visible: boolean) => void;
  onSelect: (item: TreeItem) => void;
  /** Called when a group is activated in rail mode (expand the sidebar and open the group). */
  onRailGroup?: (kind: TreeGroupKind) => void;
}

const DEFAULT_OPEN: TreeGroupKind[] = ['models', 'maps', 'video', 'annotations'];
/** Rows shown per group before a "more" row; selected and active rows always show. */
const ROW_LIMIT = 8;

/** Datasets of the open project grouped by kind, with counts, visibility and selection. */
export function DatasetTree(props: DatasetTreeProps) {
  const { groups, hidden, selectedId, activeClip, collapsed } = props;
  const [open, setOpen] = useState<Partial<Record<TreeGroupKind, boolean>>>({});
  const isOpen = (k: TreeGroupKind) => open[k] ?? DEFAULT_OPEN.includes(k);
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
    const off = ids.every((id) => hidden[id] === true);
    return (
      <div key={it.id} role="treeitem" aria-expanded={open} aria-selected={false}>
        <div
          tabIndex={0}
          className={`titem flight${off ? ' hidden' : ''}`}
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
            aria-label={`${off ? 'Show' : 'Hide'} ${it.name}`}
            aria-pressed={!off}
            title={off ? 'Show' : 'Hide'}
            onClick={(e) => {
              e.stopPropagation();
              for (const id of ids) props.onToggleVisible(id, off);
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
