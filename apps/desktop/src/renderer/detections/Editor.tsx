/**
 * The review editor: one photo or video frame with its detections, pan and zoom, and the
 * annotator's drawing layer to draw new boxes and polygons or move, resize and reshape the
 * current one (double-click an edge adds a vertex, Shift-click a vertex removes it).
 */
import { AnnotateStyles, DrawLayer, type ImageTool, type ShapeItem } from '@aio/annotate';
import {
  clampGeom,
  scaleGeom,
  sourceKey,
  type Detection,
  type DetectionSource,
} from '@aio/annotate/detections';
import { frameLayerSrc, splitWrapKey, wrapKey, wrapParts } from './frameMedia';
import { noteImageSize } from './store';
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
  /** The chip text: readable class and confidence ("No safety jacket 88%"). */
  label: string;
  /** The tooltip: the class as the model or the project names it. */
  title?: string;
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
    // a video clip, or a walk's playback copy (the unlevelled one its detections are on)
    const src = frameLayerSrc(layers, source.layer);
    return src ? assetUrl(projectId, src) : null;
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
  /** The edited shape in the detection's own pixel grid. */
  onEdit: (id: string, geom: ImageGeom) => void;
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

  // a detection's shape is in its own pixel grid (`size`); the editor works in the image's
  const toImage = useCallback(
    (d: Detection): ImageGeom =>
      natural ? scaleGeom(d.geom, natural.width / d.size[0], natural.height / d.size[1]) : d.geom,
    [natural],
  );
  // a box across a walk's 360 seam is drawn in two parts and is not edited here (editing would
  // clamp it to the frame and lose the wrap)
  const items = useMemo<ShapeItem[]>(
    () =>
      shapes.flatMap((s): ShapeItem[] => {
        const selected = s.detection.id === currentId;
        const geom = toImage(s.detection);
        const parts = natural ? wrapParts(geom, natural.width) : [geom];
        const editable = selected && !readOnly && s.detection.status !== 'accepted';
        if (parts.length < 2)
          return [
            {
              key: s.detection.id,
              geom,
              color: s.color,
              label: s.label,
              ...(s.title ? { title: s.title } : {}),
              selected,
              editable,
            },
          ];
        const width = (g: ImageGeom | undefined) => (g?.type === 'box' ? g.w : 0);
        const widest = width(parts[1]) > width(parts[0]) ? 1 : 0;
        return parts.map((p, i) => ({
          key: i === 0 ? s.detection.id : wrapKey(s.detection.id),
          geom: p,
          color: s.color,
          ...(i === widest ? { label: s.label } : {}),
          ...(s.title ? { title: s.title } : {}),
          group: s.detection.id,
          selected,
          editable: false,
        }));
      }),
    [shapes, currentId, readOnly, toImage, natural],
  );

  const back = (id: string, geom: ImageGeom, size: Size) => {
    const d = shapes.find((x) => x.detection.id === id)?.detection;
    if (!d) return;
    const g = clampGeom(geom, size);
    onEdit(id, scaleGeom(g, d.size[0] / size.width, d.size[1] / size.height));
  };

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
            noteImageSize(sourceKey(source), [im.naturalWidth, im.naturalHeight]);
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
            noteImageSize(sourceKey(source), [v.videoWidth, v.videoHeight]);
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
          look="detections"
          onCreate={(geom) => {
            if (!readOnly) onCreate(geom, natural);
          }}
          onEdit={(id, geom) => {
            back(id, geom, natural);
          }}
          onVertexInsert={(id, geom) => {
            back(id, geom, natural);
          }}
          onVertexRemove={(id, geom) => {
            back(id, geom, natural);
          }}
          onSelect={(key) => {
            onSelect(key === null ? null : splitWrapKey(key));
          }}
          onPan={(dx, dy) => {
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
          }}
        />
      )}
      <div className="ann-zoom">{Math.round(view.scale * 100)}%</div>
    </div>
  );
}
