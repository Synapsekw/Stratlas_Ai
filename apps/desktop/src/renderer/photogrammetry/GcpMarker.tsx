/**
 * The GCP marker (G4): the photos that see the selected point, nearest the image centre first;
 * the photo with a loupe, the prediction ring and any draft detections; click to place a mark.
 * Keyboard: Enter or C confirms (the draft, or the prediction), S skips the photo, N or the right
 * arrow goes to the next photo, P or the left arrow to the previous one, + and - zoom, Esc goes
 * back to the table. Every change is saved at once (`photo:writeGcp`, atomic with a `.bak`).
 */
import type { GcpFile, GcpPoint, PhotoRun } from '@aio/schema';
import { Icon } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyMark,
  confirmedMarks,
  gcpLocal,
  MIN_MARKS,
  photosFor,
  predictions,
  step,
  withPoint,
  type MarkAction,
  type MarkerPhoto,
} from './marks';

interface ShownPhoto extends MarkerPhoto {
  url: string;
  name: string;
}

const ZOOMS = [1, 1.5, 2, 3, 4] as const;
const LOUPE = 4;

export function GcpMarker({
  run,
  gcp,
  point,
  onSave,
  onBack,
  onPoint,
}: {
  run: PhotoRun;
  gcp: GcpFile;
  point: GcpPoint;
  onSave: (f: GcpFile) => Promise<boolean>;
  onBack: () => void;
  onPoint: (id: string) => void;
}) {
  const project = useWorkspace((s) => s.project);
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [loadedSize, setLoadedSize] = useState<{ id: string; size: [number, number] } | null>(null);
  const [saving, setSaving] = useState(false);
  const viewer = useRef<HTMLDivElement>(null);
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  // a native listener: the dialog's own Esc (closing the panel) must not see the marker's keys
  useEffect(() => {
    const el = viewer.current;
    if (!el) return;
    const fn = (e: KeyboardEvent) => {
      keyRef.current(e);
    };
    el.addEventListener('keydown', fn);
    return () => {
      el.removeEventListener('keydown', fn);
    };
  }, []);

  // the photos of the run's photos layer, posed, with their size in original pixels
  const photos = useMemo<ShownPhoto[]>(() => {
    if (!project || !('layer' in run.photos.source)) return [];
    const layerId = run.photos.source.layer;
    const layer = project.manifest.layers.find((l) => l.id === layerId);
    if (layer?.kind !== 'photos') return [];
    const group = run.cameras.length === 1 ? run.cameras[0] : undefined;
    return layer.items.map((it) => {
      const aspect = it.lens?.aspect ?? 4 / 3;
      const size: [number, number] = group
        ? [group.widthPx, group.heightPx]
        : [4000, Math.round(4000 / aspect)];
      const name = 'path' in it.src ? (it.src.path.split('/').pop() ?? it.id) : it.id;
      return {
        id: it.id,
        size,
        pos: it.pos,
        q: it.q,
        lens: it.lens,
        url: assetUrl(project.id, it.src),
        name,
      };
    });
  }, [project, run]);

  const frame = useMemo(() => {
    if (!project || !('epsg' in project.manifest.crs)) return null;
    return { epsg: project.manifest.crs.epsg, origin: project.manifest.origin };
  }, [project]);
  const fileEpsg = 'epsg' in gcp.crs ? gcp.crs.epsg : null;
  const local = frame && fileEpsg !== null ? gcpLocal(point, fileEpsg, frame) : null;
  const preds = useMemo(() => predictions(point, local, photos), [point, local, photos]);
  const list = useMemo(() => photosFor(point, preds, photos), [point, preds, photos]);
  const current = list[Math.min(index, Math.max(0, list.length - 1))];
  const natural = current && loadedSize?.id === current.photo.id ? loadedSize.size : null;
  const mark = current ? point.marks.find((m) => m.photo === current.photo.id) : undefined;
  const confirmed = confirmedMarks(point).length;
  const ids = gcp.points.map((p) => p.id);

  useEffect(() => {
    viewer.current?.focus();
  }, [point.id]);

  // keep the prediction (or the mark) in view when the photo or the zoom changes
  const target = mark?.px ?? current?.prediction?.px ?? null;
  useEffect(() => {
    const el = viewer.current;
    if (!el || !current || !target) return;
    const s = el.scrollWidth / current.photo.size[0];
    el.scrollLeft = target[0] * s - el.clientWidth / 2;
    el.scrollTop = target[1] * s - el.clientHeight / 2;
  }, [current, target, zoom, natural]);

  const act = async (a: MarkAction, advance: boolean) => {
    setSaving(true);
    const next = applyMark(point, a, new Date().toISOString());
    const ok = await onSave(withPoint(gcp, next));
    setSaving(false);
    if (ok && advance && list.length > 1) setIndex((i) => step(i, list.length, 1));
  };
  const confirm = () => {
    if (!current) return;
    const px = mark?.px ?? current.prediction?.px;
    if (!px) return;
    void act({ kind: 'confirm', photo: current.photo.id, px: [px[0], px[1]] }, true);
  };
  const skip = () => {
    if (!current) return;
    const px = current.prediction?.px;
    void act(
      { kind: 'skip', photo: current.photo.id, ...(px ? { px: [px[0], px[1]] } : {}) },
      true,
    );
  };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'Enter' || k === 'c' || k === 'C') confirm();
    else if (k === 's' || k === 'S') skip();
    else if (k === 'n' || k === 'N' || k === 'ArrowRight') setIndex((i) => step(i, list.length, 1));
    else if (k === 'p' || k === 'P' || k === 'ArrowLeft') setIndex((i) => step(i, list.length, -1));
    else if (k === '+' || k === '=') setZoom((z) => Math.min(ZOOMS.length - 1, z + 1));
    else if (k === '-') setZoom((z) => Math.max(0, z - 1));
    else if (k === 'Escape') onBack();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    keyRef.current = onKey;
  });

  if (!project) return null;
  if (!('layer' in run.photos.source))
    return (
      <div className="ph-marker-empty">
        <p className="small">
          This run reads photos from folders outside the project, which the marker cannot show yet.
          Import the photos as a photos layer, then process that layer to mark ground control.
        </p>
        <button type="button" className="btn sm" onClick={onBack}>
          Back to the points
        </button>
      </div>
    );

  const size = current?.photo.size ?? [1, 1];
  const ring = current?.prediction;
  const pct = (v: number, of: number) => `${String((v / of) * 100)}%`;
  const loupeAt = target;

  return (
    <div className="ph-marker" data-testid="gcp-marker">
      <aside className="ph-mk-side" aria-label="Photos of the point">
        <div className="ph-mk-point">
          <label className="b-field">
            <span>Point</span>
            <select
              className="input sm"
              value={point.id}
              onChange={(e) => {
                onPoint(e.target.value);
              }}
            >
              {ids.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <p className={`small ${confirmed >= MIN_MARKS ? 'ok' : ''}`} data-testid="marker-count">
            {confirmed} of {MIN_MARKS} marks confirmed ·{' '}
            {point.role === 'check' ? 'checkpoint' : 'control'}
          </p>
        </div>
        <ol className="ph-mk-list">
          {list.map((x, i) => {
            const m = point.marks.find((mm) => mm.photo === x.photo.id);
            return (
              <li key={x.photo.id}>
                <button
                  type="button"
                  aria-current={i === index ? 'true' : undefined}
                  onClick={() => {
                    setIndex(i);
                  }}
                >
                  <span className="mono">{x.photo.name}</span>
                  <span className={`ph-mk-st ${m?.state ?? 'none'}`}>
                    {m ? m.state : x.prediction ? 'predicted' : ''}
                  </span>
                </button>
              </li>
            );
          })}
          {list.length === 0 && (
            <li className="small faint">
              No photo is predicted to see this point. Check its coordinates and the CRS.
            </li>
          )}
        </ol>
        <button type="button" className="btn sm ghost" onClick={onBack}>
          <Icon name="back" size={14} />
          Back to the points
        </button>
      </aside>

      <div className="ph-mk-main">
        <div className="ph-mk-viewer">
          <div
            ref={viewer}
            className="ph-mk-scroll"
            tabIndex={0}
            role="group"
            aria-label={`Photo ${current?.photo.name ?? ''} of ${point.id}. Enter confirms, S skips, N and P change photo, plus and minus zoom.`}
            aria-keyshortcuts="Enter C S N P ArrowRight ArrowLeft + - Escape"
            data-testid="marker-viewer"
          >
            {current ? (
              <>
                <div
                  className="ph-mk-img"
                  style={{ width: `${String((ZOOMS[zoom] ?? 1) * 100)}%` }}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const px: [number, number] = [
                      ((e.clientX - r.left) / r.width) * size[0],
                      ((e.clientY - r.top) / r.height) * size[1],
                    ];
                    void act({ kind: 'place', photo: current.photo.id, px }, false);
                  }}
                >
                  <img
                    src={current.photo.url}
                    alt={`Photo ${current.photo.name}`}
                    draggable={false}
                    onLoad={(e) => {
                      setLoadedSize({
                        id: current.photo.id,
                        size: [e.currentTarget.naturalWidth, e.currentTarget.naturalHeight],
                      });
                    }}
                  />
                  <svg
                    className="ph-mk-over"
                    viewBox={`0 0 ${String(size[0])} ${String(size[1])}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    {ring && (
                      <circle
                        data-testid="prediction-ring"
                        data-px={`${ring.px[0].toFixed(1)},${ring.px[1].toFixed(1)}`}
                        cx={ring.px[0]}
                        cy={ring.px[1]}
                        r={Math.max(ring.radiusPx, size[0] / 200)}
                        className="ring"
                      />
                    )}
                    {mark && mark.state !== 'skipped' && (
                      <g className={`mk ${mark.state}`} data-testid="marker-mark">
                        <circle cx={mark.px[0]} cy={mark.px[1]} r={size[0] / 160} />
                        <line
                          x1={mark.px[0] - size[0] / 80}
                          x2={mark.px[0] + size[0] / 80}
                          y1={mark.px[1]}
                          y2={mark.px[1]}
                        />
                        <line
                          x1={mark.px[0]}
                          x2={mark.px[0]}
                          y1={mark.px[1] - size[0] / 80}
                          y2={mark.px[1] + size[0] / 80}
                        />
                      </g>
                    )}
                  </svg>
                </div>
                {loupeAt && natural && (
                  <div
                    className="ph-loupe"
                    aria-hidden="true"
                    style={{
                      backgroundImage: `url("${current.photo.url}")`,
                      backgroundSize: `${String(LOUPE * 100)}% auto`,
                      backgroundPosition: `${pct(loupeAt[0], size[0])} ${pct(loupeAt[1], size[1])}`,
                    }}
                  >
                    <i />
                  </div>
                )}
              </>
            ) : (
              <p className="faint small">No photo to show.</p>
            )}
          </div>
        </div>
        <div className="ph-mk-bar">
          <span className="small faint">
            {current
              ? `${String(index + 1)} of ${String(list.length)} · ${mark ? `mark ${mark.state} (${mark.by})` : ring ? 'predicted, not marked' : 'not marked'}`
              : ''}
            {saving ? ' · saving' : ''}
          </span>
          <button
            type="button"
            className="btn sm"
            aria-label="Zoom out"
            disabled={zoom === 0}
            onClick={() => {
              setZoom((z) => Math.max(0, z - 1));
            }}
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            className="btn sm"
            aria-label="Zoom in"
            disabled={zoom === ZOOMS.length - 1}
            onClick={() => {
              setZoom((z) => Math.min(ZOOMS.length - 1, z + 1));
            }}
          >
            <Icon name="plus" size={14} />
          </button>
          <button type="button" className="btn sm" disabled={!current} onClick={skip}>
            Skip
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={!current || (!mark && !ring)}
            onClick={confirm}
          >
            <Icon name="check" size={14} />
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
