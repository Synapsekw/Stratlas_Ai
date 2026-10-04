/**
 * The review editor: one photo or video frame with its detections, pan and zoom, and the
 * annotator's drawing layer to draw new boxes and polygons or move, resize and reshape the
 * current one (double-click an edge adds a vertex, Shift-click a vertex removes it).
 */
import { AnnotateStyles, DrawLayer, type ImageTool, type ShapeItem } from '@aio/annotate';
import type { Detection, DetectionSource } from '@aio/annotate/detections';
import { imageGeometry } from '@aio/annotate';
import type { ImageGeom, Layer } from '@aio/schema';
import { useT } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const { ZOOM_STEP, fitView, zoomAround } = imageGeometry;
type Size = imageGeometry.Size;
type ViewTransform = imageGeometry.ViewTransform;

export interface EditorShape {
  detection: Detection;
  color: string;
  label: string;
}

function mediaUrl(
  projectId: string,
  layers: readonly Layer[],
  source: DetectionSource,
): string | null {
  const layer = layers.find((l) => l.id === source.layer);
  try {
    if (source.kind === 'photo') {
      const p =
        layer?.kind === 'photos' ? layer.items.find((x) => x.id === source.photo) : undefined;
      return p ? assetUrl(projectId, p.src) : null;
    }
    return layer?.kind === 'video' ? assetUrl(projectId, layer.src) : null;
  } catch {
    return null;
  }
}

export function ReviewEditor({
  projectId,
  layers,
  source,
  shapes,
  currentId,
  tool,
  readOnly,
  fitSignal,
  onCreate,
  onEdit,
  onSelect,
}: {
  projectId: string;
  layers: readonly Layer[];
  source: DetectionSource;
  shapes: readonly EditorShape[];
  currentId: string | null;
  tool: ImageTool;
  readOnly: boolean;
  /** Bumped by the screen (F key) to fit the image again. */
  fitSignal: number;
  onCreate: (geom: ImageGeom, size: Size) => void;
  onEdit: (id: string, geom: ImageGeom, size: Size) => void;
  onSelect: (id: string | null) => void;
}) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement>(null);
  const url = mediaUrl(projectId, layers, source);
  const frameT = source.kind === 'frame' ? source.t : null;
  const [loaded, setLoaded] = useState<{ key: string; size: Size | null } | null>(null);
  const key = `${url ?? ''}#${String(frameT ?? '')}`;
  const natural = loaded?.key === key ? loaded.size : null;
  const failed = loaded?.key === key && loaded.size === null;
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });

  const fit = useCallback(() => {
    const el = stageRef.current;
    if (!el || !natural) return;
    setView(fitView(natural, { width: el.clientWidth, height: el.clientHeight }));
  }, [natural]);

  useEffect(() => {
    fit();
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [fit, fitSignal]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.pow(ZOOM_STEP, -e.deltaY / (e.ctrlKey ? 20 : 100));
      setView((v) => zoomAround(v, { x: e.clientX - r.left, y: e.clientY - r.top }, factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  const items = useMemo<ShapeItem[]>(
    () =>
      shapes.map((s) => {
        const selected = s.detection.id === currentId;
        return {
          key: s.detection.id,
          geom: s.detection.geom,
          color: s.color,
          label: s.label,
          selected,
          editable: selected && !readOnly && s.detection.status !== 'accepted',
        };
      }),
    [shapes, currentId, readOnly],
  );

  const style = {
    transform: `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.scale)})`,
    ...(natural ? { width: natural.width, height: natural.height, maxWidth: 'none' } : {}),
  };

  return (
    <div ref={stageRef} className="ann-stage det-stage" data-testid="det-editor">
      <AnnotateStyles />
      {!url && <div className="ann-empty">{t('det.editor.missing')}</div>}
      {failed && <div className="ann-empty">{t('det.editor.failed')}</div>}
      {url && source.kind === 'photo' && (
        <img
          className="ann-img"
          src={url}
          alt=""
          draggable={false}
          style={style}
          onLoad={(e) => {
            const im = e.currentTarget;
            setLoaded({ key, size: { width: im.naturalWidth, height: im.naturalHeight } });
          }}
          onError={() => {
            setLoaded({ key, size: null });
          }}
        />
      )}
      {url && frameT !== null && (
        <video
          key={key}
          className="ann-img det-frame"
          src={url}
          muted
          preload="auto"
          style={style}
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = frameT;
          }}
          onSeeked={(e) => {
            const v = e.currentTarget;
            setLoaded({ key, size: { width: v.videoWidth, height: v.videoHeight } });
          }}
          onError={() => {
            setLoaded({ key, size: null });
          }}
        />
      )}
      {natural && (
        <DrawLayer
          view={view}
          size={natural}
          tool={readOnly ? 'select' : tool}
          shapes={items}
          onCreate={(geom) => {
            if (!readOnly) onCreate(geom, natural);
          }}
          onEdit={(id, geom) => {
            onEdit(id, geom, natural);
          }}
          onVertexInsert={(id, geom) => {
            onEdit(id, geom, natural);
          }}
          onVertexRemove={(id, geom) => {
            onEdit(id, geom, natural);
          }}
          onSelect={onSelect}
          onPan={(dx, dy) => {
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
          }}
        />
      )}
      <div className="ann-zoom">{Math.round(view.scale * 100)}%</div>
    </div>
  );
}
