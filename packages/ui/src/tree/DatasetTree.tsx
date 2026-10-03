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

/** Datasets of the open project grouped by kind, with counts, visibility and selection. */
export function DatasetTree(props: DatasetTreeProps) {
  const { groups, hidden, selectedId, activeClip, collapsed } = props;
  const [open, setOpen] = useState<Partial<Record<TreeGroupKind, boolean>>>({});
  const isOpen = (k: TreeGroupKind) => open[k] ?? DEFAULT_OPEN.includes(k);

  return (
    <div className="tree" role="tree" aria-label="Datasets">
      {groups.map((g) => {
        const expanded = !collapsed && isOpen(g.kind);
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
                {g.items.map((it) => {
                  const off = it.layerId ? hidden[it.layerId] === true : false;
                  const sel = it.id === selectedId;
                  return (
                    <div
                      key={it.id}
                      role="treeitem"
                      aria-selected={sel}
                      tabIndex={0}
                      className={`titem${sel ? ' sel' : ''}${off ? ' hidden' : ''}`}
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
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
