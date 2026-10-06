/**
 * The user guide inside the app (F1, the palette, the title bar "?" and the "?" next to
 * settings and tools): the bundled chapters with a contents list and a search box. Offline.
 */
import './help.css';
import { Icon, t, useFocusTrap, useT } from '@aio/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { anchorId, GuideArticle } from './GuideArticle';
import { guideChapters } from './guide';
import { buildIndex, search } from './search';
import { help, useHelp, type HelpTopic } from './store';

export function HelpPanel() {
  useT();
  const open = useHelp((s) => s.open);
  const topic = useHelp((s) => s.topic);
  const seq = useHelp((s) => s.seq);
  const chapters = guideChapters();
  const index = useMemo(() => buildIndex(chapters), [chapters]);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState<HelpTopic>({ chapter: chapters[0]?.slug ?? '' });
  const [scrollSeq, setScrollSeq] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Tab stays inside the guide while it is open (Esc is handled below: it clears the search first).
  useFocusTrap(panel, open, { initial: () => searchBox.current });

  const hits = useMemo(() => search(index, query), [index, query]);
  const chapter = chapters.find((c) => c.slug === current.chapter) ?? chapters[0];

  const go = (next: HelpTopic) => {
    setCurrent(next);
    setScrollSeq((n) => n + 1);
  };

  // every open (or a new topic while open): go to the asked-for topic
  const [seen, setSeen] = useState(-1);
  if (open && seq !== seen) {
    setSeen(seq);
    if (topic) {
      setCurrent(topic);
      setScrollSeq((n) => n + 1);
    }
  }

  // put the cursor in the search box, and give focus back on close
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement;
    searchBox.current?.focus();
    return () => {
      const el = returnFocus.current;
      if (el instanceof HTMLElement) el.focus();
    };
  }, [open]);

  // Esc clears the search, then closes; caught first so tools under the panel never see it
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery('');
      else help.getState().closeHelp();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, query]);

  // scroll to the heading (or the top) after the chapter renders
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const target = current.anchor
      ? el.querySelector(`#${CSS.escape(anchorId(current.chapter, current.anchor))}`)
      : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else el.scrollTop = 0;
    // a link that took us here is gone with its chapter: keep focus inside the guide
    if (!el.contains(document.activeElement) && document.activeElement !== searchBox.current)
      el.focus({ preventScroll: true });
  }, [current, scrollSeq]);

  if (!open || !chapter) return null;

  const close = () => {
    help.getState().closeHelp();
  };

  return (
    <div
      className="help-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('help.title')}
      >
        <aside className="help-side">
          <div className="help-head">
            <b>{t('help.title')}</b>
          </div>
          <label className="help-search">
            <Icon name="search" size={14} />
            <input
              ref={searchBox}
              type="search"
              value={query}
              placeholder={t('help.search')}
              aria-label={t('help.search')}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                const first = hits[0];
                if (e.key === 'Enter' && first) {
                  go({ chapter: first.chapter, anchor: first.anchor });
                }
              }}
            />
          </label>
          {query.trim() ? (
            <nav className="help-results" aria-label={t('help.results')}>
              <p className="help-count" role="status">
                {hits.length === 0
                  ? t('help.noResults', { query: query.trim() })
                  : t('help.count', { count: hits.length })}
              </p>
              {hits.map((h) => (
                <button
                  key={`${h.chapter}#${h.anchor}`}
                  type="button"
                  className="help-hit"
                  onClick={() => {
                    go({ chapter: h.chapter, anchor: h.anchor });
                  }}
                >
                  <span className="help-hit-title">{h.title}</span>
                  <span className="help-hit-chapter">{h.chapterTitle}</span>
                  <span className="help-hit-text">{h.snippet}</span>
                </button>
              ))}
            </nav>
          ) : (
            <nav className="help-toc" aria-label={t('help.contents')}>
              {chapters.map((c, i) => (
                <button
                  key={c.slug}
                  type="button"
                  aria-current={c.slug === chapter.slug}
                  onClick={() => {
                    go({ chapter: c.slug });
                  }}
                >
                  <span className="help-num">{i + 1}</span>
                  {c.title}
                </button>
              ))}
            </nav>
          )}
        </aside>
        <div className="help-main">
          <div className="help-bar">
            <span className="help-crumb">{chapter.title}</span>
            <button
              type="button"
              className="help-close"
              onClick={close}
              aria-label={t('help.close')}
              title={t('help.close')}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <article ref={body} className="help-body guide" tabIndex={-1}>
            <GuideArticle chapter={chapter.slug} blocks={chapter.blocks} onNavigate={go} />
          </article>
        </div>
      </div>
    </div>
  );
}

/** A small "?" that opens the guide at a topic. */
export function HelpLink({ topic, label }: { topic: HelpTopic; label?: string }) {
  useT();
  const text = label ?? t('help.topic');
  return (
    <button
      type="button"
      className="help-link"
      aria-label={text}
      title={text}
      data-help={`${topic.chapter}${topic.anchor ? `#${topic.anchor}` : ''}`}
      onClick={() => {
        help.getState().openHelp(topic);
      }}
    >
      ?
    </button>
  );
}
