import { Icon, matchShortcut, shortcutHint } from '@aio/ui';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { openPdf } from './pdf';
import {
  clampPage,
  fitWidthScale,
  nextZoom,
  pageAtOffset,
  searchPages,
  type SearchHit,
} from './pdfModel';

const GAP = 16;
const MARGIN = 48;
const THUMB_W = 112;

interface Size {
  w: number;
  h: number;
}

/** Mark text-layer spans that contain the query. */
function markHits(layer: HTMLElement, query: string): void {
  const q = query.trim().toLowerCase();
  for (const span of layer.querySelectorAll('span')) {
    span.classList.toggle('hit', q !== '' && span.textContent.toLowerCase().includes(q));
  }
}

/** One page: a placeholder of the right size, drawn only while near the viewport. */
function PageView(props: {
  doc: PDFDocumentProxy;
  n: number;
  size: Size;
  scale: number;
  root: HTMLElement | null;
  query: string;
  current: boolean;
}) {
  const { doc, n, size, scale, root, query } = props;
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  /** Scale the canvas was last drawn at. */
  const [drawnAt, setDrawnAt] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setNear(e.isIntersecting);
      },
      { root, rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [root]);

  useEffect(() => {
    if (!near) return;
    const run = { live: true };
    const alive = () => run.live;
    let task: RenderTask | null = null;
    let layer: TextLayer | null = null;
    void doc.getPage(n).then(async (page) => {
      const c = canvas.current;
      const t = text.current;
      if (!run.live || !c || !t) return;
      const dpr = Math.max(1, window.devicePixelRatio);
      const viewport = page.getViewport({ scale: scale * dpr });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      task = page.render({ canvas: c, viewport });
      try {
        await task.promise;
      } catch {
        return;
      }
      if (!alive()) return;
      setDrawnAt(scale);
      t.replaceChildren();
      t.style.setProperty('--total-scale-factor', String(scale));
      t.style.setProperty('--scale-factor', String(scale));
      layer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: t,
        viewport: page.getViewport({ scale }),
      });
      await layer.render().catch(() => undefined);
      if (alive()) markHits(t, query);
    });
    return () => {
      run.live = false;
      task?.cancel();
      layer?.cancel();
    };
    // query highlighting has its own effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, n, near, scale]);

  useEffect(() => {
    if (text.current) markHits(text.current, query);
  }, [query]);

  return (
    <div
      ref={box}
      className={`pdfv-page${props.current ? ' current' : ''}`}
      data-page={n}
      style={{ width: size.w * scale, height: size.h * scale }}
    >
      {near && <canvas ref={canvas} style={{ width: '100%', height: '100%' }} />}
      {near && <div ref={text} className="textLayer" />}
      {(!near || drawnAt !== scale) && <span className="pdfv-loading mono">{n}</span>}
    </div>
  );
}

/** A thumbnail, drawn once when it scrolls into the rail. */
function Thumb(props: {
  doc: PDFDocumentProxy;
  n: number;
  size: Size;
  root: HTMLElement | null;
  current: boolean;
  onPick: (n: number) => void;
}) {
  const { doc, n, size, root, current } = props;
  const btn = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  const scale = THUMB_W / size.w;

  useEffect(() => {
    const el = btn.current;
    if (!el || !root || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { root, rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [root, seen]);

  useEffect(() => {
    if (!seen) return;
    let task: RenderTask | null = null;
    const run = { live: true };
    void doc.getPage(n).then((page) => {
      const c = canvas.current;
      if (!run.live || !c) return;
      const viewport = page.getViewport({ scale: scale * Math.max(1, window.devicePixelRatio) });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      task = page.render({ canvas: c, viewport });
      task.promise.catch(() => undefined);
    });
    return () => {
      run.live = false;
      task?.cancel();
    };
  }, [doc, n, seen, scale]);

  useEffect(() => {
    if (current) btn.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <button
      ref={btn}
      type="button"
      className={`pdfv-thumb${current ? ' current' : ''}`}
      aria-label={`Page ${String(n)}`}
      aria-current={current ? 'page' : undefined}
      onClick={() => {
        props.onPick(n);
      }}
    >
      <span className="pdfv-thumb-img" style={{ width: THUMB_W, height: size.h * scale }}>
        {seen && <canvas ref={canvas} />}
      </span>
      <span className="mono">{n}</span>
    </button>
  );
}

export interface PdfViewerProps {
  /** aio:// URL of the PDF. */
  url: string;
  title: string;
}

/** In-app PDF viewer (PRD REV-5): thumbnails, page navigation, zoom, search, lazy pages. */
export function PdfViewer({ url, title }: PdfViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [rail, setRail] = useState(true);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [hitIndex, setHitIndex] = useState(0);
  const [searching, setSearching] = useState<string | null>(null);
  /** The scroll container: state for the page observers, a ref for scrolling. */
  const [main, setMain] = useState<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const bindMain = useCallback((el: HTMLDivElement | null) => {
    mainRef.current = el;
    setMain(el);
  }, []);
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const texts = useRef<string[] | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // One viewer per URL (the parent keys it), so there is no state to reset here.
    const { promise, cancel } = openPdf(url);
    const run = { live: true };
    promise.then(
      async (d) => {
        const all = await Promise.all(
          Array.from({ length: d.numPages }, (_, i) =>
            d.getPage(i + 1).then((p) => {
              const v = p.getViewport({ scale: 1 });
              return { w: v.width, h: v.height };
            }),
          ),
        );
        if (!run.live) return;
        setSizes(all);
        setDoc(d);
      },
      (e: unknown) => {
        if (run.live) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      run.live = false;
      cancel();
    };
  }, [url]);

  useEffect(() => {
    if (!main) return;
    const ro = new ResizeObserver(() => {
      setWidth(main.clientWidth);
    });
    ro.observe(main);
    return () => {
      ro.disconnect();
    };
  }, [main]);

  const maxW = useMemo(() => Math.max(1, ...sizes.map((s) => s.w)), [sizes]);
  const scale = zoom === 'fit' ? Math.min(4, fitWidthScale(maxW, width, MARGIN)) : zoom;
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = GAP;
    for (const s of sizes) {
      out.push(y);
      y += s.h * scale + GAP;
    }
    return out;
  }, [sizes, scale]);

  const goTo = useCallback(
    (n: number) => {
      const p = clampPage(n, sizes.length);
      setPage(p);
      setPageInput(String(p));
      if (mainRef.current) mainRef.current.scrollTop = (tops[p - 1] ?? 0) - GAP;
    },
    [sizes.length, tops],
  );

  // Keep the page in view when the zoom changes.
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = (tops[pageRef.current - 1] ?? 0) - GAP;
  }, [tops]);

  const onScroll = () => {
    const el = mainRef.current;
    if (!el) return;
    const p = pageAtOffset(tops, el.scrollTop + el.clientHeight * 0.3);
    if (p !== page) {
      setPage(p);
      setPageInput(String(p));
    }
  };

  const runSearch = async (q: string) => {
    if (!doc) return;
    setActive(q);
    if (!q.trim()) {
      setHits(null);
      return;
    }
    if (!texts.current) {
      const out: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        if (i % 10 === 1) setSearching(`Reading page ${String(i)} of ${String(doc.numPages)}`);
        const tc = await (await doc.getPage(i)).getTextContent();
        // as pdf.js find: pieces of a line join directly, line ends become a space
        out.push(
          tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? ' ' : '') : '')).join(''),
        );
      }
      texts.current = out;
      setSearching(null);
    }
    const found = searchPages(texts.current, q);
    setHits(found);
    setHitIndex(0);
    if (found[0]) goTo(found[0].page);
  };

  const stepHit = (dir: 1 | -1) => {
    if (!hits || hits.length === 0) return;
    const i = (hitIndex + dir + hits.length) % hits.length;
    setHitIndex(i);
    const h = hits[i];
    if (h) goTo(h.page);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const typing = (e.target as HTMLElement).tagName === 'INPUT';
    const id = matchShortcut('pdf', e);
    if (id === 'pdf.find') {
      e.preventDefault();
      searchBox.current?.focus();
      searchBox.current?.select();
    } else if (typing) {
      return;
    } else if (id === 'pdf.next') {
      e.preventDefault();
      goTo(page + 1);
    } else if (id === 'pdf.prev') {
      e.preventDefault();
      goTo(page - 1);
    } else if (id === 'pdf.first') {
      e.preventDefault();
      goTo(1);
    } else if (id === 'pdf.last') {
      e.preventDefault();
      goTo(sizes.length);
    } else if (id === 'pdf.zoomIn') {
      setZoom(nextZoom(scale, 1));
    } else if (id === 'pdf.zoomOut') {
      setZoom(nextZoom(scale, -1));
    }
  };

  const count = sizes.length;
  return (
    <div className="pdfv" onKeyDown={onKey} aria-label={`PDF viewer: ${title}`}>
      <div className="pdfv-bar" role="toolbar" aria-label="PDF tools">
        <button
          type="button"
          className={`btn icon sm${rail ? ' on' : ''}`}
          title="Thumbnails"
          aria-pressed={rail}
          onClick={() => {
            setRail(!rail);
          }}
        >
          <Icon name="sidebar" size={14} />
        </button>
        <span className="pdfv-sep" />
        <button
          type="button"
          className="btn icon sm"
          title="Previous page"
          disabled={page <= 1}
          onClick={() => {
            goTo(page - 1);
          }}
        >
          <Icon name="back" size={14} />
        </button>
        <form
          className="pdfv-pageform"
          onSubmit={(e) => {
            e.preventDefault();
            goTo(Number(pageInput));
          }}
        >
          <input
            className="pdfv-pagein mono"
            aria-label="Page number"
            value={pageInput}
            onChange={(e) => {
              setPageInput(e.target.value);
            }}
            onBlur={() => {
              setPageInput(String(page));
            }}
          />
          <span className="mono muted" data-testid="pdf-page-count">
            / {count || '...'}
          </span>
        </form>
        <button
          type="button"
          className="btn icon sm"
          title="Next page"
          disabled={page >= count}
          onClick={() => {
            goTo(page + 1);
          }}
        >
          <Icon name="fwd" size={14} />
        </button>
        <span className="pdfv-sep" />
        <button
          type="button"
          className="btn icon sm"
          title="Zoom out"
          onClick={() => {
            setZoom(nextZoom(scale, -1));
          }}
        >
          <Icon name="minus" size={14} />
        </button>
        <span className="mono pdfv-zoom" data-testid="pdf-zoom">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          className="btn icon sm"
          title="Zoom in"
          onClick={() => {
            setZoom(nextZoom(scale, 1));
          }}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          className={`btn sm${zoom === 'fit' ? ' on' : ''}`}
          onClick={() => {
            setZoom('fit');
          }}
        >
          Fit width
        </button>
        <span className="pdfv-grow" />
        <form
          className="pdfv-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (hits && query === active) stepHit(1);
            else void runSearch(query);
          }}
        >
          <Icon name="search" size={14} />
          <input
            ref={searchBox}
            aria-label="Search in the PDF"
            placeholder={`Search (${shortcutHint('pdf.find')})`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                setHits(null);
                setActive('');
              }
            }}
          />
          {searching ? (
            <span className="muted pdfv-hits">{searching}</span>
          ) : hits ? (
            <span className="mono pdfv-hits" data-testid="pdf-hits">
              {hits.length === 0
                ? 'No match'
                : `${String(hitIndex + 1)} of ${String(hits.length)} pages`}
            </span>
          ) : null}
          <button
            type="button"
            className="btn icon sm"
            title="Previous match"
            disabled={!hits?.length}
            onClick={() => {
              stepHit(-1);
            }}
          >
            <Icon name="chev-d" size={14} className="flip" />
          </button>
          <button
            type="button"
            className="btn icon sm"
            title="Next match"
            disabled={!hits?.length}
            onClick={() => {
              stepHit(1);
            }}
          >
            <Icon name="chev-d" size={14} />
          </button>
        </form>
      </div>
      <div className={`pdfv-body${rail ? ' with-rail' : ''}`}>
        {rail && (
          <div className="pdfv-rail" ref={setRailEl} aria-label="Pages">
            {doc &&
              sizes.map((s, i) => (
                <Thumb
                  key={i}
                  doc={doc}
                  n={i + 1}
                  size={s}
                  root={railEl}
                  current={page === i + 1}
                  onPick={goTo}
                />
              ))}
          </div>
        )}
        <div
          className="pdfv-main"
          ref={bindMain}
          onScroll={onScroll}
          tabIndex={0}
          data-testid="pdf-pages"
        >
          {error && (
            <div className="side-empty">
              <Icon name="warn" size={20} />
              <p>This PDF could not be opened: {error}</p>
            </div>
          )}
          {!doc && !error && <div className="side-empty muted">Opening {title}...</div>}
          {doc &&
            sizes.map((s, i) => (
              <PageView
                key={i}
                doc={doc}
                n={i + 1}
                size={s}
                scale={scale}
                root={main}
                query={active}
                current={page === i + 1}
              />
            ))}
        </div>
        {hits && hits.length > 0 && (
          <ol className="pdfv-results" aria-label="Search results">
            {hits.map((h, i) => (
              <li key={h.page}>
                <button
                  type="button"
                  className={i === hitIndex ? 'on' : ''}
                  onClick={() => {
                    setHitIndex(i);
                    goTo(h.page);
                  }}
                >
                  <span className="mono">p. {h.page}</span>
                  <span className="snip">{h.snippet}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
