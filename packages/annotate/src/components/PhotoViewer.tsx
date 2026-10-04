import type { ImageGeom, Sighting } from '@aio/schema';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { worldToPixel } from '../crossview/lens';
import {
  ZOOM_STEP,
  fitView,
  zoomAround,
  type Point,
  type Size,
  type ViewTransform,
} from '../image/geometry';
import {
  annotateUi,
  beginSighting,
  issueEditor,
  rememberImageSize,
  useAnnotateReadOnly,
  useAnnotateUi,
  type ImageTool,
} from '../runtime';
import { bestAnchor, severityColor } from '../tools/mesh';
import { useTaxonomy } from './common';
import { DrawLayer, type ShapeItem } from './DrawLayer';
import { SightingPicker } from './SightingPicker';
import { AnnotateStyles } from './styles';

export const IMAGE_TOOLS: { id: ImageTool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'v' },
  { id: 'box', label: 'Box', key: 'b' },
  { id: 'rotbox', label: 'Rotated box', key: 'r' },
  { id: 'polygon', label: 'Polygon', key: 'p' },
  { id: 'point', label: 'Point', key: 'o' },
];

/** Overlay PNG next to a kit mask (`p024_mask.png` to `p024_overlay.png`), else the mask. */
export function overlayPathFor(maskPath: string): string {
  return maskPath.replace(/_mask\.png$/i, '_overlay.png');
}

interface Pinch {
  pointers: Map<number, Point>;
  dist: number;
}

/** Photo viewer with pan, zoom, mask overlay and annotation tools. */
export function PhotoViewer({
  layerId,
  photoId,
  className,
  editOutlines = true,
}: {
  layerId: string;
  photoId: string;
  className?: string;
  /** The selected issue's outline shows vertex handles to edit it (default true). */
  editOutlines?: boolean;
}) {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const selection = useWorkspace((s) => s.selection);
  const readOnly = useAnnotateReadOnly();
  const pickedTool = useAnnotateUi((s) => s.imageTool);
  // A read-only package only selects: no drawing, no handle editing.
  const tool: ImageTool = readOnly ? 'select' : pickedTool;
  const { modelById } = useTaxonomy();
  const stageRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ url: string; size: Size | null } | null>(null);
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const [opacity, setOpacity] = useState(0.6);
  const [showOverlay, setShowOverlay] = useState(true);
  const pinch = useRef<Pinch>({ pointers: new Map(), dist: 0 });

  const layer = project?.manifest.layers.find((l) => l.id === layerId);
  const photo = layer?.kind === 'photos' ? layer.items.find((p) => p.id === photoId) : undefined;
  const url = project && photo ? assetUrl(project.id, photo.src) : null;
  const natural = loaded?.url === url ? loaded.size : null;
  const failed = loaded !== null && loaded.url === url && loaded.size === null;
  const selectedIssueId = selection?.kind === 'issue' ? selection.id : null;

  const fit = useCallback(() => {
    const el = stageRef.current;
    if (!el || !natural) return;
    setView(fitView(natural, { width: el.clientWidth, height: el.clientHeight }));
  }, [natural]);

  useEffect(() => {
    fit();
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      fit();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [fit]);

  // Wheel zoom (also trackpad pinch, which arrives as ctrl+wheel). Passive listeners cannot cancel.
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

  const shapes = useMemo<ShapeItem[]>(() => {
    const out: ShapeItem[] = [];
    for (const issue of issues) {
      const color = severityColor(modelById.get(issue.severityModelId), issue.severity);
      const selected = issue.id === selectedIssueId;
      let onPhoto = false;
      for (const [i, s] of issue.sightings.entries()) {
        if (s.on !== 'image' || s.layer !== layerId || s.photo !== photoId) continue;
        onPhoto = true;
        if (s.geom.type === 'mask') continue;
        out.push({
          key: `${issue.id}:${i}`,
          geom: s.geom,
          color,
          label: issue.code,
          selected,
          editable: selected && editOutlines && !readOnly,
        });
      }
      // ANN-9: a 3D sighting shows in every posed photo that sees it.
      if (!onPhoto && natural && photo?.pos && photo.q && photo.lens) {
        const p = bestAnchor(issue);
        const px = p
          ? worldToPixel({ pos: photo.pos, q: photo.q }, photo.lens, p, [
              natural.width,
              natural.height,
            ])
          : null;
        if (px) {
          out.push({
            key: `proj:${issue.id}`,
            geom: { type: 'point', x: px[0], y: px[1] },
            color,
            label: `${issue.code} (3D)`,
            selected,
          });
        }
      }
    }
    return out;
  }, [
    issues,
    modelById,
    selectedIssueId,
    layerId,
    photoId,
    natural,
    photo,
    readOnly,
    editOutlines,
  ]);

  const masks = useMemo(() => {
    const out: string[] = [];
    for (const issue of issues) {
      for (const s of issue.sightings) {
        if (
          s.on === 'image' &&
          s.layer === layerId &&
          s.photo === photoId &&
          s.geom.type === 'mask'
        ) {
          if ('path' in s.geom.src) out.push(overlayPathFor(s.geom.src.path));
        }
      }
    }
    return [...new Set(out)];
  }, [issues, layerId, photoId]);

  const onCreate = (geom: ImageGeom, at: Point) => {
    const s: Sighting = { on: 'image', layer: layerId, photo: photoId, geom };
    beginSighting(s, at);
  };

  const onEdit = (key: string, geom: ImageGeom) => {
    const [issueId, idx] = key.split(':');
    if (!issueId || idx === undefined) return;
    issueEditor.replaceSighting(issueId, Number(idx), {
      on: 'image',
      layer: layerId,
      photo: photoId,
      geom,
    });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || annotateUi.getState().pending) return;
    const k = e.key.toLowerCase();
    const t = IMAGE_TOOLS.find((x) => x.key === k);
    if (t && !readOnly) annotateUi.setState({ imageTool: t.id });
    else if (k === 'f') fit();
    else if (k === '+' || k === '=') setView((v) => zoomAround(v, center(), ZOOM_STEP));
    else if (k === '-') setView((v) => zoomAround(v, center(), 1 / ZOOM_STEP));
    else if (k === 'm') setShowOverlay((x) => !x);
    else return;
    e.preventDefault();
  };
  const center = (): Point => ({
    x: (stageRef.current?.clientWidth ?? 0) / 2,
    y: (stageRef.current?.clientHeight ?? 0) / 2,
  });

  // Two-finger pinch on touch screens.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    pinch.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pinch.current.pointers.values()];
    if (pts.length === 2 && pts[0] && pts[1]) {
      pinch.current.dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };
  const onPointerMoveCapture = (e: React.PointerEvent) => {
    const p = pinch.current;
    if (e.pointerType !== 'touch' || !p.pointers.has(e.pointerId)) return;
    p.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...p.pointers.values()];
    if (pts.length !== 2 || !pts[0] || !pts[1] || !p.dist) return;
    e.stopPropagation();
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const r = stageRef.current?.getBoundingClientRect();
    const mid = {
      x: (pts[0].x + pts[1].x) / 2 - (r?.left ?? 0),
      y: (pts[0].y + pts[1].y) / 2 - (r?.top ?? 0),
    };
    setView((v) => zoomAround(v, mid, d / p.dist));
    p.dist = d;
  };
  const onPointerUpCapture = (e: React.PointerEvent) => {
    pinch.current.pointers.delete(e.pointerId);
    if (pinch.current.pointers.size < 2) pinch.current.dist = 0;
  };

  const imgStyle = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    ...(natural ? { width: natural.width, height: natural.height, maxWidth: 'none' } : {}),
  };

  return (
    <div
      ref={stageRef}
      className={`ann-stage ${className ?? ''}`}
      data-testid="photo-viewer"
      tabIndex={0}
      onKeyDown={onKey}
      onPointerEnter={(e) => {
        e.currentTarget.focus({ preventScroll: true });
      }}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={onPointerUpCapture}
      onPointerCancelCapture={onPointerUpCapture}
      aria-label={`Photo ${photoId}`}
    >
      <AnnotateStyles />
      {!url && (
        <div className="ann-empty">
          Photo {photoId} is not in layer {layerId}.
        </div>
      )}
      {failed && <div className="ann-empty">The photo could not be loaded.</div>}
      {url && (
        <img
          className="ann-img"
          src={url}
          alt=""
          draggable={false}
          style={imgStyle}
          onLoad={(e) => {
            const im = e.currentTarget;
            const size = { width: im.naturalWidth, height: im.naturalHeight };
            setLoaded({ url, size });
            rememberImageSize(layerId, photoId, [size.width, size.height]);
          }}
          onError={() => {
            if (url) setLoaded({ url, size: null });
          }}
        />
      )}
      {project &&
        showOverlay &&
        natural &&
        masks.map((m) => (
          <img
            key={m}
            className="ann-img"
            src={assetUrl(project.id, { path: m })}
            alt=""
            draggable={false}
            style={{ ...imgStyle, opacity }}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ))}
      {natural && (
        <DrawLayer
          view={view}
          size={natural}
          tool={tool}
          shapes={shapes}
          onCreate={onCreate}
          onEdit={onEdit}
          onSelect={(key) => {
            const id = key?.replace(/^proj:/, '').split(':')[0];
            workspace.getState().select(id ? { kind: 'issue', id } : null);
          }}
          onPan={(dx, dy) => {
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
          }}
        />
      )}
      <div className="ann-toolbar" role="toolbar" aria-label="Photo annotation tools">
        {!readOnly &&
          IMAGE_TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="ann-btn ghost"
              aria-pressed={tool === t.id}
              title={`${t.label} (${t.key.toUpperCase()})`}
              onClick={() => {
                annotateUi.setState({ imageTool: t.id });
              }}
            >
              {t.label}
            </button>
          ))}
        {masks.length > 0 && (
          <>
            <span className="sep" />
            <button
              type="button"
              className="ann-btn ghost"
              aria-pressed={showOverlay}
              title="Mask overlay (M)"
              onClick={() => {
                setShowOverlay((x) => !x);
              }}
            >
              Mask
            </button>
            <label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                aria-label="Mask opacity"
                onChange={(e) => {
                  setOpacity(Number(e.target.value));
                }}
              />
              {Math.round(opacity * 100)}%
            </label>
          </>
        )}
        <span className="sep" />
        <button type="button" className="ann-btn ghost" title="Fit (F)" onClick={fit}>
          Fit
        </button>
      </div>
      <div className="ann-zoom">{Math.round(view.scale * 100)}%</div>
      {!readOnly && <SightingPicker kinds={['image']} />}
    </div>
  );
}
