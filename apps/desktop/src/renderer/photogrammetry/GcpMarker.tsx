/**
 * The GCP marker (G4): the photos that see the selected point, nearest the image centre first;
 * the photo with a loupe, the prediction ring and any draft detections; click to place a mark.
 * Keyboard: Enter or C confirms (the draft, or the prediction) and goes to the next photo without
 * a mark, S skips the photo, N or the right arrow goes to the next photo, P or the left arrow to
 * the previous one, + and - zoom, Esc goes back to the table. Every change is saved at once
 * (`photo:writeGcp`, atomic with a `.bak`).
 *
 * The predictions learn from the marks (`marks.ts`): two confirmed marks of a point triangulate
 * it, which places it in every other photo, and the marked points say how far the survey sits
 * from the cameras (a flight without RTK logs heights tens of metres off), which places the
 * points not marked yet.
 */
import {
  PHOTO_RUN_FILES,
  photoRunDir,
  type GcpFile,
  type GcpPoint,
  type PhotoCamerasFile,
  type PhotoRun,
} from '@aio/schema';
import { Icon } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../shell';
import {
  applyMark,
  clickToPixel,
  confirmedMarks,
  inFrame,
  loupeBackground,
  markerList,
  MIN_MARKS,
  nextToMark,
  readCamerasFile,
  sfmPhotos,
  step,
  withPoint,
  type MarkAction,
  type MarkerPhoto,
  type SfmPhoto,
} from './marks';

interface ShownPhoto extends MarkerPhoto {
  /** `aio://` address of a photo in the project; null for a folder run's photo (read by main). */
  url: string | null;
  name: string;
}

const ZOOMS = [1, 1.5, 2, 3, 4] as const;
const LOUPE = 4;
/** The loupe's diameter, CSS pixels (photo.css .ph-loupe). */
const LOUPE_BOX = 140;

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
  // the photo shown, by its id: a mark can add photos to the list and reorder it
  const [shown, setShown] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [loadedSize, setLoadedSize] = useState<{ id: string; size: [number, number] } | null>(null);
  const [saving, setSaving] = useState(false);
  /** A mark action is being saved (`act`). */
  const busy = useRef(false);
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

  // the run's refined cameras (cameras-sfm.json): poses for the predictions, original sizes
  const [sfm, setSfm] = useState<{ run: string; file: PhotoCamerasFile } | null>(null);
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    const url = assetUrl(projectId, {
      path: `${photoRunDir(run.id)}/${PHOTO_RUN_FILES.camerasSfm}`,
    });
    fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((raw) => {
        const file = raw === null ? null : readCamerasFile(raw);
        if (live) setSfm(file ? { run: run.id, file } : null);
      })
      .catch(() => {
        if (live) setSfm(null);
      });
    return () => {
      live = false;
    };
  }, [projectId, run.id]);

  // the photos of the run, posed, with their size in original pixels
  const photos = useMemo<ShownPhoto[]>(() => {
    if (!project) return [];
    const refined =
      sfm?.run === run.id
        ? sfmPhotos(sfm.file, project.manifest.origin)
        : new Map<string, SfmPhoto>();
    const group = run.cameras.length === 1 ? run.cameras[0] : undefined;
    // marks are in original pixels: the calibration's size, else the one camera group's
    const groupSize = (aspect: number): [number, number] =>
      group ? [group.widthPx, group.heightPx] : [4000, Math.round(4000 / aspect)];
    const source = run.photos.source;
    if ('layer' in source) {
      const layer = project.manifest.layers.find((l) => l.id === source.layer);
      if (layer?.kind !== 'photos') return [];
      return layer.items.map((it) => {
        const r = refined.get(it.id);
        const size = r ? r.size : groupSize(it.lens?.aspect ?? 4 / 3);
        const name = 'path' in it.src ? (it.src.path.split('/').pop() ?? it.id) : it.id;
        return {
          id: it.id,
          size,
          pos: r?.pos ?? it.pos,
          q: r?.q ?? it.q,
          lens: r?.lens ?? it.lens,
          url: assetUrl(project.id, it.src),
          name,
        };
      });
    }
    // a folder run: the photos are read through main (photo:readPhoto), keyed by their path
    const out = new Map<string, ShownPhoto>();
    for (const r of refined.values())
      out.set(r.id, { ...r, url: null, name: r.id.split('/').pop() ?? r.id });
    for (const key of [
      ...(point.predicted ?? []).map((p) => p.photo),
      ...point.marks.map((m) => m.photo),
    ]) {
      if (out.has(key)) continue;
      out.set(key, {
        id: key,
        size: groupSize(4 / 3),
        url: null,
        name: key.split('/').pop() ?? key,
      });
    }
    return [...out.values()];
  }, [project, run, sfm, point]);

  const frame = useMemo(() => {
    if (!project || !('epsg' in project.manifest.crs)) return null;
    return { epsg: project.manifest.crs.epsg, origin: project.manifest.origin };
  }, [project]);
  // the run's ground sample distance: where the model's ground is before any mark (groundShift)
  const gsdCm = run.accuracy?.gsdCm;
  const list = useMemo(
    () => markerList(gcp, point, photos, frame, gsdCm),
    [gcp, point, photos, frame, gsdCm],
  );
  const index = Math.max(
    0,
    list.findIndex((x) => x.photo.id === shown),
  );
  const current = list[index];
  const natural = current && loadedSize?.id === current.photo.id ? loadedSize.size : null;
  const mark = current ? point.marks.find((m) => m.photo === current.photo.id) : undefined;
  const confirmed = confirmedMarks(point).length;
  const ids = gcp.points.map((p) => p.id);

  // a folder run's photo, read through main (read only, inside the run's folders), as a blob URL
  const [read, setRead] = useState<{ id: string; url: string | null; error?: string } | null>(null);
  const currentId = current?.photo.id ?? null;
  const viaMain = current?.photo.url === null;
  useEffect(() => {
    if (!projectId || !currentId || !viaMain) return;
    let live = true;
    let made: string | null = null;
    void bridge.call('photo:readPhoto', { projectId, run: run.id, photo: currentId }).then((r) => {
      if (!live) return;
      const error = !r.ok
        ? r.error
        : !r.value.ok
          ? r.value.error
          : r.value.mime === 'image/tiff'
            ? 'This photo is a TIFF, which the marker cannot show yet. Mark it in a JPEG copy.'
            : null;
      if (error !== null || !r.ok || !r.value.ok) {
        setRead({ id: currentId, url: null, error: error ?? 'The photo cannot be read.' });
        return;
      }
      made = URL.createObjectURL(new Blob([new Uint8Array(r.value.data)], { type: r.value.mime }));
      setRead({ id: currentId, url: made });
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [projectId, run.id, currentId, viaMain]);
  const imageUrl = current
    ? (current.photo.url ?? (read?.id === current.photo.id ? read.url : null))
    : null;
  const imageError = current && read?.id === current.photo.id ? read.error : undefined;

  useEffect(() => {
    viewer.current?.focus();
  }, [point.id]);

  // a prediction beside the photo (its ring reaches in) says where to look; it is never a mark
  const predicted =
    current?.prediction && inFrame(current.prediction.px, current.photo.size)
      ? current.prediction.px
      : undefined;
  // keep the prediction (or the mark) in view when the photo or the zoom changes
  const target = mark?.px ?? current?.prediction?.px ?? null;
  useEffect(() => {
    const el = viewer.current;
    if (!el || !current || !target) return;
    const s = el.scrollWidth / current.photo.size[0];
    el.scrollLeft = target[0] * s - el.clientWidth / 2;
    el.scrollTop = target[1] * s - el.clientHeight / 2;
  }, [current, target, zoom, natural]);

  /**
   * One mark action. `onSave` answers once main has saved the file and shows it then, so the
   * count, the mark and the photo shown change together and what the marker shows is what is on
   * disk. Never the count before the photo: a key press or a reader in between would take the
   * photo just marked for the next one (the ring of one photo under the name of another, or the
   * same photo confirmed twice). While a mark is being saved, further mark actions are ignored:
   * they would act on the photo and the marks as shown, not as they are about to be.
   */
  const act = async (a: MarkAction, advance: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    const next = applyMark(point, a, new Date().toISOString());
    const file = withPoint(gcp, next);
    const ok = await onSave(file);
    busy.current = false;
    setSaving(false);
    // the next photo that still needs a mark, in the list as this mark leaves it; a placed mark
    // keeps its photo, wherever the list now has it
    if (ok)
      setShown(
        advance ? nextToMark(markerList(file, next, photos, frame, gsdCm), next, a.photo) : a.photo,
      );
  };
  const go = (by: 1 | -1) => {
    setShown(list[step(index, list.length, by)]?.photo.id ?? null);
  };
  const confirm = () => {
    if (!current) return;
    const px = mark?.px ?? predicted;
    if (!px) return;
    void act({ kind: 'confirm', photo: current.photo.id, px: [px[0], px[1]] }, true);
  };
  const skip = () => {
    if (!current) return;
    const px = predicted;
    void act(
      { kind: 'skip', photo: current.photo.id, ...(px ? { px: [px[0], px[1]] } : {}) },
      true,
    );
  };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'Enter' || k === 'c' || k === 'C') confirm();
    else if (k === 's' || k === 'S') skip();
    else if (k === 'n' || k === 'N' || k === 'ArrowRight') go(1);
    else if (k === 'p' || k === 'P' || k === 'ArrowLeft') go(-1);
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
  const size = current?.photo.size ?? [1, 1];
  const ring = current?.prediction;
  const loupeAt = mark?.px ?? predicted ?? null;

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
                    setShown(x.photo.id);
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
                  style={{
                    width: `${String((ZOOMS[zoom] ?? 1) * 100)}%`,
                    ...(imageUrl ? {} : { aspectRatio: `${String(size[0])} / ${String(size[1])}` }),
                  }}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const px = clickToPixel([e.clientX, e.clientY], r, size);
                    void act({ kind: 'place', photo: current.photo.id, px }, false);
                  }}
                >
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt={`Photo ${current.photo.name}`}
                      draggable={false}
                      onLoad={(e) => {
                        setLoadedSize({
                          id: current.photo.id,
                          size: [e.currentTarget.naturalWidth, e.currentTarget.naturalHeight],
                        });
                      }}
                    />
                  ) : (
                    <p className="small faint ph-mk-wait" role="status">
                      {imageError ?? 'Reading the photo'}
                    </p>
                  )}
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
                {loupeAt && natural && imageUrl && (
                  <div
                    className="ph-loupe"
                    aria-hidden="true"
                    data-testid="marker-loupe"
                    style={{
                      backgroundImage: `url("${imageUrl}")`,
                      backgroundSize: loupeBackground(loupeAt, size, LOUPE_BOX, LOUPE).size,
                      backgroundPosition: loupeBackground(loupeAt, size, LOUPE_BOX, LOUPE).position,
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
            disabled={!current || (!mark && !predicted)}
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
