/**
 * Contact sheet of the review: every photo (and every video frame with detections) as a tile with
 * its detections outlined and a count of the ones waiting. Virtualised: only the rows near the
 * view are in the DOM, so thousands of photos scroll smoothly; tiles use the thumbnail service.
 */
import { gridWindow, scrollToIndex, type DetectionSource } from '@aio/annotate/detections';
import type { AssetRef, ImageGeom } from '@aio/schema';
import { useT } from '@aio/ui';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { MediaThumb } from '../thumbs/Thumb';
import { frameThumb } from './prepare';

export interface SheetOutline {
  id: string;
  geom: ImageGeom;
  color: string;
  size: [number, number];
  status: 'draft' | 'accepted' | 'rejected';
}

export interface SheetItem {
  key: string;
  source: DetectionSource;
  label: string;
  photo?: AssetRef;
  /** aio:// URL of the video, for frame tiles. */
  video?: string;
  draft: number;
  accepted: number;
  rejected: number;
  outlines: SheetOutline[];
}

const MIN_TILE = 132;
const GAP = 8;
const CAPTION = 22;

function Outline({ o }: { o: SheetOutline }) {
  const style = { ['--c' as string]: o.color };
  const g = o.geom;
  const cls = `det-ol ${o.status}`;
  if (g.type === 'box')
    return <rect className={cls} style={style} x={g.x} y={g.y} width={g.w} height={g.h} />;
  if (g.type === 'rotbox') {
    const cx = g.x + g.w / 2;
    const cy = g.y + g.h / 2;
    return (
      <rect
        className={cls}
        style={style}
        x={g.x}
        y={g.y}
        width={g.w}
        height={g.h}
        transform={`rotate(${String(g.angleDeg)} ${String(cx)} ${String(cy)})`}
      />
    );
  }
  if (g.type === 'polygon')
    return (
      <polygon className={cls} style={style} points={g.points.map((p) => p.join(',')).join(' ')} />
    );
  if (g.type === 'point')
    return (
      <circle className={cls} style={style} cx={g.x} cy={g.y} r={Math.max(6, o.size[0] / 120)} />
    );
  return null;
}

function FrameTile({ url, t }: { url: string; t: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    frameThumb(url, t).then(
      (s) => {
        if (live) setSrc(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url, t]);
  return <div className="m-thumb">{src && <img src={src} alt="" draggable={false} />}</div>;
}

export function ContactSheet({
  projectId,
  items,
  currentKey,
  selected,
  onOpen,
  onSelect,
}: {
  projectId: string;
  items: readonly SheetItem[];
  currentKey: string | null;
  selected: ReadonlySet<string>;
  onOpen: (key: string) => void;
  /** Ctrl or Cmd click toggles a tile; Shift click selects the range from the last one. */
  onSelect: (key: string, mode: 'toggle' | 'range') => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ width: 600, height: 600, scrollTop: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setView({ width: el.clientWidth - 16, height: el.clientHeight, scrollTop: el.scrollTop });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const w = gridWindow({
    count: items.length,
    width: view.width,
    height: view.height,
    scrollTop: view.scrollTop,
    minTile: MIN_TILE,
    gap: GAP,
    caption: CAPTION,
  });

  // Keep the tile being reviewed in view (keyboard stepping moves through photos).
  const at = currentKey ? items.findIndex((i) => i.key === currentKey) : -1;
  useEffect(() => {
    const el = ref.current;
    if (!el || at < 0) return;
    const top = scrollToIndex(w, at, el.scrollTop, el.clientHeight);
    if (top !== el.scrollTop) el.scrollTop = top;
    // w changes with every scroll; only a new current tile or column count should scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, w.cols]);

  const click = (e: MouseEvent, key: string) => {
    if (e.ctrlKey || e.metaKey) onSelect(key, 'toggle');
    else if (e.shiftKey) onSelect(key, 'range');
    else onOpen(key);
  };

  const shown = items.slice(w.start, w.end);
  return (
    <div
      ref={ref}
      className="det-sheet"
      data-thumb-root
      data-testid="det-sheet"
      onScroll={(e) => {
        const el = e.currentTarget;
        setView((v) => ({ ...v, scrollTop: el.scrollTop }));
      }}
    >
      {items.length === 0 ? (
        <p className="det-empty">{t('det.sheet.empty')}</p>
      ) : (
        <div className="det-sheet-in" style={{ height: w.totalHeight }}>
          {shown.map((item, i) => {
            const index = w.start + i;
            const row = Math.floor(index / w.cols);
            const col = index % w.cols;
            const on = item.key === currentKey;
            const picked = selected.has(item.key);
            const [vw, vh] = item.outlines[0]?.size ?? [1, 1];
            return (
              <button
                key={item.key}
                type="button"
                className={`det-tile${on ? ' on' : ''}${picked ? ' picked' : ''}`}
                data-key={item.key}
                aria-pressed={picked}
                aria-current={on ? 'true' : undefined}
                title={item.label}
                style={{
                  width: w.tile,
                  top: row * w.rowHeight,
                  insetInlineStart: col * (w.tile + GAP),
                }}
                onClick={(e) => {
                  click(e, item.key);
                }}
              >
                <div className="det-pic" style={{ height: w.tile }}>
                  {item.photo ? (
                    <MediaThumb projectId={projectId} asset={item.photo} icon="photo" />
                  ) : item.video && item.source.kind === 'frame' ? (
                    <FrameTile url={item.video} t={item.source.t} />
                  ) : null}
                  {item.outlines.length > 0 && (
                    <svg
                      className="det-ols"
                      viewBox={`0 0 ${String(vw)} ${String(vh)}`}
                      preserveAspectRatio="xMidYMid meet"
                      aria-hidden="true"
                    >
                      {item.outlines.map((o) => (
                        <Outline key={o.id} o={o} />
                      ))}
                    </svg>
                  )}
                  {item.draft > 0 && <span className="det-badge mono">{item.draft}</span>}
                  {picked && <span className="det-pick" aria-hidden="true" />}
                </div>
                <span className="det-cap mono">
                  {item.label}
                  {item.accepted > 0 && <i className="ok">{` ${String(item.accepted)}✓`}</i>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
