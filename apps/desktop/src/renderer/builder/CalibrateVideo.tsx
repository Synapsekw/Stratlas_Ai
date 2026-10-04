import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import type { Layer, LensModel, Vec3 } from '@aio/schema';
import { Icon } from '@aio/ui';
import {
  fitLens,
  projectPair,
  setCalibrationLens,
  setCameraMode,
  setProjection,
  videoRig,
  type LensFit,
  type LensPair,
} from '@aio/video';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { clipVideoTime, parseCoordinate } from './model';
import { useStagePick } from './pick';
import { builder } from './state';

type VideoLayer = Extract<Layer, { kind: 'video' }>;
type Step = 'image' | 'model' | null;

const FRAME_MS = 1000 / 30;

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

/**
 * Video calibration against the 3D model in drone-eye view: the clip's frame is laid over the
 * rendered model. Time offset: scrub to a visible event and nudge until frame and model agree.
 * Field of view: drag across the frame, or click point pairs (frame, then model or a typed
 * coordinate) and fit. Saves `offsetMs` and `lens` to the clip (and the lens to clips of the
 * same frame size).
 */
export function CalibrateVideo({ layerId }: { layerId: string }) {
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
  const [opacity, setOpacity] = useState(0.5);
  const [pairs, setPairs] = useState<LensPair[]>([]);
  const [pendingImage, setPendingImage] = useState<[number, number] | null>(null);
  const [step, setStep] = useState<Step>(null);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<LensFit | null>(null);
  const [allSame, setAllSame] = useState(true);
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

  // the overlay shows the frame at the trial offset
  useEffect(() => {
    const v = video.current;
    if (!v || !clip) return;
    const t = clipVideoTime(clip, nowMs, offsetMs);
    if (Math.abs(v.currentTime - t) > 0.004) v.currentTime = t;
  }, [nowMs, offsetMs, clip]);

  const addPair = (world: Vec3) => {
    const pose = scene ? videoRig(scene).currentPose() : null;
    if (!pendingImage || !pose) return;
    setPairs((p) => [
      ...p,
      {
        image: pendingImage,
        world,
        pos: [pose.pos.x, pose.pos.y, pose.pos.z],
        q: [pose.q.x, pose.q.y, pose.q.z, pose.q.w],
      },
    ]);
    setPendingImage(null);
    setStep(null);
    setSay({ text: 'Pair added. Add more across the frame, then fit.' });
  };

  useStagePick(step === 'model', (hit) => {
    if (!hit) {
      setSay({ text: 'Nothing under the cursor. Click the model.', tone: 'bad' });
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
      setSay({
        text: 'Now click the same feature on the model, or type its coordinate.',
        tone: 'armed',
      });
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

  const runFit = () => {
    if (!clip || !lens) return;
    try {
      const r = fitLens(pairs, { ...clip.lens }, { widthPx: videoWidth });
      setResult(r);
      setHfov(Math.round(r.lens.hfovDeg * 100) / 100);
      setSay({ text: `Fitted from ${String(pairs.length)} pairs.` });
    } catch (e) {
      setSay({ text: e instanceof Error ? e.message : String(e), tone: 'bad' });
    }
  };

  const sameSize = clip
    ? clips.filter((c) => Math.abs(c.lens.aspect - clip.lens.aspect) < 1e-3)
    : [];
  const save = async () => {
    if (!clip || !lens) return;
    setSaving(true);
    const others = allSame ? sameSize.filter((c) => c.id !== clip.id).map((c) => c.id) : [];
    let err = await builder.getState().saveLayers([clip.id], { offsetMs, lens });
    if (!err && others.length) err = await builder.getState().saveLayers(others, { lens });
    setSaving(false);
    setSay(
      err
        ? { text: err, tone: 'bad' }
        : {
            text: `Saved: offset ${String(Math.round(offsetMs))} ms, field of view ${hfov.toFixed(2)}° on ${String(1 + others.length)} clip${others.length ? 's' : ''}.`,
          },
    );
  };

  if (!project || !clip || !lens)
    return (
      <section className="b-align" aria-label="Calibrate video">
        <header>
          <Icon name="video" size={14} />
          <b>Calibrate video</b>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              builder.getState().stopAlign();
            }}
          >
            Close
          </button>
        </header>
        <div className="sec say">This project has no video clip with a flight.</div>
      </section>
    );

  const widthPx = videoWidth;
  const residual = (p: LensPair) => {
    const im = projectPair(p, lens);
    return im
      ? Math.hypot((im[0] - p.image[0]) * widthPx, ((im[1] - p.image[1]) * widthPx) / lens.aspect)
      : null;
  };
  const rms = pairs.length
    ? Math.sqrt(pairs.reduce((m, p) => m + (residual(p) ?? widthPx) ** 2, 0) / pairs.length)
    : null;
  const origin = project.manifest.origin;
  const epsg = 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : 0;

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
                const im = projectPair(p, lens);
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
              {clip.name} · FOV {hfov.toFixed(2)}° · offset {Math.round(offsetMs)} ms
            </span>
          </div>
        </div>,
        pane,
      )
    : null;

  return (
    <>
      {overlay}
      <section className="b-align" aria-label="Calibrate video" data-testid="calibrate-video">
        <header>
          <Icon name="video" size={14} />
          <b>Calibrate video</b>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              builder.getState().stopAlign();
            }}
          >
            Close
          </button>
        </header>
        <div className="scroll">
          <div className="sec">
            <select
              className="input"
              value={clip.id}
              aria-label="Clip"
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
              <span className="faint">Frame</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                aria-label="Frame opacity"
                onChange={(e) => {
                  setOpacity(Number(e.target.value));
                }}
                style={{ flex: 1 }}
              />
            </label>
          </div>

          <div className="sec">
            <b>Time offset</b>
            <p className="say">
              Scrub the timeline to a visible event (a turn, a vehicle, the take-off) and nudge
              until the frame and the model move together.
            </p>
            <div className="b-inline">
              <input
                className="input mono"
                type="number"
                step={1}
                value={Math.round(offsetMs)}
                aria-label="Time offset in milliseconds"
                onChange={(e) => {
                  setOffsetMs(Number(e.target.value));
                }}
              />
              <span className="faint">ms</span>
            </div>
            <div className="acts">
              {(
                [
                  ['-1 s', -1000],
                  ['-1 frame', -FRAME_MS],
                  ['+1 frame', FRAME_MS],
                  ['+1 s', 1000],
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
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="sec">
            <b>Field of view</b>
            <p className="say">
              Drag across the frame to widen or narrow the model view until edges line up, or fit it
              from point pairs.
            </p>
            <div className="b-inline">
              <input
                type="range"
                min={20}
                max={130}
                step={0.05}
                value={hfov}
                aria-label="Horizontal field of view"
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
                aria-label="Horizontal field of view in degrees"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v > 1 && v < 179) setHfov(v);
                }}
              />
              <span className="faint">°</span>
            </div>
            <div className="acts">
              <button
                type="button"
                className={`btn${step === 'image' ? ' primary' : ''}`}
                onClick={() => {
                  setStep('image');
                  setPendingImage(null);
                  setSay({ text: 'Click a sharp feature in the video frame.', tone: 'armed' });
                }}
                data-testid="add-pair"
              >
                <Icon name="point" size={14} />
                Add pair
              </button>
              <button
                type="button"
                className="btn"
                disabled={pairs.length < 2}
                onClick={runFit}
                data-testid="fit-lens"
              >
                <Icon name="target" size={14} />
                Fit
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
                  Clear
                </button>
              )}
            </div>
            {step === 'model' && (
              <form
                className="b-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  const p = parseCoordinate(typed, epsg);
                  if (!p) {
                    setSay({ text: 'Type E N H in the project CRS, or lat, lon, h.', tone: 'bad' });
                    return;
                  }
                  addPair([p[0] - origin[0], p[2] - origin[2], 0 - (p[1] - origin[1])]);
                  setTyped('');
                }}
              >
                <input
                  className="input mono"
                  value={typed}
                  placeholder="or type E N H of the feature"
                  aria-label="Feature coordinate"
                  onChange={(e) => {
                    setTyped(e.target.value);
                  }}
                />
                <button type="submit" className="btn">
                  Add
                </button>
              </form>
            )}
            {say && <p className={`say ${say.tone ?? ''}`}>{say.text}</p>}
            {pairs.length > 0 && (
              <table className="b-pairs" aria-label="Lens pairs">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Frame x y</th>
                    <th className="r">Error now</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((p, i) => {
                    const r = residual(p);
                    return (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>
                          {(p.image[0] * widthPx).toFixed(0)}{' '}
                          {((p.image[1] * widthPx) / lens.aspect).toFixed(0)}
                        </td>
                        <td className="r">{r === null ? 'behind' : `${r.toFixed(1)} px`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {(rms !== null || result) && (
              <div className="b-stats" data-testid="lens-stats">
                <div>
                  <span>Saved lens</span>
                  <b>{clip.lens.hfovDeg.toFixed(2)}°</b>
                </div>
                <div>
                  <span>Error saved</span>
                  <b>{result ? `${result.before.rmsPx.toFixed(1)} px` : '-'}</b>
                </div>
                <div>
                  <span>Error now</span>
                  <b>{rms === null ? '-' : `${rms.toFixed(1)} px`}</b>
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
                <span>Use this lens for all {sameSize.length} clips with this frame size</span>
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
                Save calibration
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setHfov(clip.lens.hfovDeg);
                  setOffsetMs(clip.offsetMs);
                }}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
