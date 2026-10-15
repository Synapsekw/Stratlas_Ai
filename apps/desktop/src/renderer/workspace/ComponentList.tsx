import { getActiveStage, onActiveScene, type ComponentInfo } from '@aio/engine';
import { Icon, useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import './components.css';

/**
 * Show or hide one component of a layer. The engine keeps which components are hidden (per
 * project and layer, for every view of it, also after the layer loads again); the UI reads it back.
 */
export function setComponentVisible(layerId: string, id: string, visible: boolean): void {
  getActiveStage()?.setNodeVisible(layerId, id, visible);
}

/** The components the engine has hidden in a layer, kept up to date. */
export function useHiddenComponents(layerId: string): ReadonlySet<string> {
  const subscribe = useCallback(
    (cb: () => void) => {
      let offStage: (() => void) | undefined;
      const watch = () => {
        offStage?.();
        offStage = getActiveStage()?.onHiddenNodes((id) => {
          if (id === layerId) cb();
        });
      };
      watch();
      // another view became active: read its record
      const offScene = onActiveScene(() => {
        watch();
        cb();
      });
      return () => {
        offScene();
        offStage?.();
      };
    },
    [layerId],
  );
  const key = useSyncExternalStore(subscribe, () =>
    (getActiveStage()?.hiddenNodes(layerId) ?? []).join('\n'),
  );
  return useMemo(() => new Set(key ? key.split('\n') : []), [key]);
}

const NO_COMPONENTS: ComponentInfo[] = [];
/** How often and how long to look again while the layer is still loading. */
const POLL_MS = 400;
const POLL_TRIES = 25;

/** Whether two component lists say the same (ids, names, dimensions, every field). */
const sameList = (a: readonly ComponentInfo[], b: readonly ComponentInfo[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

/**
 * The engineering components of a mesh layer in the active 3D view (empty for other layers). A
 * layer still loading is looked at again until it has loaded (for a few seconds at most); a
 * loaded layer without components is not asked again. A layer that loads again (a model rebuilt
 * by a correction) is read again, so the list and the card follow it.
 */
export function useLayerComponents(layerId: string): ComponentInfo[] {
  const [state, setState] = useState<{ layerId: string; list: ComponentInfo[] }>(() => ({
    layerId,
    list: layerId ? (getActiveStage()?.components(layerId) ?? []) : [],
  }));
  useEffect(() => {
    if (!layerId) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const stage = getActiveStage();
      const found = stage?.components(layerId) ?? [];
      setState((prev) =>
        prev.layerId === layerId && sameList(prev.list, found) ? prev : { layerId, list: found },
      );
      return stage;
    };
    const look = () => {
      if (read()?.layerLoaded(layerId)) return;
      if (++tries < POLL_TRIES) timer = setTimeout(look, POLL_MS);
    };
    look();
    let offLoaded: (() => void) | undefined;
    const watch = () => {
      offLoaded?.();
      offLoaded = getActiveStage()?.onLayerLoaded((id) => {
        if (id === layerId) read();
      });
    };
    watch();
    // another view became active: follow its loads, and read its copy of the layer
    const offScene = onActiveScene(() => {
      watch();
      read();
    });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      offScene();
      offLoaded?.();
    };
  }, [layerId]);
  return layerId && state.layerId === layerId ? state.list : NO_COMPONENTS;
}

interface Group {
  label: string;
  rows: { info: ComponentInfo; depth: number }[];
}

const matches = (c: ComponentInfo, q: string) =>
  [c.name, c.id, c.category, c.tag, c.description].some((v) => v?.toLowerCase().includes(q));

/**
 * Groups by category (alphabetical, uncategorised last), each part mounted on another part of the
 * same group listed under it.
 */
function grouped(list: readonly ComponentInfo[], other: string): Group[] {
  const byCat = new Map<string, ComponentInfo[]>();
  for (const c of list) {
    const k = c.category ?? '';
    byCat.set(k, [...(byCat.get(k) ?? []), c]);
  }
  const keys = [...byCat.keys()].sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
  );
  return keys.map((k) => {
    const members = byCat.get(k) ?? [];
    const ids = new Set(members.map((c) => c.id));
    const rows: Group['rows'] = [];
    const add = (c: ComponentInfo, depth: number) => {
      rows.push({ info: c, depth });
      for (const child of members)
        if (child.parent === c.id && child !== c) add(child, Math.min(depth + 1, 3));
    };
    for (const c of members) if (!c.parent || !ids.has(c.parent)) add(c, 0);
    return { label: k || other, rows };
  });
}

/**
 * The components of an engineering model: a search over name, id, category, tag and
 * description, rows grouped by category that select on a click or tap, and a show or hide
 * toggle per component. The rows are one Tab stop: Up, Down, Home and End move between them,
 * Right goes to the row's show or hide toggle and Left back.
 */
export function ComponentList({
  layerId,
  components,
  hidden,
  selected,
  onSelect,
  onToggle,
}: {
  layerId: string;
  components: ComponentInfo[];
  hidden: ReadonlySet<string>;
  selected?: string | undefined;
  onSelect: (id: string) => void;
  onToggle: (id: string, visible: boolean) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? components.filter((c) => matches(c, q)) : components;
  const groups = grouped(shown, t('component.list.other'));
  const order = groups.flatMap((g) => g.rows.map((r) => r.info.id));
  // the row that takes Tab: the one last focused, else the selection, else the first
  const current =
    (active && order.includes(active) ? active : null) ??
    (selected && order.includes(selected) ? selected : null) ??
    order[0];
  const names = new Map(components.map((c) => [c.id, c.name]));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = listRef.current;
    const el = e.target as HTMLElement;
    const row = el.closest<HTMLElement>('[data-testid="component-row"]');
    if (!root || !row) return;
    const id = row.dataset.id ?? '';
    let to: string | undefined;
    const at = order.indexOf(id);
    if (e.key === 'ArrowDown') to = order[Math.min(at + 1, order.length - 1)];
    else if (e.key === 'ArrowUp') to = order[Math.max(at - 1, 0)];
    else if (e.key === 'Home') to = order[0];
    else if (e.key === 'End') to = order[order.length - 1];
    else if (e.key === 'ArrowRight' && el.classList.contains('cl-name')) {
      row.querySelector<HTMLElement>('.cl-eye')?.focus();
      e.preventDefault();
      return;
    } else if (e.key === 'ArrowLeft' && el.classList.contains('cl-eye')) {
      row.querySelector<HTMLElement>('.cl-name')?.focus();
      e.preventDefault();
      return;
    }
    if (to === undefined) return;
    e.preventDefault();
    setActive(to);
    for (const r of root.querySelectorAll<HTMLElement>('[data-testid="component-row"]'))
      if (r.dataset.id === to) r.querySelector<HTMLElement>('.cl-name')?.focus();
  };

  return (
    <section className="comp-list" data-testid="component-list" data-layer={layerId}>
      <div className="cl-head">
        <h3>{t('component.list.title')}</h3>
        <span className="faint">{t('component.list.count', { count: components.length })}</span>
      </div>
      <input
        className="input cl-search"
        type="search"
        data-testid="component-search"
        placeholder={t('component.list.search')}
        aria-label={t('component.list.search')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      {groups.length === 0 && (
        <p className="faint cl-empty">{t('component.list.empty', { query: query.trim() })}</p>
      )}
      <div ref={listRef} onKeyDown={onKeyDown}>
        {groups.map((g) => (
          <div className="cl-group" data-testid="component-group" key={g.label}>
            <h3>{g.label}</h3>
            <ul>
              {g.rows.map(({ info, depth }) => {
                const visible = !hidden.has(info.id);
                const on = info.parent ? names.get(info.parent) : undefined;
                const toggle = t(visible ? 'component.list.hide' : 'component.list.show', {
                  name: info.name,
                });
                return (
                  <li
                    key={info.id}
                    data-testid="component-row"
                    data-id={info.id}
                    className={visible ? undefined : 'is-hidden'}
                    style={depth ? { paddingInlineStart: `${String(depth * 14)}px` } : undefined}
                  >
                    <button
                      type="button"
                      className="cl-name"
                      tabIndex={info.id === current ? 0 : -1}
                      aria-current={selected === info.id ? 'true' : undefined}
                      onFocus={() => {
                        setActive(info.id);
                      }}
                      onClick={() => {
                        onSelect(info.id);
                      }}
                    >
                      <span>{info.name}</span>
                      <span className="cl-sub mono">
                        {info.tag ?? info.id}
                        {depth === 0 && on ? ` · ${on}` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn icon sm ghost cl-eye"
                      tabIndex={-1}
                      aria-pressed={visible}
                      aria-label={toggle}
                      title={toggle}
                      onClick={() => {
                        onToggle(info.id, !visible);
                      }}
                    >
                      <Icon name={visible ? 'eye' : 'eye-off'} size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The component list of a mesh layer in the active 3D view, wired to the stage and selection. */
export function LayerComponents({
  layerId,
  selected,
}: {
  layerId: string;
  selected?: string | undefined;
}) {
  const components = useLayerComponents(layerId);
  const hidden = useHiddenComponents(layerId);
  if (!components.length) return null;
  return (
    <ComponentList
      layerId={layerId}
      components={components}
      hidden={hidden}
      selected={selected}
      onSelect={(id) => {
        workspace.getState().select({ kind: 'asset', id, layer: layerId });
      }}
      onToggle={(id, visible) => {
        setComponentVisible(layerId, id, visible);
      }}
    />
  );
}
