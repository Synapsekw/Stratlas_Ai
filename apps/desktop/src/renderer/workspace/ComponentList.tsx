import { getActiveStage, type ComponentInfo } from '@aio/engine';
import { Icon, useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import './components.css';

/**
 * Components hidden in the 3D view, by layer. The stage keeps the real visibility; this mirrors it
 * so the list and the card can show it, and puts it back when a view of the layer is made again.
 */
export const componentVisibility = createStore<{ hidden: Record<string, string[]> }>(() => ({
  hidden: {},
}));
// layer ids belong to a project: another project starts with everything shown
workspace.subscribe((s, prev) => {
  if (s.project?.id !== prev.project?.id) componentVisibility.setState({ hidden: {} });
});

/** Show or hide one component of a layer in the 3D view. */
export function setComponentVisible(layerId: string, id: string, visible: boolean): void {
  getActiveStage()?.setNodeVisible(layerId, id, visible);
  componentVisibility.setState((s) => {
    const was = s.hidden[layerId] ?? [];
    const next = visible ? was.filter((x) => x !== id) : [...new Set([...was, id])];
    return { hidden: { ...s.hidden, [layerId]: next } };
  });
}

const NONE: readonly string[] = [];
const NO_COMPONENTS: ComponentInfo[] = [];

/** The components hidden in a layer, as a set. */
export function useHiddenComponents(layerId: string): ReadonlySet<string> {
  const ids = useStore(componentVisibility, (s) => s.hidden[layerId] ?? NONE);
  return useMemo(() => new Set(ids), [ids]);
}

/** How often and how long to look for the components of a layer that is still loading. */
const POLL_MS = 400;
const POLL_TRIES = 25;

/**
 * The engineering components of a mesh layer in the active 3D view (empty for other layers).
 * A layer still loading is looked at again for a few seconds.
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
    const look = () => {
      const found = getActiveStage()?.components(layerId) ?? [];
      setState((prev) =>
        prev.layerId === layerId &&
        prev.list.length === found.length &&
        prev.list.every((c, i) => c.id === found[i]?.id)
          ? prev
          : { layerId, list: found },
      );
      if (found.length) {
        // a new view of the layer draws everything: hide again what was hidden
        for (const id of componentVisibility.getState().hidden[layerId] ?? [])
          getActiveStage()?.setNodeVisible(layerId, id, false);
        return;
      }
      if (++tries < POLL_TRIES) timer = setTimeout(look, POLL_MS);
    };
    look();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
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
 * toggle per component.
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
  const q = query.trim().toLowerCase();
  const shown = q ? components.filter((c) => matches(c, q)) : components;
  const groups = grouped(shown, t('component.list.other'));
  const names = new Map(components.map((c) => [c.id, c.name]));
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
      {groups.map((g) => (
        <div className="cl-group" data-testid="component-group" key={g.label}>
          <h3>{g.label}</h3>
          <ul>
            {g.rows.map(({ info, depth }) => {
              const visible = !hidden.has(info.id);
              const on = info.parent ? names.get(info.parent) : undefined;
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
                    aria-current={selected === info.id ? 'true' : undefined}
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
                    aria-pressed={visible}
                    aria-label={t(visible ? 'component.list.hide' : 'component.list.show', {
                      name: info.name,
                    })}
                    title={t(visible ? 'component.list.hide' : 'component.list.show', {
                      name: info.name,
                    })}
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
    </section>
  );
}

/** The component list of a mesh layer in the active 3D view, wired to the stage and selection. */
export function LayerComponents({
  layerId,
  selected,
  onSelect,
}: {
  layerId: string;
  selected?: string | undefined;
  onSelect?: (id: string) => void;
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
        if (onSelect) onSelect(id);
        else workspace.getState().select({ kind: 'asset', id, layer: layerId });
      }}
      onToggle={(id, visible) => {
        setComponentVisible(layerId, id, visible);
      }}
    />
  );
}
