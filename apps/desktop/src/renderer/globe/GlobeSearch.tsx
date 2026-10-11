import type { GlobeSite } from '@aio/schema';
import { Icon, t, useT } from '@aio/ui';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import './globe-search.css';
import { SiteFacts } from './SiteFacts';

/** The sites whose name holds the query, in the order given. A blank query keeps them all. */
export function filterSites(sites: readonly GlobeSite[], query: string): GlobeSite[] {
  const needle = query.trim().toLowerCase();
  return sites.filter((s) => s.name.toLowerCase().includes(needle));
}

export interface GlobeSearchProps {
  sites: readonly GlobeSite[];
  /** The selected site's id: its option reads as selected. */
  selected: string | null;
  onPick: (site: GlobeSite) => void;
  /** The site whose chip to light on the map (the option under the pointer or the keyboard). */
  onLight: (projectId: string | null) => void;
}

/** The Globe's "Find a site" field: focus lists every site, typing filters, a pick opens its card. */
export function GlobeSearch({ sites, selected, onPick, onLight }: GlobeSearchProps) {
  useT();
  const [query, setQuery] = useState('');
  const [wantOpen, setWantOpen] = useState(false);
  // -1: nothing chosen yet, so opening the list lights no chip
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const results = useMemo(() => filterSites(sites, query), [sites, query]);
  const open = wantOpen && sites.length > 0;
  const index = Math.min(active, results.length - 1);
  const activeSite = open ? results[index] : undefined;

  // told only when the lit site changes, so a moving pointer does not flood the screen
  const lit = useRef<string | null>(null);
  const onLightRef = useRef(onLight);
  useEffect(() => {
    onLightRef.current = onLight;
  }, [onLight]);
  const light = useCallback((projectId: string | null) => {
    if (lit.current === projectId) return;
    lit.current = projectId;
    onLightRef.current(projectId);
  }, []);
  const activeId = activeSite?.projectId ?? null;
  useEffect(() => {
    light(activeId);
  }, [activeId, light]);
  useEffect(
    () => () => {
      light(null);
    },
    [light],
  );

  useEffect(() => {
    if (activeId) {
      rootRef.current
        ?.querySelector(`[data-index="${index}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeId, index]);

  // a press anywhere else on the page closes the list
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setWantOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);

  const pick = (site: GlobeSite | undefined) => {
    if (!site) return;
    setQuery('');
    setActive(-1);
    setWantOpen(false);
    onPick(site);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setWantOpen(true);
        return;
      }
      const n = Math.max(results.length, 1);
      setActive(e.key === 'ArrowDown' ? (index + 1) % n : index < 0 ? n - 1 : (index - 1 + n) % n);
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      // typed a name and pressed Enter, with no arrow in between: the top match
      pick(activeSite ?? (query.trim() ? results[0] : undefined));
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setWantOpen(false);
    }
  };

  // Tab to another control closes the list; a press on an option must not (it keeps the focus)
  const onBlur = (e: FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget)) setWantOpen(false);
  };

  return (
    <div ref={rootRef} className="globe-search" onBlur={onBlur}>
      <div className="globe-search-in">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(-1);
            setWantOpen(true);
          }}
          onFocus={() => {
            setWantOpen(true);
          }}
          onClick={() => {
            setWantOpen(true);
          }}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeSite ? `${listId}-${index}` : undefined}
          aria-label={t('globe.find')}
          placeholder={t('globe.find')}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {open && (
        <div
          className="globe-search-pop"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
        >
          <div
            id={listId}
            className="globe-search-list"
            role="listbox"
            aria-label={t('globe.sites')}
            data-testid="globe-sites"
            hidden={results.length === 0}
          >
            {results.map((s, i) => (
              <button
                key={s.projectId}
                type="button"
                tabIndex={-1}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                className="globe-search-site"
                data-tone={s.issues.open > 0 ? 'attention' : 'clear'}
                data-active={i === index ? 'true' : undefined}
                aria-selected={s.projectId === selected}
                onPointerMove={() => {
                  setActive(i);
                  light(s.projectId);
                }}
                onPointerLeave={() => {
                  light(null);
                }}
                onClick={() => {
                  pick(s);
                }}
              >
                <span className="globe-dot" aria-hidden="true" />
                <span className="name">{s.name}</span>
                <SiteFacts site={s} />
              </button>
            ))}
          </div>
          {results.length === 0 && (
            <p className="globe-search-none" role="status">
              {t('globe.findNone')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
