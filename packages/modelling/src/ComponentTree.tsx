import { AssemblyKind, type Assembly, type ProcModel } from '@aio/schema';
import { arrowFocus, Icon, useT, type MessageKey } from '@aio/ui';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { kindLabel } from './assemblyEdit';

/**
 * The components of an engineering model grouped by category (a child sits under its parent in the
 * same category), with search. The list holds one button per component, so Up and Down move
 * through it with `arrowFocus` and the selection follows focus; the selected component's review
 * actions sit under it. Keyboard on a component: A accepts, R rejects, D makes a draft, H hides or
 * shows it, Delete removes it (an accepted one asks first, inline), Shift+A accepts every draft.
 * Presentational: the host keeps the model.
 */
export interface ComponentTreeProps {
  model: ProcModel;
  selected: string | null;
  /** Ids hidden in the view. */
  hidden: readonly string[];
  /** Read-only project or a rebuild in progress: nothing can change. */
  locked?: boolean;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  onStatus: (ids: readonly string[] | 'all', status: Assembly['status']) => void;
  onRemove: (id: string) => void;
  onAdd: (kind: AssemblyKind) => void;
}

interface Row {
  a: Assembly;
  depth: number;
}

/** Components of one category, parents before their children. */
function ordered(items: readonly Assembly[]): Row[] {
  const ids = new Set(items.map((a) => a.id));
  const kids = new Map<string, Assembly[]>();
  const roots: Assembly[] = [];
  for (const a of items) {
    if (a.parent && ids.has(a.parent)) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
    else roots.push(a);
  }
  const out: Row[] = [];
  const walk = (a: Assembly, depth: number) => {
    out.push({ a, depth });
    for (const k of kids.get(a.id) ?? []) walk(k, Math.min(depth + 1, 3));
  };
  for (const r of roots) walk(r, 0);
  return out;
}

export function matches(a: Assembly, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [a.name, a.tag ?? '', a.id, a.category, kindLabel(a.kind)].some((s) =>
    s.toLowerCase().includes(q),
  );
}

export function ComponentTree(p: ComponentTreeProps) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [kind, setKind] = useState<AssemblyKind>('flue');
  const locked = p.locked === true;
  const all = p.model.assemblies;
  const accepted = all.filter((a) => a.status === 'accepted').length;
  const drafts = all.filter((a) => a.status === 'draft');
  const selected = all.find((a) => a.id === p.selected) ?? null;

  const groups = useMemo(() => {
    const byCategory = new Map<string, Assembly[]>();
    for (const a of all)
      if (matches(a, query)) byCategory.set(a.category, [...(byCategory.get(a.category) ?? []), a]);
    return [...byCategory.entries()].map(([category, items]) => ({
      category,
      rows: ordered(items),
    }));
  }, [all, query]);

  const remove = (a: Assembly) => {
    if (a.status === 'accepted') setConfirming(a.id);
    else p.onRemove(a.id);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const root = listRef.current;
    if (!root) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      if (arrowFocus(root, e.key)) e.preventDefault();
      return;
    }
    if (locked) return;
    const key = e.key.toLowerCase();
    if (key === 'a' && e.shiftKey) {
      e.preventDefault();
      p.onStatus(
        drafts.map((a) => a.id),
        'accepted',
      );
    } else if (selected && (key === 'a' || key === 'r' || key === 'd')) {
      e.preventDefault();
      p.onStatus([selected.id], key === 'a' ? 'accepted' : key === 'r' ? 'rejected' : 'draft');
    } else if (selected && key === 'h') {
      e.preventDefault();
      p.onToggle(selected.id);
    } else if (selected && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      remove(selected);
    }
  };

  const isHidden = (id: string) => p.hidden.includes(id);

  return (
    <div className="mb-cmp" data-testid="component-tree">
      <div className="mb-row">
        <input
          type="search"
          aria-label={t('review.search')}
          placeholder={t('review.search')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && listRef.current && arrowFocus(listRef.current, 'Home'))
              e.preventDefault();
          }}
        />
      </div>

      <div className="mb-row">
        <button
          type="button"
          className="btn sm"
          disabled={locked || drafts.length === 0}
          onClick={() => {
            p.onStatus(
              drafts.map((a) => a.id),
              'accepted',
            );
          }}
        >
          {t('review.acceptAll')}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={locked || drafts.length === 0}
          onClick={() => {
            p.onStatus(
              drafts.map((a) => a.id),
              'rejected',
            );
          }}
        >
          {t('review.rejectAll')}
        </button>
        <span className="mb-count">{t('review.summary', { accepted, drafts: drafts.length })}</span>
      </div>

      {all.length === 0 && <p className="mb-hint">{t('review.none')}</p>}
      {all.length > 0 && groups.length === 0 && <p className="mb-hint">{t('review.noMatch')}</p>}

      <div
        ref={listRef}
        className="mb-cmp-list"
        aria-label={t('review.tree')}
        role="group"
        onKeyDown={onKey}
      >
        {groups.map((g) => (
          <section key={g.category} className="mb-cmp-group" aria-label={g.category}>
            <h4>
              {g.category} <span className="mb-count">{g.rows.length}</span>
            </h4>
            {g.rows.map(({ a, depth }) => (
              <button
                key={a.id}
                type="button"
                className="mb-cmp-row"
                data-component={a.id}
                data-status={a.status}
                data-depth={depth}
                data-hidden={isHidden(a.id) || undefined}
                aria-pressed={a.id === p.selected}
                tabIndex={a.id === p.selected || (p.selected === null && a === all[0]) ? 0 : -1}
                onClick={() => {
                  p.onSelect(a.id);
                }}
                onFocus={() => {
                  if (a.id !== p.selected) p.onSelect(a.id);
                }}
              >
                <span className={`mb-st ${a.status}`}>
                  {t(`review.status.${a.status}` as MessageKey)}
                </span>
                <span className="mb-name">
                  <b>{a.name}</b>
                  <small>
                    {kindLabel(a.kind)}
                    {a.tag ? `, ${a.tag}` : ''}
                  </small>
                </span>
                {isHidden(a.id) && (
                  <span className="mb-cmp-flag" title={t('review.hidden')}>
                    <Icon name="eye" size={12} />
                    <span className="sr-only">{t('review.hidden')}</span>
                  </span>
                )}
              </button>
            ))}
          </section>
        ))}
      </div>

      {selected && (
        <div className="mb-row mb-acts" role="toolbar" aria-label={selected.name}>
          {confirming === selected.id ? (
            <div
              className="mb-cmp-confirm"
              role="group"
              aria-label={t('review.removeAsk', { name: selected.name })}
            >
              <span>{t('review.removeAsk', { name: selected.name })}</span>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setConfirming(null);
                  p.onRemove(selected.id);
                }}
              >
                {t('review.removeYes')}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                autoFocus
                onClick={() => {
                  setConfirming(null);
                }}
              >
                {t('review.removeNo')}
              </button>
            </div>
          ) : (
            <>
              {(
                [
                  ['accepted', 'review.accept'],
                  ['rejected', 'review.reject'],
                  ['draft', 'review.draft'],
                ] as const
              ).map(([status, label]) => (
                <button
                  key={status}
                  type="button"
                  className="btn ghost sm"
                  aria-label={`${t(label)} ${selected.name}`}
                  disabled={locked || selected.status === status}
                  onClick={() => {
                    p.onStatus([selected.id], status);
                  }}
                >
                  {t(label)}
                </button>
              ))}
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  p.onToggle(selected.id);
                }}
              >
                {isHidden(selected.id)
                  ? t('review.show', { name: selected.name })
                  : t('review.hide', { name: selected.name })}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={locked}
                onClick={() => {
                  remove(selected);
                }}
              >
                {t('review.remove', { name: selected.name })}
              </button>
            </>
          )}
        </div>
      )}

      <div className="mb-row">
        <select
          aria-label={t('review.addKind')}
          value={kind}
          onChange={(e) => {
            const k = AssemblyKind.safeParse(e.target.value);
            if (k.success) setKind(k.data);
          }}
        >
          {AssemblyKind.options.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn sm"
          disabled={locked}
          onClick={() => {
            p.onAdd(kind);
          }}
        >
          <Icon name="plus" size={12} /> {t('review.add')}
        </button>
      </div>
    </div>
  );
}
