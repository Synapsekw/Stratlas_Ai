import type { ImageGeom } from '@aio/schema';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  boxFromDrag,
  dragHandle,
  geomArea,
  geomOutline,
  handlesOf,
  hitGeom,
  rboxFromThreePoints,
  toDisplay,
  toImage,
  translateGeom,
  type Point,
  type Size,
  type ViewTransform,
} from '../image/geometry';
import { insertVertex, nearestEdge, removeVertex } from '../detections/geometry';
import {
  CHIP_H,
  CHIP_PAD_X,
  boxInView,
  chipTextColor,
  chipWidth,
  stackChips,
} from '../detections/classStyle';
import type { ImageTool } from '../runtime';

export interface ShapeItem {
  key: string;
  geom: ImageGeom;
  color: string;
  label?: string;
  selected?: boolean;
  editable?: boolean;
  /** Tooltip of the shape. */
  title?: string;
  /** Shapes drawn as parts of one (a box across a 360 seam) share hover by this key. */
  group?: string;
  /** An AI suggestion not yet accepted: drawn dashed, with a lighter fill. */
  dashed?: boolean;
}

export interface DrawLayerProps {
  view: ViewTransform;
  size: Size;
  tool: ImageTool;
  shapes: readonly ShapeItem[];
  onCreate: (geom: ImageGeom, client: Point) => void;
  onEdit?: (key: string, geom: ImageGeom) => void;
  onSelect?: (key: string | null) => void;
  onPan: (dx: number, dy: number) => void;
  /** Double-click on an edge of the selected polygon: add a vertex there (select tool). */
  onVertexInsert?: (key: string, geom: ImageGeom) => void;
  /** Shift-click on a vertex of the selected polygon: remove it (three stay at least). */
  onVertexRemove?: (key: string, geom: ImageGeom) => void;
  /**
   * `detections`: the review's look. Each shape has a dark halo, its label is a filled chip in
   * its colour above its top left corner (stacked so chips do not cover each other), the shape
   * under the pointer thickens and comes to the front, and with one selected the others dim.
   */
  look?: 'plain' | 'detections';
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; last: Point }
  | { kind: 'box'; anchor: Point; cur: Point }
  | { kind: 'move'; key: string; start: Point; geom: ImageGeom; cur: ImageGeom }
  | { kind: 'handle'; key: string; index: number; geom: ImageGeom; cur: ImageGeom };

const HANDLE_PX = 5;

const pointsAttr = (pts: readonly Point[], v: ViewTransform) =>
  pts
    .map((p) => toDisplay(p, v))
    .map((p) => `${p.x},${p.y}`)
    .join(' ');

/**
 * SVG drawing and editing layer over an image, in display pixels. Tools: box (drag), rotated box
 * (three clicks: one edge, then the width), polygon (clicks, Enter or double-click to close,
 * Backspace to undo a vertex), point (click), select (move shapes, drag handles, pan).
 */
export function DrawLayer(props: DrawLayerProps) {
  const { view, size, tool, shapes } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [gesture, setGesture] = useState<Gesture>({ kind: 'none' });
  const [clicks, setClicks] = useState<Point[]>([]);
  const [hover, setHover] = useState<Point | null>(null);
  const det = props.look === 'detections';
  // the layer's size on screen, to keep label chips inside it (detections look only)
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = svgRef.current;
    if (!det || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      setBox({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [det]);

  // Drop a half-drawn shape when the tool changes (state derived during render, not in an effect).
  const [toolSeen, setToolSeen] = useState(tool);
  if (toolSeen !== tool) {
    setToolSeen(tool);
    setClicks([]);
  }

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const img = (e: { clientX: number; clientY: number }) => toImage(local(e), view);
  const client = (p: Point): Point => {
    const r = svgRef.current?.getBoundingClientRect();
    const d = toDisplay(p, view);
    return { x: d.x + (r?.left ?? 0), y: d.y + (r?.top ?? 0) };
  };

  const finishPolygon = (pts: readonly Point[]) => {
    if (pts.length < 3) return;
    props.onCreate(
      { type: 'polygon', points: pts.map((p) => [p.x, p.y]) },
      client(pts[pts.length - 1] ?? pts[0] ?? { x: 0, y: 0 }),
    );
    setClicks([]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (clicks.length === 0) return;
      if (e.key === 'Escape') setClicks([]);
      else if (e.key === 'Backspace') setClicks((c) => c.slice(0, -1));
      else if (e.key === 'Enter' && tool === 'polygon') finishPolygon(clicks);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  const selected = shapes.find((s) => s.selected && s.editable);
  const groupOf = (s: ShapeItem) => s.group ?? s.key;
  const hits = (s: ShapeItem, p: Point) => hitGeom(s.geom, p, 6 / view.scale);
  // plain look: the last drawn shape under the point wins
  const lastAt = (p: Point) => [...shapes].reverse().find((s) => hits(s, p));
  // detections look: the smallest shape under the point wins, so a box nested in another (a
  // helmet in a person) stays reachable whichever is selected or drawn on top. The parts of a box
  // across a 360 seam count as one shape (their summed area). Equal areas go to the selected
  // shape, then to the later one in the list.
  const groupArea = new Map<string, number>();
  if (det) {
    for (const s of shapes)
      groupArea.set(groupOf(s), (groupArea.get(groupOf(s)) ?? 0) + geomArea(s.geom));
  }
  const smallestAt = (p: Point) => {
    let best: { s: ShapeItem; area: number; i: number } | undefined;
    shapes.forEach((s, i) => {
      if (!hits(s, p)) return;
      const area = groupArea.get(groupOf(s)) ?? 0;
      const better =
        !best ||
        area < best.area ||
        (area === best.area &&
          (Boolean(s.selected) > Boolean(best.s.selected) ||
            (Boolean(s.selected) === Boolean(best.s.selected) && i > best.i)));
      if (better) best = { s, area, i };
    });
    return best?.s;
  };
  const pickAt = (p: Point) => (det ? smallestAt(p) : lastAt(p));
  const hovered =
    det && hover && gesture.kind === 'none' && tool === 'select' ? pickAt(hover) : undefined;
  const hoverGroup = hovered ? groupOf(hovered) : null;
  // drawing order only (detections look): the hovered shape, then the selected one, on top
  const rank = (s: ShapeItem) => (s.selected ? 2 : 0) + (groupOf(s) === hoverGroup ? 1 : 0);
  const ordered = det
    ? shapes
        .map((s, i) => ({ s, i }))
        .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
        .map((x) => x.s)
    : shapes;

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = img(e);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      setGesture({ kind: 'pan', last: local(e) });
      return;
    }
    if (tool === 'select') {
      if (selected) {
        const hs = handlesOf(selected.geom);
        const d = local(e);
        const hi = hs.findIndex((h) => {
          const hd = toDisplay(h, view);
          return Math.hypot(hd.x - d.x, hd.y - d.y) <= HANDLE_PX + 3;
        });
        if (hi >= 0 && e.shiftKey && selected.geom.type === 'polygon' && props.onVertexRemove) {
          const fewer = removeVertex(selected.geom, hi);
          if (fewer) props.onVertexRemove(selected.key, fewer);
          return;
        }
        if (hi >= 0) {
          setGesture({
            kind: 'handle',
            key: selected.key,
            index: hi,
            geom: selected.geom,
            cur: selected.geom,
          });
          return;
        }
      }
      const hit = pickAt(p);
      props.onSelect?.(hit?.key ?? null);
      if (hit?.editable) {
        setGesture({ kind: 'move', key: hit.key, start: p, geom: hit.geom, cur: hit.geom });
      } else if (!hit) {
        setGesture({ kind: 'pan', last: local(e) });
      }
      return;
    }
    if (tool === 'box') setGesture({ kind: 'box', anchor: p, cur: p });
  };

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = img(e);
    setHover(p);
    switch (gesture.kind) {
      case 'pan': {
        const d = local(e);
        props.onPan(d.x - gesture.last.x, d.y - gesture.last.y);
        setGesture({ kind: 'pan', last: d });
        break;
      }
      case 'box':
        setGesture({ ...gesture, cur: p });
        break;
      case 'move':
        setGesture({
          ...gesture,
          cur: translateGeom(gesture.geom, p.x - gesture.start.x, p.y - gesture.start.y),
        });
        break;
      case 'handle':
        setGesture({ ...gesture, cur: dragHandle(gesture.geom, gesture.index, p) });
        break;
      case 'none':
        break;
    }
  };

  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = img(e);
    const g = gesture;
    setGesture({ kind: 'none' });
    if (g.kind === 'box') {
      const box = boxFromDrag(g.anchor, p, size);
      if (box) props.onCreate(box, { x: e.clientX, y: e.clientY });
      return;
    }
    if (g.kind === 'move' || g.kind === 'handle') {
      if (g.cur !== g.geom) props.onEdit?.(g.key, g.cur);
      return;
    }
    if (g.kind === 'pan' || e.button !== 0) return;
    if (tool === 'point') {
      props.onCreate({ type: 'point', x: p.x, y: p.y }, { x: e.clientX, y: e.clientY });
    } else if (tool === 'polygon') {
      const first = clicks[0];
      if (first && clicks.length >= 3) {
        const fd = toDisplay(first, view);
        const d = local(e);
        if (Math.hypot(fd.x - d.x, fd.y - d.y) <= HANDLE_PX + 3) {
          finishPolygon(clicks);
          return;
        }
      }
      setClicks([...clicks, p]);
    } else if (tool === 'rotbox') {
      if (clicks.length < 2) {
        setClicks([...clicks, p]);
      } else {
        const [a, b] = clicks;
        const r = a && b ? rboxFromThreePoints(a, b, p) : null;
        if (r) props.onCreate(r, { x: e.clientX, y: e.clientY });
        setClicks([]);
      }
    }
  };

  const shapeFor = (s: ShapeItem): ImageGeom => {
    if ((gesture.kind === 'move' || gesture.kind === 'handle') && gesture.key === s.key) {
      return gesture.cur;
    }
    return s.geom;
  };

  // Preview of the shape being drawn.
  let preview: Point[] | null = null;
  if (gesture.kind === 'box') {
    const b = boxFromDrag(gesture.anchor, gesture.cur, size);
    preview = b ? geomOutline(b) : null;
  } else if (tool === 'polygon' && clicks.length) {
    preview = hover ? [...clicks, hover] : clicks;
  } else if (tool === 'rotbox' && clicks.length) {
    const [a, b] = clicks;
    const r = a && b && hover ? rboxFromThreePoints(a, b, hover) : null;
    preview = r ? geomOutline(r) : hover ? [...clicks, hover] : clicks;
  }

  const cursor = gesture.kind === 'pan' ? 'grabbing' : tool === 'select' ? 'default' : 'crosshair';

  // label chips (detections look): above each labelled shape's top left, in drawing order with
  // the topmost first so it keeps its place
  const chips = det
    ? (() => {
        const wanted = ordered
          .filter((s) => s.label)
          .map((s) => {
            const pts = geomOutline(shapeFor(s)).map((p) => toDisplay(p, view));
            const x = Math.min(...pts.map((p) => p.x));
            const y = Math.min(...pts.map((p) => p.y));
            const x1 = Math.max(...pts.map((p) => p.x));
            const y1 = Math.max(...pts.map((p) => p.y));
            const text = s.label ?? '';
            return { s, text, x, y, x1, y1, w: chipWidth(text), h: CHIP_H };
          })
          .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y))
          .filter((c) => box.width <= 0 || boxInView(c.x, c.y, c.x1, c.y1, box))
          .reverse();
        const at = stackChips(wanted, box.width > 0 ? box : { width: 1e9, height: 1e9 });
        return wanted.map((c, i) => ({ ...c, at: at[i] ?? { x: c.x, y: c.y } })).reverse();
      })()
    : [];
  const anySelected = det && shapes.some((s) => s.selected);

  return (
    <svg
      ref={svgRef}
      className={`ann-draw${det ? ' det-look' : ''}${anySelected ? ' has-sel' : ''}`}
      style={{ cursor }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => {
        setHover(null);
      }}
      onDoubleClick={(e) => {
        if (tool === 'select' && selected?.geom.type === 'polygon' && props.onVertexInsert) {
          const p = img(e);
          const edge = nearestEdge(selected.geom, p);
          if (edge.distance <= (HANDLE_PX + 3) / view.scale) {
            props.onVertexInsert(selected.key, insertVertex(selected.geom, edge.index, p));
          }
          return;
        }
        if (tool === 'polygon')
          finishPolygon(clicks.slice(0, -1).length >= 3 ? clicks.slice(0, -1) : clicks);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      {ordered.map((s) => {
        const g = shapeFor(s);
        const style = { ['--c' as string]: s.color };
        const hov = det && groupOf(s) === hoverGroup;
        const cls = `shape${s.dashed ? ' ai' : ''}${s.selected ? ' sel' : ''}${hov ? ' hov' : ''}`;
        const outline = geomOutline(g);
        const top = outline.reduce<Point | null>((a, p) => (!a || p.y < a.y ? p : a), null);
        const labelAt = top ? toDisplay(top, view) : null;
        return (
          <g key={s.key} style={style}>
            {s.title && <title>{s.title}</title>}
            {det &&
              (g.type === 'point' ? (
                <circle
                  className={`halo${s.selected ? ' sel' : ''}${hov ? ' hov' : ''}`}
                  cx={toDisplay(outline[0] ?? { x: 0, y: 0 }, view).x}
                  cy={toDisplay(outline[0] ?? { x: 0, y: 0 }, view).y}
                  r={5}
                />
              ) : (
                <polygon
                  className={`halo${s.selected ? ' sel' : ''}${hov ? ' hov' : ''}`}
                  points={pointsAttr(outline, view)}
                />
              ))}
            {g.type === 'point' ? (
              <circle
                className={cls}
                cx={toDisplay(outline[0] ?? { x: 0, y: 0 }, view).x}
                cy={toDisplay(outline[0] ?? { x: 0, y: 0 }, view).y}
                r={5}
              />
            ) : (
              <polygon className={cls} points={pointsAttr(outline, view)} />
            )}
            {!det && s.label && labelAt && (
              <text className="label" x={labelAt.x + 2} y={labelAt.y - 5}>
                {s.label}
              </text>
            )}
            {s.selected &&
              s.editable &&
              handlesOf(g).map((h, i) => {
                const d = toDisplay(h, view);
                return (
                  <rect
                    key={i}
                    className="handle"
                    x={d.x - HANDLE_PX}
                    y={d.y - HANDLE_PX}
                    width={HANDLE_PX * 2}
                    height={HANDLE_PX * 2}
                  />
                );
              })}
          </g>
        );
      })}
      {chips.map((c) => (
        <g
          key={`chip:${c.s.key}`}
          className={`chip${c.s.selected ? ' sel' : ''}`}
          transform={`translate(${String(c.at.x)} ${String(c.at.y)})`}
          aria-hidden="true"
        >
          <rect width={c.w} height={c.h} rx={3} fill={c.s.color} />
          <text x={CHIP_PAD_X} y={c.h / 2} fill={chipTextColor(c.s.color)}>
            {c.text}
          </text>
        </g>
      ))}
      {preview && preview.length > 1 && (
        <polyline className="draft" points={pointsAttr(preview, view)} />
      )}
      {clicks.map((c, i) => {
        const d = toDisplay(c, view);
        return <circle key={i} className="handle" cx={d.x} cy={d.y} r={3.5} />;
      })}
    </svg>
  );
}
