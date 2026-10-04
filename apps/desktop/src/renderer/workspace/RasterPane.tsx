import type { Layer } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
export function RasterView({ projectId, layer }: { projectId: string; layer: RasterLayer }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const drag = useRef<{ id: number; x: number; y: number; view: View } | null>(null);
  const url = useCallback((path: string) => assetUrl(projectId, { path }), [projectId]);

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
    if (src && el && !view && el.clientWidth > 0) setView(fit(src.size, el));
  }, [src, view, box]);

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
  }, []);

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
    </div>
  );
}
