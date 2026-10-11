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
  /**
   * Put the keyboard in the field and open its list with these sites only (sites the Globe draws
   * as one chip and cannot part). The list is the whole library again once the person types,
   * picks or closes it.
   */
  list(projectIds: readonly string[]): void;
}

export interface GlobeSearchProps {
  sites: readonly GlobeSite[];
  /** The selected site's id: its option reads as selected. */
  selected: string | null;
  onPick: (site: GlobeSite) => void;
  /** The site whose chip to light on the map (the option under the pointer or the keyboard). */
  onLight: (projectId: string | null) => void;
  /** Esc pressed in the field with its list shut: the screen's to answer (its card is open). */
  onEscape?: (() => void) | undefined;
  /** For the screen to put the keyboard back in the field. */
  handle?: Ref<GlobeSearchHandle>;
}

/** The Globe's "Find a site" field: focus lists every site, typing filters, a pick opens its card. */
export function GlobeSearch({
  sites,
  selected,
  onPick,
  onLight,
  onEscape,
  handle,
}: GlobeSearchProps) {
  useT();
  const [query, setQuery] = useState('');
  const [wantOpen, setWantOpen] = useState(false);
  // -1: nothing chosen yet, so opening the list lights no chip
  const [active, setActive] = useState(-1);
  // the sites the screen asked to list alone (ids); null: the whole library
  const [only, setOnly] = useState<readonly string[] | null>(null);
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
      list: (projectIds) => {
        setOnly([...projectIds]);
        setQuery('');
        setActive(-1);
        setWantOpen(true);
        inputRef.current?.focus();
      },
    }),
    [],
  );

  // The window went away with the keyboard resting in the field (after a pick, or a card closed
  // with the keyboard). When it is activated again the browser tells the field it has the focus
  // once more, and the person asked for no list: that one focus opens nothing.
  const resting = useRef(false);
  useEffect(() => {
    const left = () => {
      resting.current = document.activeElement === inputRef.current;
    };
    window.addEventListener('blur', left);
    return () => {
      window.removeEventListener('blur', left);
    };
  }, []);

  const results = useMemo(
    () =>
      only && query === ''
        ? sites.filter((s) => only.includes(s.projectId))
        : filterSites(sites, query),
    [sites, query, only],
  );
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

  // closing forgets the row that was chosen, so reopening never picks it by surprise, and the
  // sites the screen asked for: the next list is the whole library
  const close = () => {
    setActive(-1);
    setOnly(null);
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
    } else if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      onEscape();
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
            // typing searches the whole library
            setOnly(null);
            setWantOpen(true);
          }}
          onFocus={() => {
            const back = resting.current;
            resting.current = false;
            if (!given.current && !back) setWantOpen(true);
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
