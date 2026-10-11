import type { GlobeSite } from '@aio/schema';
import { Icon, t, useT } from '@aio/ui';
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import './globe-search.css';
import { SiteFacts } from './SiteFacts';

/** The sites whose name holds the query, in the order given. A blank query keeps them all. */
export function filterSites(sites: readonly GlobeSite[], query: string): GlobeSite[] {
  const needle = query.trim().toLowerCase();
  return sites.filter((s) => s.name.toLowerCase().includes(needle));
}

/** What the screen may ask of the field. */
export interface GlobeSearchHandle {
  /** Put the keyboard in the field, its list left shut: the person did not ask for the list. */
  focus(): void;
}

export interface GlobeSearchProps {
  sites: readonly GlobeSite[];
  /** The selected site's id: its option reads as selected. */
  selected: string | null;
  onPick: (site: GlobeSite) => void;
  /** The site whose chip to light on the map (the option under the pointer or the keyboard). */
  onLight: (projectId: string | null) => void;
  /** For the screen to put the keyboard back in the field. */
  handle?: Ref<GlobeSearchHandle>;
}

/** The Globe's "Find a site" field: focus lists every site, typing filters, a pick opens its card. */
export function GlobeSearch({ sites, selected, onPick, onLight, handle }: GlobeSearchProps) {
  useT();
  const [query, setQuery] = useState('');
  const [wantOpen, setWantOpen] = useState(false);
  // -1: nothing chosen yet, so opening the list lights no chip
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // the focus the screen gives back (a card closed) opens no list, unlike the person's own
  const given = useRef(false);
  useImperativeHandle(
    handle,
    () => ({
      focus: () => {
        given.current = true;
        inputRef.current?.focus();
        given.current = false;
      },
    }),
    [],
  );

  const results = useMemo(() => filterSites(sites, query), [sites, query]);
  const open = wantOpen && sites.length > 0;
  // the list itself is there only while something matches; the no-match words stand in its place
  const listed = open && results.length > 0;
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

  // closing forgets the row that was chosen, so reopening never picks it by surprise
  const close = () => {
    setActive(-1);
    setWantOpen(false);
  };

  // a press anywhere else on the page closes the list
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);

  const pick = (site: GlobeSite | undefined) => {
    if (!site) return;
    setQuery('');
    close();
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
      close();
    }
  };

  // Tab to another control closes the list; a press on an option must not (it keeps the focus)
  const onBlur = (e: FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget)) close();
  };

  return (
    <div ref={rootRef} className="globe-search" onBlur={onBlur}>
      <div className="globe-search-in">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(-1);
            setWantOpen(true);
          }}
          onFocus={() => {
            if (!given.current) setWantOpen(true);
          }}
          onClick={() => {
            setWantOpen(true);
          }}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded={listed}
          aria-controls={listed ? listId : undefined}
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
          {listed && (
            <div
              id={listId}
              className="globe-search-list"
              role="listbox"
              aria-label={t('globe.sites')}
              data-testid="globe-sites"
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
                    setActive(-1);
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
          )}
          {/* mounted before it has words, so a screen reader announces them when they arrive */}
          <p className="globe-search-none" role="status">
            {results.length === 0 ? t('globe.findNone') : ''}
          </p>
        </div>
      )}
    </div>
  );
}
