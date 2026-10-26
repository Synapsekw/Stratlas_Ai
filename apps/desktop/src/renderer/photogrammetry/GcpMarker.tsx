/**
 * The GCP marker (G4): the photos that see the selected point, nearest the image centre first;
 * the photo with the prediction ring and any draft detections; click to place a mark.
 *
 * Aiming: a round loupe follows the cursor over the photo at true magnification (screen px per
 * original photo px, 6:1 until the mouse wheel steps it between 2:1 and 12:1, remembered on this
 * computer), sampling the full-resolution photo; a click places the mark at the loupe's centre, in
 * original pixels with the sub-pixel part kept. Holding Shift slows the aim to loupe speed: the
 * loupe stays under the cursor while its centre moves 1 / power original px per screen px, for
 * centring a target to a fraction of a pixel. Off the photo, the loupe rests on the mark (else the
 * prediction), and after an arrow key until the mouse moves, so a nudge stays in view; it is held
 * inside the viewer. The mark is an open crosshair of the same screen size at any zoom, its centre
 * left clear. The wheel over the photo is the loupe's; a right- or middle-button drag, or Space
 * and a drag, pans the photo, and a drag never places a mark.
 *
 * Keyboard: Enter or C confirms (the draft, or the prediction) and goes to the next photo without
 * a mark, S skips the photo, N and P go to the next and previous photo, the arrow keys move the
 * mark 1 original px (Shift: 10; with no mark yet, from the prediction; drawn at once, saved when
 * the key rests, one save at a time with the latest place queued), + and - zoom the photo,
 * Esc goes back to the table. Every change is saved at once (`photo:writeGcp`, atomic with a
 * `.bak`).
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../shell';
import {
  aimStart,
  applyMark,
  clickToPixel,
  confirmedMarks,
  crosshairArms,
  fineAim,
  inFrame,
  LOUPE_POWER,
  LOUPE_POWERS,
  loupeBackground,
  markerList,
  MIN_MARKS,
  nextToMark,
  nudged,
  ratioLabel,
  readCamerasFile,
  sfmPhotos,
  step,
  stepPower,
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
/** The loupe's diameter, CSS pixels (photo.css .ph-loupe). */
const LOUPE_BOX = 260;
/** The loupe's power on this computer (screen px per original photo px). */
const POWER_KEY = 'quadrion.gcpLoupePower';
/** Mouse wheel travel, CSS px, for one step of the loupe's power (a mouse notch is about 100). */
const WHEEL_STEP = 50;
/** A held arrow key's nudges are saved once it has rested this long, ms. */
const NUDGE_REST_MS = 150;
/** A press that moves further than this, CSS px, is a drag: it places no mark. */
const DRAG_PX = 4;

/** A nudged mark not yet on disk: drawn at once, saved by `flushNudge`. */
interface Pending {
  photo: string;
  px: Px;
  /** Enter was pressed on it: confirm and go to the next photo once saved. */
  advance: boolean;
}

function readPower(): number {
  try {
    const v = Number(localStorage.getItem(POWER_KEY));
    return (LOUPE_POWERS as readonly number[]).includes(v) ? v : LOUPE_POWER;
  } catch {
    return LOUPE_POWER;
  }
}

type Px = [number, number];
/** Where the photo is drawn in the viewer, CSS px. */
interface Layout {
  left: number;
  top: number;
  width: number;
  viewW: number;
  viewH: number;
}
const sameLayout = (a: Layout | null, b: Layout | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.viewW === b.viewW &&
    a.viewH === b.viewH);

/** The open crosshair on the photo: arms from 6 to 24 screen px off the mark. */
const MARK_GAP = 6;
const MARK_ARM = 24;

/**
 * The cursor loupe, decorative (the bar reads its power as text): the photo at `power` screen px
 * per original px around `at`, drawn centred on `centre` in the viewer, with the aim's crosshair
 * and the mark's when it is in view.
 */
function Loupe({
  url,
  size,
  power,
  at,
  centre,
  mark,
  aiming,
}: {
  url: string;
  size: readonly [number, number];
  power: number;
  at: Px;
  centre: Px;
  mark: { px: readonly [number, number]; state: string } | undefined;
  aiming: boolean;
}) {
  const h = LOUPE_BOX / 2;
  const bg = loupeBackground(at, size, LOUPE_BOX, power);
  const m: Px | null = mark
    ? [h + (mark.px[0] - at[0]) * power, h + (mark.px[1] - at[1]) * power]
    : null;
  // a mark under the aim (the loupe resting on it) is drawn as the mark, else the aim has its own
  const onAim = m !== null && Math.hypot(m[0] - h, m[1] - h) < 0.5;
  return (
    <div
      className="ph-loupe"
      aria-hidden="true"
      data-testid="marker-loupe"
      data-at={`${String(at[0])},${String(at[1])}`}
      data-power={power}
      data-aiming={aiming ? 'true' : undefined}
      style={{
        left: `${String(centre[0] - h)}px`,
        top: `${String(centre[1] - h)}px`,
        backgroundImage: `url("${url}")`,
        backgroundSize: bg.size,
        backgroundPosition: bg.position,
      }}
    >
      <svg width={LOUPE_BOX} height={LOUPE_BOX}>
        {m && !onAim && Math.hypot(m[0] - h, m[1] - h) < h + 30 && (
          <g className={`mk ${mark?.state ?? ''}`}>
            <Crosshair arms={crosshairArms(m, 1, 7, 30)} className="arm" />
          </g>
        )}
        <g className={onAim ? `mk ${mark?.state ?? ''}` : 'aim'}>
          <Crosshair arms={crosshairArms([h, h], 1, 7, 30)} className="arm" />
          <circle className="dot" cx={h} cy={h} r={0.75} />
        </g>
      </svg>
      <span className="ph-loupe-tag">
        {ratioLabel(power)} · {at[0].toFixed(1)}, {at[1].toFixed(1)}
      </span>
    </div>
  );
}

/** The loupe's centre: on the cursor or the mark, but held inside the viewer so all of it shows. */
function placeLoupe(l: Layout, c: Px): { x: number; y: number } {
  const h = LOUPE_BOX / 2;
  const fit = (v: number, max: number) =>
    max >= LOUPE_BOX ? Math.min(max - h, Math.max(h, v)) : max / 2;
  return { x: fit(c[0], l.viewW), y: fit(c[1], l.viewH) };
}

/** An open crosshair: four arms with a dark halo, the centre left clear. */
function Crosshair({
  arms,
  className,
  scaled,
}: {
  arms: [number, number, number, number][];
  className: string;
  /** Drawn in a scaled viewBox: keep the strokes their screen width. */
  scaled?: boolean;
}) {
  const ve = scaled ? 'non-scaling-stroke' : undefined;
  return (
    <>
      {arms.map(([x1, y1, x2, y2], i) => (
        <line
          key={`h${String(i)}`}
          className={`halo ${className}`}
          vectorEffect={ve}
          {...{ x1, y1, x2, y2 }}
        />
      ))}
      {arms.map(([x1, y1, x2, y2], i) => (
        <line
          key={`l${String(i)}`}
          className={className}
          vectorEffect={ve}
          {...{ x1, y1, x2, y2 }}
        />
      ))}
    </>
  );
}

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
  const [power, setPower] = useState(readPower);
  useEffect(() => {
    try {
      localStorage.setItem(POWER_KEY, String(power));
    } catch {
      // storage blocked: the power holds for this session only
    }
  }, [power]);
  /**
   * The cursor over the photo: where it is on screen and in the viewer, and the photo px it aims
   * at (aimed again whenever the photo moves under it).
   */
  const [hover, setHover] = useState<{ photo: string; client: Px; pos: Px; aim: Px } | null>(null);
  /** After an arrow key the loupe rests on the mark until the mouse moves. */
  const [restUntilMove, setRestUntilMove] = useState(false);
  /** A press on the photo: a pan (right or middle button, or Space held) or a possible click. */
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    pan: boolean;
    moved: boolean;
    done: boolean;
  } | null>(null);
  const space = useRef(false);
  const outer = useRef<HTMLDivElement>(null);
  const imgBox = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const measure = useCallback(() => {
    const img = imgBox.current;
    const o = outer.current;
    if (!img || !o) {
      setLayout(null);
      return;
    }
    const r = img.getBoundingClientRect();
    const v = o.getBoundingClientRect();
    const next = {
      left: r.left - v.left,
      top: r.top - v.top,
      width: r.width,
      viewW: v.width,
      viewH: v.height,
    };
    setLayout((old) => (sameLayout(old, next) ? old : next));
  }, []);
  // after every render (the zoom, the photo, the list beside it can move the photo), then on
  // scrolling and resizing
  useLayoutEffect(measure);
  useEffect(() => {
    const o = outer.current;
    if (!o || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    return () => {
      ro.disconnect();
    };
  }, [measure]);
  const [loadedSize, setLoadedSize] = useState<{ id: string; size: [number, number] } | null>(null);
  const [saving, setSaving] = useState(false);
  /** A mark action is being saved (`act`). */
  const busy = useRef(false);
  const pending = useRef<Pending | null>(null);
  /** The pending nudge as drawn. */
  const [pendingShown, setPendingShown] = useState<Pending | null>(null);
  const nudges = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    queued: boolean;
  }>({ timer: null, inFlight: false, queued: false });
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // leaving the marker within the rest of a held arrow still saves the nudge
  useEffect(
    () => () => {
      const st = nudges.current;
      if (st.timer !== null) {
        clearTimeout(st.timer);
        st.timer = null;
        void flushRef.current();
      }
    },
    [],
  );
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
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') space.current = false;
    };
    const blur = () => {
      space.current = false;
    };
    el.addEventListener('keyup', up);
    el.addEventListener('blur', blur);
    // the wheel over the photo steps the loupe's power (a native listener: React's is passive and
    // could not keep the viewer from scrolling)
    let travel = 0;
    const wheel = (e: WheelEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.ph-mk-img')) return;
      e.preventDefault();
      travel += e.deltaY;
      if (Math.abs(travel) < WHEEL_STEP) return;
      const dir = travel < 0 ? 1 : -1;
      travel = 0;
      setPower((p) => stepPower(p, dir));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('keydown', fn);
      el.removeEventListener('keyup', up);
      el.removeEventListener('blur', blur);
      el.removeEventListener('wheel', wheel);
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
  const size = current?.photo.size ?? [1, 1];
  /** What a save builds on: the props, and the file as last saved until they catch up. */
  const latest = useRef({ point, gcp, onSave, photos, frame, gsdCm });
  useLayoutEffect(() => {
    latest.current = { point, gcp, onSave, photos, frame, gsdCm };
  }, [point, gcp, onSave, photos, frame, gsdCm]);
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
  const act = async (a: MarkAction, advance: boolean): Promise<boolean | null> => {
    if (busy.current) return null;
    busy.current = true;
    setSaving(true);
    // the point and the file as last saved (a queued nudge runs before the panel renders again)
    const at = latest.current;
    const next = applyMark(at.point, a, new Date().toISOString());
    const file = withPoint(at.gcp, next);
    const ok = await at.onSave(file);
    busy.current = false;
    setSaving(false);
    // the next photo that still needs a mark, in the list as this mark leaves it; a placed mark
    // keeps its photo, wherever the list now has it
    if (ok) {
      latest.current = { ...latest.current, point: next, gcp: file };
      setShown(
        advance
          ? nextToMark(markerList(file, next, at.photos, at.frame, at.gsdCm), next, a.photo)
          : a.photo,
      );
    }
    // a nudge that waited for this save goes now
    const st = nudges.current;
    if (st.queued && !st.inFlight) void flushRef.current();
    return ok;
  };

  /**
   * Save the pending nudge: one save at a time; a nudge made meanwhile waits and goes, as its
   * latest place, when the save in flight answers.
   */
  const flushNudge = async () => {
    const st = nudges.current;
    if (st.timer !== null) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    const p = pending.current;
    if (!p) return;
    if (st.inFlight || busy.current) {
      st.queued = true;
      return;
    }
    st.queued = false;
    st.inFlight = true;
    const ok = await act({ kind: 'place', photo: p.photo, px: p.px }, p.advance);
    st.inFlight = false;
    if (ok === false) {
      // main refused it: show what is on disk
      pending.current = null;
      setPendingShown(null);
    } else if (ok && pending.current === p && p.advance) pending.current = { ...p, advance: false };
    // a nudge made while this one was saving (st.queued is set across the await)
    if (nudges.current.queued) void flushRef.current();
  };
  const go = (by: 1 | -1) => {
    if (pending.current) void flushRef.current();
    setShown(list[step(index, list.length, by)]?.photo.id ?? null);
  };
  const confirm = () => {
    if (!current) return;
    // a nudged mark: confirmed where it was nudged to, once its save is through
    const p = pending.current;
    if (p?.photo === current.photo.id) {
      pending.current = { ...p, advance: true };
      void flushRef.current();
      return;
    }
    const px = mark?.px ?? predicted;
    if (!px) return;
    void act({ kind: 'confirm', photo: current.photo.id, px: [px[0], px[1]] }, true);
  };
  const skip = () => {
    if (!current) return;
    if (pending.current?.photo === current.photo.id && !nudges.current.inFlight) {
      const st = nudges.current;
      if (st.timer !== null) clearTimeout(st.timer);
      st.timer = null;
      pending.current = null;
      setPendingShown(null);
    }
    const px = predicted;
    void act(
      { kind: 'skip', photo: current.photo.id, ...(px ? { px: [px[0], px[1]] } : {}) },
      true,
    );
  };
  /** The arrow keys: the mark (else the prediction) moved by whole original pixels. */
  const nudge = (by: Px) => {
    if (!current) return;
    const id = current.photo.id;
    const p = pending.current;
    const from = p?.photo === id ? p.px : aimStart(mark, predicted);
    if (!from) return;
    const next: Pending = { photo: id, px: nudged(from, by, size), advance: false };
    pending.current = next;
    setPendingShown(next);
    setRestUntilMove(true);
    const st = nudges.current;
    if (st.timer !== null) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      void flushRef.current();
    }, NUDGE_REST_MS);
  };
  const arrows: Record<string, Px | undefined> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    const arrow = arrows[k];
    if (arrow) {
      if (e.ctrlKey || e.altKey) return;
      const d = e.shiftKey ? 10 : 1;
      nudge([arrow[0] * d, arrow[1] * d]);
    } else if (k === 'Enter' || k === 'c' || k === 'C') confirm();
    else if (k === 's' || k === 'S') skip();
    else if (k === 'n' || k === 'N') go(1);
    else if (k === 'p' || k === 'P') go(-1);
    else if (k === '+' || k === '=') setZoom((z) => Math.min(ZOOMS.length - 1, z + 1));
    else if (k === '-') setZoom((z) => Math.max(0, z - 1));
    else if (k === 'Escape') onBack();
    // Space held: the left button pans (and the viewer does not scroll a page)
    else if (k === ' ') space.current = true;
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    keyRef.current = onKey;
  });
  useLayoutEffect(() => {
    flushRef.current = flushNudge;
  });

  // the photo moved under a still cursor (a save re-centring it, a pan, a scroll, a zoom): aim
  // again where the cursor is
  useEffect(() => {
    const el = imgBox.current;
    const o = outer.current;
    if (!el || !o) return;
    setHover((h) => {
      if (!h) return h;
      const v = o.getBoundingClientRect();
      const aim = clickToPixel(h.client, el.getBoundingClientRect(), size);
      const pos: Px = [h.client[0] - v.left, h.client[1] - v.top];
      const same =
        aim[0] === h.aim[0] && aim[1] === h.aim[1] && pos[0] === h.pos[0] && pos[1] === h.pos[1];
      return same ? h : { ...h, aim, pos };
    });
    // `size` goes with the photo, which changes the layout too
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // a saved nudge is forgotten once the marks show it, or its photo is left
  const markPx = mark?.px;
  useLayoutEffect(() => {
    const p = pending.current;
    const st = nudges.current;
    if (!p || st.inFlight || st.queued || st.timer !== null || p.advance) return;
    const there = markPx?.[0] === p.px[0] && markPx[1] === p.px[1];
    if (there || p.photo !== currentId) {
      pending.current = null;
      setPendingShown(null);
    }
  }, [markPx, currentId, pendingShown]);

  if (!project) return null;
  const ring = current?.prediction;
  // the photo as shown, screen px per original px; `unit` is the inverse, for constant-size marks
  const scale = layout && layout.width > 0 ? layout.width / size[0] : 0;
  const unit = scale > 0 ? 1 / scale : 1;
  const aiming = current && hover?.photo === current.photo.id && !restUntilMove ? hover : null;
  const nudgedHere = current && pendingShown?.photo === current.photo.id ? pendingShown : null;
  const markShown = nudgedHere
    ? { px: nudgedHere.px, state: 'confirmed' as const, by: 'person' as const }
    : mark && mark.state !== 'skipped'
      ? mark
      : undefined;
  /** Where the loupe looks, in photo px, and where its centre is drawn, in the viewer. */
  const rest = aimStart(markShown, predicted);
  const loupe = aiming
    ? {
        at: aiming.aim,
        ...(layout ? placeLoupe(layout, aiming.pos) : { x: aiming.pos[0], y: aiming.pos[1] }),
      }
    : rest && layout && scale > 0
      ? {
          at: rest,
          ...placeLoupe(layout, [layout.left + rest[0] * scale, layout.top + rest[1] * scale]),
        }
      : null;
  /** The cursor in the viewer, CSS px. */
  const inViewer = (e: { clientX: number; clientY: number }): Px => {
    const v = outer.current?.getBoundingClientRect();
    return v ? [e.clientX - v.left, e.clientY - v.top] : [e.clientX, e.clientY];
  };

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
        <div className="ph-mk-viewer" ref={outer}>
          <div
            ref={viewer}
            className="ph-mk-scroll"
            tabIndex={0}
            role="group"
            aria-label={`Photo ${current?.photo.name ?? ''} of ${point.id}. Enter confirms, S skips, N and P change photo, the arrow keys move the mark, plus and minus zoom.`}
            aria-keyshortcuts="Enter C S N P ArrowLeft ArrowRight ArrowUp ArrowDown + - Escape"
            data-testid="marker-viewer"
            onScroll={measure}
          >
            {current ? (
              <>
                <div
                  ref={imgBox}
                  className={`ph-mk-img ${natural ? 'aiming' : ''}`}
                  style={{
                    width: `${String((ZOOMS[zoom] ?? 1) * 100)}%`,
                    ...(imageUrl ? {} : { aspectRatio: `${String(size[0])} / ${String(size[1])}` }),
                  }}
                  onPointerDown={(e) => {
                    const pan =
                      e.button === 1 || e.button === 2 || (e.button === 0 && space.current);
                    const el = viewer.current;
                    drag.current = {
                      x: e.clientX,
                      y: e.clientY,
                      left: el?.scrollLeft ?? 0,
                      top: el?.scrollTop ?? 0,
                      pan,
                      moved: false,
                      done: false,
                    };
                    if (!pan) return;
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      // no pointer to capture (a synthetic event): the pan still follows the photo
                    }
                  }}
                  onPointerUp={() => {
                    if (drag.current) drag.current.done = true;
                  }}
                  onMouseDown={(e) => {
                    // no middle-button autoscroll: the middle button pans
                    if (e.button === 1) e.preventDefault();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (d && !d.done) {
                      const dx = e.clientX - d.x;
                      const dy = e.clientY - d.y;
                      if (Math.hypot(dx, dy) > DRAG_PX) d.moved = true;
                      const el = viewer.current;
                      if (d.pan && el) {
                        el.scrollLeft = d.left - dx;
                        el.scrollTop = d.top - dy;
                      }
                    }
                    setRestUntilMove(false);
                    const pos = inViewer(e);
                    const id = current.photo.id;
                    const at = clickToPixel(
                      [e.clientX, e.clientY],
                      e.currentTarget.getBoundingClientRect(),
                      size,
                    );
                    const client: Px = [e.clientX, e.clientY];
                    setHover((h) =>
                      // Shift: fine aim, the loupe's centre moves at loupe speed
                      e.shiftKey && h?.photo === id
                        ? {
                            photo: id,
                            client,
                            pos,
                            aim: fineAim(
                              h.aim,
                              [pos[0] - h.pos[0], pos[1] - h.pos[1]],
                              power,
                              size,
                            ),
                          }
                        : { photo: id, client, pos, aim: at },
                    );
                  }}
                  onPointerLeave={() => {
                    setHover(null);
                  }}
                  onClick={(e) => {
                    // a pan, or a press that moved, places no mark
                    const d = drag.current;
                    drag.current = null;
                    if (d && (d.pan || d.moved)) return;
                    const px =
                      aiming?.aim ??
                      clickToPixel(
                        [e.clientX, e.clientY],
                        e.currentTarget.getBoundingClientRect(),
                        size,
                      );
                    void act({ kind: 'place', photo: current.photo.id, px: [px[0], px[1]] }, false);
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
                    {markShown && (
                      <g
                        className={`mk ${markShown.state}`}
                        data-testid="marker-mark"
                        data-px={`${String(markShown.px[0])},${String(markShown.px[1])}`}
                        data-unit={unit}
                      >
                        <Crosshair
                          arms={crosshairArms(markShown.px, unit, MARK_GAP, MARK_ARM)}
                          className="arm"
                          scaled
                        />
                      </g>
                    )}
                  </svg>
                </div>
              </>
            ) : (
              <p className="faint small">No photo to show.</p>
            )}
          </div>
          {current && loupe && natural && imageUrl && (
            <Loupe
              url={imageUrl}
              size={size}
              power={power}
              at={loupe.at}
              centre={[loupe.x, loupe.y]}
              mark={markShown}
              aiming={!!aiming}
            />
          )}
        </div>
        <div className="ph-mk-bar">
          <span className="small faint">
            {current
              ? `${String(index + 1)} of ${String(list.length)} · ${mark ? `mark ${mark.state} (${mark.by})` : ring ? 'predicted, not marked' : 'not marked'}`
              : ''}
            {saving ? ' · saving' : ''}
          </span>
          {scale > 0 && (
            <span className="ph-mk-scale small" data-testid="marker-scale">
              Photo {ratioLabel(scale)} · loupe {ratioLabel(power)}
            </span>
          )}
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
