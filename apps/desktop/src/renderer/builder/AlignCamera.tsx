import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import { clipCamera, clipPoseAt, type CameraDirection } from '@aio/geo';
import { frameProjection, getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import type { DirectionFill } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { getPlayer, setFramePlane } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Vector3 } from 'three';
import { useMedia } from '../media';
import { alignCamera, useAlign } from './alignSession';
import { frameHit, groundHit } from './droneHits';
import { DirectionMapOverlay } from './directionMap';
import { clipTimeMs, formatClipMs, keyAt, previewKeys, segmentKey } from './directionModel';
import { useStagePick } from './pick';

type Axis = 'yaw' | 'pitch' | 'roll';

const AXES: {
  key: Axis;
  label: 'direction.heading' | 'direction.pitch' | 'direction.roll';
  min: number;
  max: number;
}[] = [
  { key: 'yaw', label: 'direction.heading', min: 0, max: 360 },
  { key: 'pitch', label: 'direction.pitch', min: -90, max: 30 },
  { key: 'roll', label: 'direction.roll', min: -45, max: 45 },
];

const FILLS: {
  value: DirectionFill;
  label: 'direction.fill.smooth' | 'direction.fill.track' | 'direction.fill.lookAt';
}[] = [
  { value: 'smooth', label: 'direction.fill.smooth' },
  { value: 'track', label: 'direction.fill.track' },
  { value: 'lookAt', label: 'direction.fill.lookAt' },
];

/** Degrees the camera turns per pixel of a drag in 3D. */
const DRAG_DEG_PX = 0.15;

function useScene(): SceneHandle | null {
  const [h, setH] = useState<SceneHandle | null>(() => getActiveScene());
  useEffect(() => onActiveScene(setH), []);
  return h;
}

function useMap(): MapController | null {
  const [m, setM] = useState<MapController | null>(() => getActiveMap());
  useEffect(() => onActiveMap(setM), []);
  return m;
}

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName);

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * "Align camera to map", in place: the clip's frame lies on the map where the camera sees it and
 * as an image plane at the end of the frustum in 3D. Drag the footprint on the map (or the frame
 * in 3D) to turn the camera; a small bar next to the drone sets keyframes. Esc cancels, Enter sets
 * a keyframe, Ctrl+Z undoes.
 */
export function AlignCamera() {
  const t = useT();
  const session = useAlign((s) => s.session);
  const active = session !== null;
  const opacity = useAlign((s) => s.opacity);
  const say = useAlign((s) => s.say);
  const project = useWorkspace((s) => s.project);
  const nowMs = useWorkspace((s) => s.nowMs);
  const { flights } = useMedia(project);
  const scene = useScene();
  const map = useMap();
  const clip = useMemo(() => {
    const l = project?.manifest.layers.find((x) => x.id === session?.layerId);
    return l?.kind === 'video' ? l : null;
  }, [project, session?.layerId]);
  const samples = clip ? (flights[clip.id] ?? null) : null;
  const keys = session?.keys ?? [];
  const preview = useMemo(
    () => (session ? previewKeys(session.keys, session.trial) : []),
    [session],
  );
  const clipMs = clip ? clipTimeMs(clip, nowMs) : 0;
  const pose = useMemo(() => {
    if (!clip || !samples?.length) return null;
    return clipPoseAt(
      samples,
      nowMs - clip.flight.startUtcMs,
      clipCamera(clip, undefined, preview.length ? preview : null),
    );
  }, [clip, samples, nowMs, preview]);
  // every render: the direction shown, from the store's own rule (a turn not set yet wins)
  const dir: CameraDirection | null = session && samples ? alignCamera.getState().current() : null;

  // the frame plane at the end of the frustum while aligning
  useEffect(() => {
    if (!scene) return;
    setFramePlane(scene, opacity);
  }, [scene, opacity]);
  useEffect(() => {
    if (!scene) return;
    return () => {
      setFramePlane(scene, null);
    };
  }, [scene]);

  // the map: frame drape, rotate and tilt handles, look-at picks
  const overlay = useRef<DirectionMapOverlay | null>(null);
  const [, setFrameTick] = useState(0);
  useEffect(() => {
    const m = map?.map;
    const manifest = workspace.getState().project?.manifest;
    const proj = manifest ? frameProjection(manifest.crs, manifest.origin) : null;
    if (!m || !proj) return;
    let o: DirectionMapOverlay | null = null;
    const make = () => {
      if (o || !m.isStyleLoaded()) return;
      o = new DirectionMapOverlay(m, proj, {
        turn: (p) => {
          alignCamera.getState().turn(p);
        },
        gesture: (a) => {
          alignCamera.getState().gesture(a);
        },
        pick: (p) => {
          alignCamera.getState().pick(p);
        },
      });
      overlay.current = o;
      setFrameTick((n) => n + 1);
    };
    make();
    m.on('idle', make);
    return () => {
      m.off('idle', make);
      o?.dispose();
      overlay.current = null;
    };
  }, [map]);
  // a new video frame (seek, load) redraws the drape; the player comes with the active clip
  const watched = useRef<{ v: HTMLVideoElement; off: () => void } | null>(null);
  useEffect(
    () => () => {
      watched.current?.off();
      watched.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!clip) return;
    const v = getPlayer(clip.id)?.video ?? null;
    if (v && watched.current?.v !== v) {
      watched.current?.off();
      const bump = () => {
        setFrameTick((n) => n + 1);
      };
      v.addEventListener('seeked', bump);
      v.addEventListener('loadeddata', bump);
      watched.current = {
        v,
        off: () => {
          v.removeEventListener('seeked', bump);
          v.removeEventListener('loadeddata', bump);
        },
      };
    }
    overlay.current?.update({
      pose: pose ? { pos: pose.pos, q: pose.q } : null,
      dir,
      lens: clip.lens,
      frame:
        v && v.readyState >= 2 && v.videoWidth
          ? { source: v, width: v.videoWidth, height: v.videoHeight }
          : null,
      opacity,
      target: keys[segmentKey(keys, clipMs)]?.target ?? null,
      picking: session?.picking ?? false,
    });
  });

  // 3D: drag the frame plane to turn (Shift: roll), wheel over it to tilt
  useEffect(() => {
    const pane = document.querySelector<HTMLElement>('.pane-3d');
    if (!scene || !pane || !active) return;
    let drag: { x: number; y: number; dir: CameraDirection; roll: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || alignCamera.getState().session?.picking) return;
      if (!frameHit(scene, pane, e.clientX, e.clientY)) return;
      const d = alignCamera.getState().current();
      if (!d) return;
      e.stopPropagation();
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, dir: d, roll: e.shiftKey };
      pane.setPointerCapture(e.pointerId);
      alignCamera.getState().gesture(true);
    };
    const move = (e: PointerEvent) => {
      if (!drag) {
        pane.style.cursor = frameHit(scene, pane, e.clientX, e.clientY) ? 'grab' : '';
        return;
      }
      e.stopPropagation();
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (drag.roll) alignCamera.getState().turn({ roll: drag.dir.roll + dx * DRAG_DEG_PX * 2 });
      else
        alignCamera.getState().turn({
          yaw: drag.dir.yaw + dx * DRAG_DEG_PX,
          pitch: Math.max(-90, Math.min(30, drag.dir.pitch - dy * DRAG_DEG_PX)),
        });
    };
    const up = (e: PointerEvent) => {
      if (!drag) return;
      e.stopPropagation();
      drag = null;
      pane.releasePointerCapture(e.pointerId);
      alignCamera.getState().gesture(false);
    };
    const wheel = (e: WheelEvent) => {
      if (!frameHit(scene, pane, e.clientX, e.clientY)) return;
      const d = alignCamera.getState().current();
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      alignCamera.getState().gesture(true);
      alignCamera
        .getState()
        .turn({ pitch: Math.max(-90, Math.min(30, d.pitch + (e.deltaY > 0 ? -1 : 1))) });
      alignCamera.getState().gesture(false);
    };
    pane.addEventListener('pointerdown', down, true);
    pane.addEventListener('pointermove', move, true);
    pane.addEventListener('pointerup', up, true);
    pane.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => {
      pane.removeEventListener('pointerdown', down, true);
      pane.removeEventListener('pointermove', move, true);
      pane.removeEventListener('pointerup', up, true);
      pane.removeEventListener('wheel', wheel, true);
      pane.style.cursor = '';
    };
  }, [scene, active]);

  // a look-at point picked in 3D
  useStagePick(session?.picking ?? false, (_hit, c) => {
    const pane = document.querySelector<HTMLElement>('.pane-3d');
    const p = scene && pane ? groundHit(scene, pane, c.x, c.y) : null;
    alignCamera.getState().pick(p);
  });

  // keys: Esc cancels (a pick first), Enter sets a keyframe, Ctrl+Z undoes
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      const a = alignCamera.getState();
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (a.session?.picking) a.pick(null);
        else a.cancel();
      } else if (e.key === 'Enter' && !editable(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        a.setKey();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !editable(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        a.undo();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
    };
  }, [active]);

  // the bar follows the drone on the map (or in 3D without a map)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!pose) return;
    const place = () => {
      const m = map?.map;
      const manifest = workspace.getState().project?.manifest;
      const proj = manifest ? frameProjection(manifest.crs, manifest.origin) : null;
      const mapPane = document.querySelector<HTMLElement>('.pane-map');
      if (m && proj && mapPane && mapPane.offsetWidth > 0) {
        const r = m.getContainer().getBoundingClientRect();
        const p = m.project(proj.toLonLat(pose.pos));
        setAt(clampBar(r, r.left + p.x, r.top + p.y));
        return;
      }
      const pane = document.querySelector<HTMLElement>('.pane-3d');
      if (scene && pane) {
        const r = pane.getBoundingClientRect();
        const v = new Vector3(...pose.pos).project(scene.camera);
        setAt(clampBar(r, r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height));
      }
    };
    place();
    const m = map?.map;
    m?.on('move', place);
    return () => {
      m?.off('move', place);
    };
  }, [pose, map, scene]);

  if (!session || !clip) return null;
  const onKey = keyAt(keys, clipMs);
  const seg = segmentKey(keys, clipMs);
  const segKey = keys[seg];
  const fillLabel =
    keys.length < 2
      ? t('direction.fillOnly')
      : clipMs < (keys[0]?.t ?? 0)
        ? t('direction.fillBefore')
        : t('direction.fillAfter', { n: seg + 1 });

  const bar = (
    <div
      className="align-bar"
      role="dialog"
      aria-label={t('direction.title')}
      data-testid="align-bar"
      style={at ? { left: at.x, top: at.y } : { right: 16, top: 120 }}
    >
      <header>
        <Icon name="droneeye" size={14} />
        <b>{t('direction.title')}</b>
        <span className="faint">{clip.name}</span>
      </header>
      <p className="say" data-testid="align-status">
        {keys.length
          ? onKey >= 0
            ? t('direction.onKey', { n: onKey + 1 })
            : t('direction.offKey')
          : t('direction.none')}{' '}
        <span className="faint mono">
          {formatClipMs(clipMs)} · {t('direction.count', { count: keys.length })}
        </span>
      </p>
      <div className="acts">
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            alignCamera.getState().setKey();
          }}
          title="Enter"
          data-testid="align-set-key"
        >
          <Icon name="point" size={12} />
          {t('direction.set')}
        </button>
        <button
          type="button"
          className="btn sm icon"
          aria-label={t('direction.prev')}
          title={t('direction.prev')}
          disabled={!keys.some((k) => k.t < clipMs - 20)}
          onClick={() => {
            alignCamera.getState().jump(-1);
          }}
          data-testid="align-prev"
        >
          <Icon name="back" size={12} />
        </button>
        <button
          type="button"
          className="btn sm icon"
          aria-label={t('direction.next')}
          title={t('direction.next')}
          disabled={!keys.some((k) => k.t > clipMs + 20)}
          onClick={() => {
            alignCamera.getState().jump(1);
          }}
          data-testid="align-next"
        >
          <Icon name="fwd" size={12} />
        </button>
        {onKey >= 0 && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              alignCamera.getState().deleteKey();
            }}
            data-testid="align-delete"
          >
            <Icon name="x" size={12} />
            {t('direction.delete')}
          </button>
        )}
        {keys.length === 0 && (
          <button
            type="button"
            className="btn sm"
            title={t('direction.firstLastTip')}
            onClick={() => {
              alignCamera.getState().firstLast();
            }}
            data-testid="align-first-last"
          >
            {t('direction.firstLast')}
          </button>
        )}
      </div>
      {segKey && (
        <label className="row">
          <span className="faint">{fillLabel}</span>
          <select
            className="input sm"
            value={session.picking ? 'lookAt' : segKey.fill}
            onChange={(e) => {
              alignCamera.getState().fill(e.target.value as DirectionFill);
            }}
            data-testid="align-fill"
          >
            {FILLS.map((f) => (
              <option key={f.value} value={f.value}>
                {t(f.label)}
              </option>
            ))}
          </select>
          {segKey.fill === 'lookAt' && !session.picking && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                alignCamera.getState().fill('lookAt');
              }}
            >
              {t('direction.pickTarget')}
            </button>
          )}
        </label>
      )}
      <label className="row">
        <span className="faint">{t('direction.frame')}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          aria-label={t('direction.frameOpacity')}
          onChange={(e) => {
            alignCamera.getState().setOpacity(Number(e.target.value));
          }}
          data-testid="align-opacity"
        />
      </label>
      <details
        open={session.exact}
        onToggle={(e) => {
          alignCamera.getState().setExact(e.currentTarget.open);
        }}
        data-testid="align-exact"
      >
        <summary>{t('direction.exact')}</summary>
        {AXES.map(({ key, label, min, max }) => {
          const v = dir ? dir[key] : 0;
          const shown = key === 'yaw' ? r1(v) % 360 : r1(v);
          return (
            <div className="row" key={key}>
              <span className="faint axis">{t(label)}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={0.1}
                value={Math.min(max, Math.max(min, shown))}
                aria-label={t('direction.slider', { axis: t(label) })}
                onPointerDown={() => {
                  alignCamera.getState().gesture(true);
                }}
                onPointerUp={() => {
                  alignCamera.getState().gesture(false);
                }}
                onChange={(e) => {
                  alignCamera.getState().turn({ [key]: Number(e.target.value) });
                }}
              />
              <input
                className="input mono sm"
                type="number"
                step={0.1}
                value={shown}
                aria-label={t('direction.input', { axis: t(label) })}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (e.target.value !== '' && Number.isFinite(n))
                    alignCamera.getState().turn({ [key]: n });
                }}
                data-testid={`align-input-${key}`}
              />
            </div>
          );
        })}
        <p className="faint">{t('direction.absolute')}</p>
      </details>
      {say && <p className={`say ${say.tone ?? ''}`}>{say.text}</p>}
      <p className="faint tip">{t('direction.handleTip')}</p>
      <div className="acts end">
        <button
          type="button"
          className="btn sm ghost"
          title={t('direction.undoTip')}
          onClick={() => {
            alignCamera.getState().undo();
          }}
          data-testid="align-undo"
        >
          <Icon name="undo" size={12} />
          {t('direction.undo')}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          title="Esc"
          onClick={() => {
            alignCamera.getState().cancel();
          }}
          data-testid="align-cancel"
        >
          {t('direction.cancel')}
        </button>
        <button
          type="button"
          className="btn sm primary"
          onClick={() => void alignCamera.getState().done()}
          data-testid="align-done"
        >
          <Icon name="check" size={12} />
          {t('direction.done')}
        </button>
      </div>
    </div>
  );
  return createPortal(bar, document.body);
}

/** Bar position next to a screen point, kept inside a pane. */
function clampBar(r: DOMRect, x: number, y: number): { x: number; y: number } {
  const W = 300;
  const H = 300;
  const left = x + 40 + W > r.right ? x - 40 - W : x + 40;
  return {
    x: Math.max(r.left + 8, Math.min(r.right - W - 8, left)),
    y: Math.max(r.top + 8, Math.min(r.bottom - H - 8, y - 40)),
  };
}
