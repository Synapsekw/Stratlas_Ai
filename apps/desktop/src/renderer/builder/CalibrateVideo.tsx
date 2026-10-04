import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import type { CameraOrientation, Layer, LensModel, Vec3 } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import {
  NO_ORIENTATION,
  autoAlign,
  composeOrientation,
  fitCalibration,
  grayFromRgba,
  interpolatePose,
  isZeroOrientation,
  pairErrorPx,
  projectCalibrated,
  setCalibrationLens,
  setCalibrationOrientation,
  setCalibrationPosition,
  setCameraMode,
  setProjection,
  videoRig,
  type CalibrationFit,
  type CalibrationState,
  type LensPair,
  type PoseLookup,
} from '@aio/video';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { clipVideoTime, parseCoordinate } from './model';
import { useStagePick } from './pick';
import { builder } from './state';

type VideoLayer = Extract<Layer, { kind: 'video' }>;
type Step = 'image' | 'model' | null;
type Axis = 'pitchDeg' | 'yawDeg' | 'rollDeg';

const FRAME_MS = 1000 / 30;
/** Pairs drawn on the frame: those picked within a frame of the current video time. */
const SAME_FRAME_MS = 40;
/** Edge agreement below this ratio to the search median reads as no clear answer. */
const AUTO_MIN_CONTRAST = 1.15;

const AXES: {
  key: Axis;
  label: 'calibrate.orient.pitch' | 'calibrate.orient.yaw' | 'calibrate.orient.roll';
}[] = [
  { key: 'pitchDeg', label: 'calibrate.orient.pitch' },
  { key: 'yawDeg', label: 'calibrate.orient.yaw' },
  { key: 'rollDeg', label: 'calibrate.orient.roll' },
];

/** Position offset fields: east (+x), north (-z), up (+y) of the local frame. */
const POS_AXES: {
  label: 'calibrate.pos.east' | 'calibrate.pos.north' | 'calibrate.pos.up';
  index: 0 | 1 | 2;
  sign: 1 | -1;
}[] = [
  { label: 'calibrate.pos.east', index: 0, sign: 1 },
  { label: 'calibrate.pos.north', index: 2, sign: -1 },
  { label: 'calibrate.pos.up', index: 1, sign: 1 },
];

function useScene(): SceneHandle | null {
  const [h, setH] = useState<SceneHandle | null>(() => getActiveScene());
  useEffect(() => onActiveScene(setH), []);
  return h;
}

/** Overlay rectangle of the video frame on the 3D pane: full height, centred, lens aspect. */
function useFrameRect(pane: HTMLElement | null, aspect: number) {
  const [rect, setRect] = useState({ left: 0, width: 0, height: 0 });
  useEffect(() => {
    if (!pane) return;
    const update = () => {
      const r = pane.getBoundingClientRect();
      const width = r.height * aspect;
      setRect({ left: (r.width - width) / 2, width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    return () => {
      ro.disconnect();
    };
  }, [pane, aspect]);
  return rect;
}

const fmt = (v: number, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

/** The frame the overlay video shows, as a grey image `width` pixels wide. */
function grabFrame(v: HTMLVideoElement, width: number, aspect: number) {
  if (v.readyState < 2 || !v.videoWidth) return null;
  const height = Math.max(1, Math.round(width / aspect));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(v, 0, 0, width, height);
  return grayFromRgba(g.getImageData(0, 0, width, height).data, width, height);
}

/**
 * Video calibration against the 3D model in drone-eye view: the clip's frame is laid over the
 * rendered model. Time offset: scrub to a visible event and nudge until frame and model agree.
 * Field of view: drag across the frame. Orientation: the camera's pitch, yaw and roll against the
 * flight log, typed, refined automatically by edges, or fitted with the field of view and time
 * offset from point pairs (frame pixel and model point) by least squares with the position fixed
 * by the log. Saves `offsetMs`, `lens` and `orientation` to the clip (lens to clips of the same
 * frame size, orientation to the clips of the same flight).
 */
export function CalibrateVideo({ layerId }: { layerId: string }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const nowMs = useWorkspace((s) => s.nowMs);
  const clips = useMemo(
    () => (project?.manifest.layers ?? []).filter((l): l is VideoLayer => l.kind === 'video'),
    [project],
  );
  const clip = clips.find((c) => c.id === layerId) ?? clips[0];
  const scene = useScene();
  const [hfov, setHfov] = useState(clip?.lens.hfovDeg ?? 70);
  const [offsetMs, setOffsetMs] = useState(clip?.offsetMs ?? 0);
  const [orient, setOrient] = useState<CameraOrientation>(clip?.orientation ?? NO_ORIENTATION);
  const [offset, setOffset] = useState<Vec3>(clip?.positionOffsetM ?? [0, 0, 0]);
  const [opacity, setOpacity] = useState(0.5);
  const [pairs, setPairs] = useState<LensPair[]>([]);
  const [pendingImage, setPendingImage] = useState<[number, number] | null>(null);
  const [step, setStep] = useState<Step>(null);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<CalibrationFit | null>(null);
  const [fitWhat, setFitWhat] = useState({
    orientation: true,
    position: true,
    fov: false,
    time: false,
  });
  const [allSame, setAllSame] = useState(true);
  const [allFlight, setAllFlight] = useState(true);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState<{ text: string; tone?: 'armed' | 'bad' } | null>(null);
  const [saving, setSaving] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const pane = document.querySelector<HTMLElement>('.pane-3d');
  const rect = useFrameRect(pane, clip?.lens.aspect ?? 16 / 9);

  const [videoWidth, setVideoWidth] = useState(1920);

  // the clip under calibration is the active clip (the panel remounts per clip)
  useEffect(() => {
    if (!clip) return;
    if (workspace.getState().activeClip !== clip.id) {
      workspace.getState().setActiveClip(clip.id);
      workspace.getState().setTime(clip.flight.startUtcMs + clip.offsetMs + 2000);
    }
  }, [clip]);

  // drone-eye view with the projection off while calibrating; restored on close
  useEffect(() => {
    if (!scene) return;
    workspace.getState().pause();
    setCameraMode(scene, 'drone');
    setProjection(scene, { enabled: false });
    return () => {
      setCalibrationLens(scene, null);
      setCalibrationOrientation(scene, null);
      setCalibrationPosition(scene, null);
      setProjection(scene, { enabled: true });
      setCameraMode(scene, 'free');
    };
  }, [scene]);

  const lens: LensModel | null = clip ? { ...clip.lens, hfovDeg: hfov } : null;
  useEffect(() => {
    if (scene && lens) setCalibrationLens(scene, lens);
    // lens is rebuilt from hfov each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, hfov, clip]);

  // live preview of the trial orientation in the drone-eye view, frustum and projection
  useEffect(() => {
    if (scene) setCalibrationOrientation(scene, orient);
  }, [scene, orient]);
  useEffect(() => {
    if (scene) setCalibrationPosition(scene, offset);
  }, [scene, offset]);

  // the overlay shows the frame at the trial offset
  const videoMs = clip ? clipVideoTime(clip, nowMs, offsetMs) * 1000 : 0;
  useEffect(() => {
    const v = video.current;
    if (!v || !clip) return;
    const tv = clipVideoTime(clip, nowMs, offsetMs);
    if (Math.abs(v.currentTime - tv) > 0.004) v.currentTime = tv;
  }, [nowMs, offsetMs, clip]);

  /** Logged poses of this clip's flight, so pairs follow a changed time offset. */
  const poseAt = useMemo<PoseLookup | undefined>(() => {
    const flight = scene && clip ? videoRig(scene).flightOf(clip.id) : null;
    if (!flight) return undefined;
    return (ms) => {
      const p = interpolatePose(flight.samples, ms);
      return { pos: p.pos, q: p.q };
    };
    // the flight loads with the layer; re-read when the pairs change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, clip, pairs.length]);

  const addPair = (world: Vec3) => {
    const pose = scene ? videoRig(scene).loggedPose() : null;
    if (!pendingImage || !pose) return;
    setPairs((p) => [...p, { image: pendingImage, world, pos: pose.pos, q: pose.q, videoMs }]);
    setPendingImage(null);
    setStep(null);
    setSay({ text: t('calibrate.say.added') });
  };

  useStagePick(step === 'model', (hit) => {
    if (!hit) {
      setSay({ text: t('calibrate.say.nothing'), tone: 'bad' });
      return;
    }
    addPair([hit.point.x, hit.point.y, hit.point.z]);
  });

  const drag = useRef<{ x: number; h: number } | null>(null);
  const onFrameDown = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (step === 'image') {
      setPendingImage([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
      setStep('model');
      setSay({ text: t('calibrate.say.clickModel'), tone: 'armed' });
      return;
    }
    drag.current = { x: e.clientX, h: hfov };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onFrameMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setHfov(Math.min(150, Math.max(5, Math.round((d.h + (e.clientX - d.x) * 0.05) * 100) / 100)));
  };
  const onFrameUp = () => {
    drag.current = null;
  };

  const trial: CalibrationState | null = lens
    ? { lens, orientation: orient, offsetMs, positionOffset: offset }
    : null;

  const runFit = () => {
    if (!trial) return;
    try {
      const r = fitCalibration(pairs, trial, {
        widthPx: videoWidth,
        orientation: fitWhat.orientation,
        position: fitWhat.position,
        fov: fitWhat.fov,
        time: fitWhat.time,
        ...(poseAt ? { poseAt } : {}),
      });
      setResult(r);
      setHfov(r.state.lens.hfovDeg);
      setOrient(r.state.orientation);
      setOffsetMs(r.state.offsetMs);
      if (r.state.positionOffset) setOffset(r.state.positionOffset);
      const o = r.state.orientation;
      const d = r.state.positionOffset ?? offset;
      const values = [
        fitWhat.orientation
          ? `${t('calibrate.orient.pitch')} ${fmt(o.pitchDeg)}°, ${t('calibrate.orient.yaw')} ${fmt(o.yawDeg)}°, ${t('calibrate.orient.roll')} ${fmt(o.rollDeg)}°`
          : '',
        fitWhat.position
          ? `${t('calibrate.pos.title')} ${t('calibrate.pos.enu', { e: fmt(d[0], 1), n: fmt(-d[2], 1), u: fmt(d[1], 1) })}`
          : '',
        fitWhat.fov ? `${t('calibrate.fov.title')} ${fmt(r.state.lens.hfovDeg)}°` : '',
        fitWhat.time ? `${t('calibrate.time.title')} ${String(r.state.offsetMs)} ms` : '',
      ]
        .filter(Boolean)
        .join('; ');
      setSay({ text: t('calibrate.say.fitted', { count: pairs.length, values }) });
    } catch (e) {
      setSay({ text: e instanceof Error ? e.message : String(e), tone: 'bad' });
    }
  };

  const runAuto = async () => {
    const v = video.current;
    if (!scene || !lens || !v) return;
    if (lens.model !== 'pinhole') {
      setSay({ text: t('calibrate.orient.autoPinhole'), tone: 'bad' });
      return;
    }
    setBusy(true);
    setSay({ text: t('calibrate.orient.autoRunning'), tone: 'armed' });
    // let the panel paint, and the rig take the trial orientation, before the work
    await new Promise((r) => setTimeout(r, 50));
    try {
      const frame = grabFrame(v, 480, lens.aspect);
      const render = videoRig(scene).renderModelView(480);
      if (!frame || !render) {
        setSay({ text: t('calibrate.orient.autoNoFrame'), tone: 'bad' });
        return;
      }
      const r = autoAlign(render, frame, lens);
      if (r.contrast < AUTO_MIN_CONTRAST || r.score <= r.startScore) {
        setSay({ text: t('calibrate.orient.autoWeak', { after: fmt(r.score) }), tone: 'bad' });
        return;
      }
      const next = composeOrientation(orient, r.delta);
      setOrient(next);
      setSay({
        text: t('calibrate.orient.autoDone', {
          pitch: fmt(next.pitchDeg),
          yaw: fmt(next.yawDeg),
          roll: fmt(next.rollDeg),
          before: fmt(r.startScore),
          after: fmt(r.score),
        }),
      });
    } catch (e) {
      setSay({ text: e instanceof Error ? e.message : String(e), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  const sameSize = clip
    ? clips.filter((c) => Math.abs(c.lens.aspect - clip.lens.aspect) < 1e-3)
    : [];
  const flightKey = (c: VideoLayer) => JSON.stringify(c.flight.src);
  const sameFlight = clip ? clips.filter((c) => flightKey(c) === flightKey(clip)) : [];
  const save = async () => {
    if (!clip || !lens) return;
    setSaving(true);
    const orientation = isZeroOrientation(orient, 5e-4) ? null : orient;
    const positionOffsetM = offset.every((v) => Math.abs(v) < 5e-4) ? null : offset;
    const lensOthers = allSame ? sameSize.filter((c) => c.id !== clip.id).map((c) => c.id) : [];
    const flightOthers = allFlight
      ? sameFlight.filter((c) => c.id !== clip.id).map((c) => c.id)
      : [];
    const b = builder.getState();
    let err = await b.saveLayers([clip.id], { offsetMs, lens, orientation, positionOffsetM });
    if (!err && lensOthers.length) err = await b.saveLayers(lensOthers, { lens });
    if (!err && flightOthers.length)
      err = await b.saveLayers(flightOthers, { orientation, positionOffsetM });
    setSaving(false);
    const touched = new Set([clip.id, ...lensOthers, ...flightOthers]).size;
    setSay(
      err
        ? { text: err, tone: 'bad' }
        : {
            text: t('calibrate.save.done', {
              offset: String(Math.round(offsetMs)),
              fov: hfov.toFixed(2),
              pitch: fmt(orient.pitchDeg),
              yaw: fmt(orient.yawDeg),
              roll: fmt(orient.rollDeg),
              position: t('calibrate.pos.enu', {
                e: fmt(offset[0], 1),
                n: fmt(-offset[2], 1),
                u: fmt(offset[1], 1),
              }),
              clips: t('calibrate.save.clips', { count: touched }),
            }),
          },
    );
  };

  if (!project || !clip || !lens || !trial)
    return (
      <section className="b-align" aria-label={t('calibrate.title')}>
        <header>
          <Icon name="video" size={14} />
          <b>{t('calibrate.title')}</b>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              builder.getState().stopAlign();
            }}
          >
            {t('calibrate.close')}
          </button>
        </header>
        <div className="sec say">{t('calibrate.noClip')}</div>
      </section>
    );

  const widthPx = videoWidth;
  const residual = (p: LensPair) => pairErrorPx(p, trial, widthPx, poseAt);
  const rms = pairs.length
    ? Math.sqrt(pairs.reduce((m, p) => m + (residual(p) ?? widthPx) ** 2, 0) / pairs.length)
    : null;
  const origin = project.manifest.origin;
  const epsg = 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : 0;
  const onFrame = (p: LensPair) =>
    p.videoMs === undefined || Math.abs(p.videoMs - videoMs) < SAME_FRAME_MS;

  const overlay = pane
    ? createPortal(
        <div className="b-overlay" data-testid="calibration-overlay">
          <div
            className={`frame ${step === 'image' ? 'pick' : step === 'model' ? '' : 'drag'}`}
            style={{ left: rect.left, width: rect.width, height: rect.height }}
            onPointerDown={onFrameDown}
            onPointerMove={onFrameMove}
            onPointerUp={onFrameUp}
            data-testid="calibration-frame"
          >
            <video
              ref={video}
              src={assetUrl(project.id, clip.src)}
              crossOrigin="anonymous"
              muted
              playsInline
              preload="auto"
              style={{ opacity }}
              onLoadedMetadata={(e) => {
                if (e.currentTarget.videoWidth) setVideoWidth(e.currentTarget.videoWidth);
              }}
              onLoadedData={(e) => {
                e.currentTarget.currentTime = clipVideoTime(
                  clip,
                  workspace.getState().nowMs,
                  offsetMs,
                );
              }}
            />
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              {pairs.map((p, i) => {
                if (!onFrame(p)) return null;
                const im = projectCalibrated(p, trial, poseAt);
                return (
                  <g key={i} vectorEffect="non-scaling-stroke">
                    {im && (
                      <line
                        x1={p.image[0]}
                        y1={p.image[1]}
                        x2={im[0]}
                        y2={im[1]}
                        stroke="#f4b740"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    <ellipse
                      cx={p.image[0]}
                      cy={p.image[1]}
                      rx={6 / Math.max(1, rect.width)}
                      ry={6 / Math.max(1, rect.height)}
                      fill="none"
                      stroke="#60d3b2"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              })}
              {pendingImage && (
                <ellipse
                  cx={pendingImage[0]}
                  cy={pendingImage[1]}
                  rx={7 / Math.max(1, rect.width)}
                  ry={7 / Math.max(1, rect.height)}
                  fill="none"
                  stroke="#73ebc8"
                  strokeWidth={2.5}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            <span className="tag">
              {t('calibrate.tag', {
                clip: clip.name,
                fov: hfov.toFixed(2),
                offset: String(Math.round(offsetMs)),
                pitch: fmt(orient.pitchDeg),
                yaw: fmt(orient.yawDeg),
                roll: fmt(orient.rollDeg),
                up: fmt(offset[1], 1),
              })}
            </span>
          </div>
        </div>,
        pane,
      )
    : null;

  const setAxis = (k: Axis, v: number) => {
    if (!Number.isFinite(v)) return;
    setOrient((o) => ({ ...o, [k]: Math.min(45, Math.max(-45, v)) }));
  };

  return (
    <>
      {overlay}
      <section className="b-align" aria-label={t('calibrate.title')} data-testid="calibrate-video">
        <header>
          <Icon name="video" size={14} />
          <b>{t('calibrate.title')}</b>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              builder.getState().stopAlign();
            }}
          >
            {t('calibrate.close')}
          </button>
        </header>
        <div className="scroll">
          <div className="sec">
            <select
              className="input"
              value={clip.id}
              aria-label={t('calibrate.clip')}
              onChange={(e) => {
                builder.getState().startAlign({ kind: 'video', layerId: e.target.value });
              }}
            >
              {clips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <label className="b-inline">
              <span className="faint">{t('calibrate.frame')}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                aria-label={t('calibrate.frameOpacity')}
                onChange={(e) => {
                  setOpacity(Number(e.target.value));
                }}
                style={{ flex: 1 }}
              />
            </label>
          </div>

          <div className="sec">
            <b>{t('calibrate.time.title')}</b>
            <p className="say">{t('calibrate.time.help')}</p>
            <div className="b-inline">
              <input
                className="input mono"
                type="number"
                step={1}
                value={Math.round(offsetMs)}
                aria-label={t('calibrate.time.input')}
                onChange={(e) => {
                  setOffsetMs(Number(e.target.value));
                }}
              />
              <span className="faint">{t('calibrate.time.ms')}</span>
            </div>
            <div className="acts">
              {(
                [
                  ['calibrate.time.back1s', -1000],
                  ['calibrate.time.back1f', -FRAME_MS],
                  ['calibrate.time.fwd1f', FRAME_MS],
                  ['calibrate.time.fwd1s', 1000],
                ] as const
              ).map(([label, d]) => (
                <button
                  key={label}
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setOffsetMs((o) => Math.round(o + d));
                  }}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          </div>

          <div className="sec">
            <b>{t('calibrate.fov.title')}</b>
            <p className="say">{t('calibrate.fov.help')}</p>
            <div className="b-inline">
              <input
                type="range"
                min={20}
                max={130}
                step={0.05}
                value={hfov}
                aria-label={t('calibrate.fov.slider')}
                onChange={(e) => {
                  setHfov(Number(e.target.value));
                }}
                style={{ flex: 1 }}
              />
              <input
                className="input mono"
                style={{ maxWidth: 80 }}
                type="number"
                step={0.01}
                value={hfov}
                aria-label={t('calibrate.fov.input')}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v > 1 && v < 179) setHfov(v);
                }}
              />
              <span className="faint">°</span>
            </div>
          </div>

          <div className="sec" data-testid="calibrate-orientation">
            <b>{t('calibrate.orient.title')}</b>
            <p className="say">{t('calibrate.orient.help')}</p>
            {AXES.map(({ key, label }) => (
              <div className="b-inline" key={key}>
                <span className="faint" style={{ width: 36 }}>
                  {t(label)}
                </span>
                <input
                  type="range"
                  min={-15}
                  max={15}
                  step={0.05}
                  value={orient[key]}
                  aria-label={t('calibrate.orient.slider', { axis: t(label) })}
                  onChange={(e) => {
                    setAxis(key, Number(e.target.value));
                  }}
                  style={{ flex: 1 }}
                />
                <input
                  className="input mono"
                  style={{ maxWidth: 80 }}
                  type="number"
                  step={0.01}
                  value={Math.round(orient[key] * 1000) / 1000}
                  aria-label={t('calibrate.orient.input', { axis: t(label) })}
                  onChange={(e) => {
                    setAxis(key, Number(e.target.value));
                  }}
                />
                <span className="faint">°</span>
              </div>
            ))}
            <div className="acts">
              <button
                type="button"
                className="btn"
                disabled={busy}
                title={t('calibrate.orient.autoTip')}
                onClick={() => void runAuto()}
                data-testid="orient-auto"
              >
                <Icon name="target" size={14} />
                {t('calibrate.orient.auto')}
              </button>
            </div>
          </div>

          <div className="sec" data-testid="calibrate-position">
            <b>{t('calibrate.pos.title')}</b>
            <p className="say">{t('calibrate.pos.help')}</p>
            <div className="b-inline">
              {POS_AXES.map(({ label, index, sign }) => (
                <label key={label} className="b-inline" style={{ flex: 1 }}>
                  <span className="faint">{t(label)}</span>
                  <input
                    className="input mono"
                    type="number"
                    step={0.1}
                    value={Math.round(sign * offset[index] * 100) / 100}
                    aria-label={t('calibrate.pos.input', { axis: t(label) })}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v) || Math.abs(v) > 500) return;
                      setOffset((o) => {
                        const n: Vec3 = [o[0], o[1], o[2]];
                        n[index] = sign * v;
                        return n;
                      });
                    }}
                  />
                </label>
              ))}
              <span className="faint">m</span>
            </div>
          </div>

          <div className="sec">
            <b>{t('calibrate.pairs.title')}</b>
            <p className="say">{t('calibrate.pairs.help')}</p>
            <div className="acts">
              <button
                type="button"
                className={`btn${step === 'image' ? ' primary' : ''}`}
                onClick={() => {
                  setStep('image');
                  setPendingImage(null);
                  setSay({ text: t('calibrate.say.clickFrame'), tone: 'armed' });
                }}
                data-testid="add-pair"
              >
                <Icon name="point" size={14} />
                {t('calibrate.pairs.add')}
              </button>
              <button
                type="button"
                className="btn"
                disabled={pairs.length < 2}
                onClick={runFit}
                data-testid="fit-lens"
              >
                <Icon name="target" size={14} />
                {t('calibrate.pairs.fit')}
              </button>
              {pairs.length > 0 && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setPairs([]);
                    setResult(null);
                  }}
                >
                  {t('calibrate.pairs.clear')}
                </button>
              )}
            </div>
            <fieldset className="b-inline" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="faint" style={{ float: 'left', marginRight: 6 }}>
                {t('calibrate.pairs.fitWhat')}
              </legend>
              {(
                [
                  ['orientation', 'calibrate.pairs.fitOrientation'],
                  ['position', 'calibrate.pairs.fitPosition'],
                  ['fov', 'calibrate.pairs.fitFov'],
                  ['time', 'calibrate.pairs.fitTime'],
                ] as const
              ).map(([k, label]) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={fitWhat[k]}
                    onChange={(e) => {
                      setFitWhat((f) => ({ ...f, [k]: e.target.checked }));
                    }}
                    data-testid={`fit-${k}`}
                  />
                  <span>{t(label)}</span>
                </label>
              ))}
            </fieldset>
            {step === 'model' && (
              <form
                className="b-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  const p = parseCoordinate(typed, epsg);
                  if (!p) {
                    setSay({ text: t('calibrate.say.typeCoord'), tone: 'bad' });
                    return;
                  }
                  addPair([p[0] - origin[0], p[2] - origin[2], 0 - (p[1] - origin[1])]);
                  setTyped('');
                }}
              >
                <input
                  className="input mono"
                  value={typed}
                  placeholder={t('calibrate.coord.placeholder')}
                  aria-label={t('calibrate.coord.label')}
                  onChange={(e) => {
                    setTyped(e.target.value);
                  }}
                />
                <button type="submit" className="btn">
                  {t('calibrate.coord.add')}
                </button>
              </form>
            )}
            {say && <p className={`say ${say.tone ?? ''}`}>{say.text}</p>}
            {pairs.length > 0 && (
              <table className="b-pairs" aria-label={t('calibrate.pairs.table')}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('calibrate.pairs.colFrame')}</th>
                    <th className="r">{t('calibrate.pairs.colError')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((p, i) => {
                    const r = residual(p);
                    return (
                      <tr key={i} data-testid="pair-row">
                        <td>{i + 1}</td>
                        <td>
                          {(p.image[0] * widthPx).toFixed(0)}{' '}
                          {((p.image[1] * widthPx) / lens.aspect).toFixed(0)}
                        </td>
                        <td className={`r${r !== null && r > 20 ? ' hot' : ''}`}>
                          {r === null
                            ? t('calibrate.pairs.behind')
                            : t('calibrate.pairs.px', { value: r.toFixed(1) })}
                        </td>
                        <td className="r">
                          <button
                            type="button"
                            className="btn ghost sm"
                            aria-label={t('calibrate.pairs.remove', { n: i + 1 })}
                            onClick={() => {
                              setPairs((ps) => ps.filter((_, k) => k !== i));
                              setResult(null);
                            }}
                          >
                            <Icon name="x" size={12} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {(rms !== null || result) && (
              <div className="b-stats" data-testid="lens-stats">
                <div>
                  <span>{t('calibrate.stats.before')}</span>
                  <b data-testid="stat-before">
                    {result
                      ? t('calibrate.pairs.px', { value: result.before.rmsPx.toFixed(1) })
                      : '-'}
                  </b>
                </div>
                <div>
                  <span>{t('calibrate.stats.now')}</span>
                  <b data-testid="stat-now">
                    {rms === null ? '-' : t('calibrate.pairs.px', { value: rms.toFixed(1) })}
                  </b>
                </div>
                <div title={t('calibrate.stats.heldOutTip')}>
                  <span>{t('calibrate.stats.heldOut')}</span>
                  <b data-testid="stat-heldout">
                    {result?.heldOut
                      ? t('calibrate.pairs.px', { value: result.heldOut.rmsPx.toFixed(1) })
                      : '-'}
                  </b>
                </div>
              </div>
            )}
          </div>

          <div className="sec">
            {sameSize.length > 1 && (
              <label className="b-inline">
                <input
                  type="checkbox"
                  checked={allSame}
                  onChange={(e) => {
                    setAllSame(e.target.checked);
                  }}
                />
                <span>{t('calibrate.save.lensAll', { count: sameSize.length })}</span>
              </label>
            )}
            {sameFlight.length > 1 && (
              <label className="b-inline">
                <input
                  type="checkbox"
                  checked={allFlight}
                  onChange={(e) => {
                    setAllFlight(e.target.checked);
                  }}
                  data-testid="orient-all-flight"
                />
                <span>{t('calibrate.save.orientFlight', { count: sameFlight.length })}</span>
              </label>
            )}
            <div className="acts">
              <button
                type="button"
                className="btn primary"
                disabled={saving}
                onClick={() => void save()}
                data-testid="calibration-save"
              >
                <Icon name="check" size={14} />
                {t('calibrate.save.button')}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setHfov(clip.lens.hfovDeg);
                  setOffsetMs(clip.offsetMs);
                  setOrient(clip.orientation ?? NO_ORIENTATION);
                  setOffset(clip.positionOffsetM ?? [0, 0, 0]);
                }}
              >
                {t('calibrate.save.reset')}
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
