import type { Layer } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { isChangeHeatMap } from '@aio/maps';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChangeLegend } from './MapSwipe';
import { fromLinked, placement, rasterLink, toLinked, type LinkedView } from './rasterLink';
import {
  levelFor,
  parsePyramid,
  pyramidSize,
  tilePath,
  visibleTiles,
  type PyramidLevel,
} from './splitModel';

type RasterLayer = Extract<Layer, { kind: 'raster' }>;

interface View {
  /** Screen pixels per finest-level pixel. */
  scale: number;
  x: number;
  y: number;
}

interface Source {
  levels: PyramidLevel[] | null;
  /** A single image (format `image`). */
  image: string | null;
  size: { width: number; height: number };
}

const ZOOM = 1.15;

/** A shared view set by the other pane of this project (`link` is `<project>:<side>`). */
function othersView(lv: LinkedView | null, link: string | null): lv is LinkedView {
  if (!lv || !link || lv.by === link) return false;
  return lv.by.slice(0, lv.by.lastIndexOf(':')) === link.slice(0, link.lastIndexOf(':'));
}

function fit(size: Source['size'], el: HTMLElement): View {
  const scale = Math.min(el.clientWidth / size.width, el.clientHeight / size.height) * 0.96;
  return {
    scale,
    x: (el.clientWidth - size.width * scale) / 2,
    y: (el.clientHeight - size.height * scale) / 2,
  };
}

/**
 * A raster layer (ortho, plan) as a flat image to pan and zoom: wheel zooms at the pointer, drag
 * pans, double-click fits. Tile pyramids load the level that matches the zoom, only where seen.
 */
export function RasterView({
  projectId,
  layer,
  link: side = null,
}: {
  projectId: string;
  layer: RasterLayer;
  /** Pan and zoom with the other ortho pane (two survey dates): this pane's id, or null. */
  link?: string | null;
}) {
  const t = useT();
  // a view shared in another project is not this project's
  const link = side ? `${projectId}:${side}` : null;
  const host = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setViewState] = useState<View | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const drag = useRef<{ id: number; x: number; y: number; view: View } | null>(null);
  const url = useCallback((path: string) => assetUrl(projectId, { path }), [projectId]);
  const place = useMemo(
    () => (src ? placement(src.size, layer.corners) : null),
    [src, layer.corners],
  );
  // a view the person made is shared with the linked pane; one taken from it is not sent back
  const fromLink = useRef(false);
  const setView = useCallback((next: View | null | ((v: View | null) => View | null)) => {
    fromLink.current = false;
    setViewState(next);
  }, []);
  useEffect(() => {
    const el = host.current;
    if (!link || !view || !place || fromLink.current || !el || el.clientWidth < 1) return;
    // the pane's size now (the observed size may lag a layout change)
    const size = { width: el.clientWidth, height: el.clientHeight };
    rasterLink.setState({ view: toLinked(view, size, place, link) });
  }, [link, view, place, box]);
  useEffect(() => {
    if (!link || !place) return;
    const apply = (lv: LinkedView | null) => {
      const el = host.current;
      if (!othersView(lv, link) || !el || el.clientWidth < 1) return;
      const next = fromLinked(lv, { width: el.clientWidth, height: el.clientHeight }, place);
      if (!next) return;
      fromLink.current = true;
      setViewState(next);
    };
    apply(rasterLink.getState().view);
    return rasterLink.subscribe((s) => {
      apply(s.view);
    });
  }, [link, place]);

  // Read the tile index, or the single image's size.
  useEffect(() => {
    // one view per layer (the parent keys it), so there is nothing to reset here
    let live = true;
    const path = 'path' in layer.src ? layer.src.path : null;
    if (!path) {
      queueMicrotask(() => {
        setError('unsupported source');
      });
      return;
    }
    if (layer.format === 'kit-pyramid') {
      fetch(url(path))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((json: unknown) => {
          const levels = parsePyramid(json);
          if (!live) return;
          if (!levels) setError('no levels');
          else setSrc({ levels, image: null, size: pyramidSize(levels) });
        })
        .catch((e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e));
        });
    } else {
      const img = new Image();
      img.onload = () => {
        if (live)
          setSrc({
            levels: null,
            image: img.src,
            size: { width: img.naturalWidth, height: img.naturalHeight },
          });
      };
      img.onerror = () => {
        if (live) setError('image');
      };
      img.src = url(path);
    }
    return () => {
      live = false;
    };
  }, [layer, url]);

  // Track the pane size; fit once the source is known.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setBox({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = host.current;
    if (!src || !el || view || el.clientWidth < 1) return;
    // a linked pane opens on the other pane's view
    const lv = link && place ? rasterLink.getState().view : null;
    const shared =
      othersView(lv, link) && place
        ? fromLinked(lv, { width: el.clientWidth, height: el.clientHeight }, place)
        : null;
    if (shared) {
      fromLink.current = true;
      setViewState(shared);
    } else setView(fit(src.size, el));
  }, [src, view, box, setView, link, place]);

  // Wheel zoom at the pointer (passive listeners cannot cancel the page scroll).
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const k = Math.pow(ZOOM, -e.deltaY / (e.ctrlKey ? 20 : 100));
      setView((v) =>
        v
          ? {
              scale: Math.min(64, Math.max(1e-4, v.scale * k)),
              x: px - (px - v.x) * k,
              y: py - (py - v.y) * k,
            }
          : v,
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [setView]);

  const tiles = useMemo(() => {
    if (!src?.levels || !view) return [];
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const seen = {
      x: -view.x / view.scale,
      y: -view.y / view.scale,
      width: box.width / view.scale,
      height: box.height / view.scale,
    };
    const coarse = src.levels[0];
    const fine = levelFor(src.levels, view.scale * dpr);
    const out: { key: string; src: string; left: number; top: number; f: number }[] = [];
    for (const level of coarse === fine ? [coarse] : [coarse, fine]) {
      if (!level) continue;
      const f = src.size.width / (level.cols * level.tileSize);
      for (const { x, y } of visibleTiles(level, src.size, seen))
        out.push({
          key: `${String(level.z)}/${String(x)}/${String(y)}`,
          src: url(tilePath(level, x, y)),
          left: x * level.tileSize * f,
          top: y * level.tileSize * f,
          f,
        });
    }
    return out;
  }, [src, view, box, url]);

  return (
    <div
      ref={host}
      className="raster-view"
      data-testid="raster-view"
      onPointerDown={(e) => {
        if (e.button !== 0 || !view) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, view };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d?.id !== e.pointerId) return;
        setView({ ...d.view, x: d.view.x + e.clientX - d.x, y: d.view.y + e.clientY - d.y });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => {
        const el = host.current;
        if (src && el) setView(fit(src.size, el));
      }}
    >
      {view && src && (
        <div
          className="raster-plane"
          style={{
            width: src.size.width,
            height: src.size.height,
            transform: `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.scale)})`,
          }}
        >
          {src.image && <img src={src.image} alt="" draggable={false} />}
          {tiles.map((tile) => (
            <img
              key={tile.key}
              src={tile.src}
              alt=""
              draggable={false}
              style={{
                left: tile.left,
                top: tile.top,
                transform: tile.f === 1 ? undefined : `scale(${String(tile.f)})`,
              }}
            />
          ))}
        </div>
      )}
      {!src && !error && <p className="pane-empty">{t('stage.pane.loading')}</p>}
      {error && (
        <p className="pane-empty">
          <Icon name="warn" size={14} /> {t('stage.pane.rasterError', { error })}
        </p>
      )}
      {view && src && (
        <button
          type="button"
          className="btn icon sm raster-fit overlay-box"
          title={t('stage.pane.fit')}
          aria-label={t('stage.pane.fit')}
          onClick={() => {
            const el = host.current;
            if (el) setView(fit(src.size, el));
          }}
        >
          <Icon name="maximize" size={14} />
        </button>
      )}
      {/* a change heat map (M8): its colours in metres or as a score */}
      {isChangeHeatMap(layer) && <ChangeLegend layer={layer} />}
    </div>
  );
}
