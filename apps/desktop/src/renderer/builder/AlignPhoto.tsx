import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import type { CameraDirection } from '@aio/geo';
import { frameProjection, getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import type { LensModel, Quat, Vec3 } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { DEFAULT_PHOTO_LENS } from '@aio/video';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { photoAlign, usePhotoAlign } from './alignSession';
import { frameHit } from './droneHits';
import { DirectionMapOverlay } from './directionMap';

const PLANE = 'PhotoAlignFrame';
const DRAG_DEG_PX = 0.15;

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
/** Offset fields: east (+x), north (-z), up (+y). */
const OFFSET: {
  label: 'photoAlign.east' | 'photoAlign.north' | 'photoAlign.up';
  index: 0 | 1 | 2;
  sign: 1 | -1;
}[] = [
  { label: 'photoAlign.east', index: 0, sign: 1 },
  { label: 'photoAlign.north', index: 2, sign: -1 },
  { label: 'photoAlign.up', index: 1, sign: 1 },
];

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
 * The photo being aligned in 3D: its frustum and the photo as an image plane at its end, pulled in
 * above the ground plane like the drone's frame.
 */
class PhotoFrame3D {
  readonly group = new Group();
  private readonly plane: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly lines: LineSegments;
  private texture: Texture | null = null;

  constructor(private readonly h: SceneHandle) {
    this.group.name = 'PhotoAlign';
    this.plane = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        transparent: true,
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.plane.name = PLANE;
    this.plane.renderOrder = 19;
    this.plane.frustumCulled = false;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(16 * 3), 3));
    this.lines = new LineSegments(
      g,
      new LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }),
    );
    this.lines.renderOrder = 20;
    this.lines.frustumCulled = false;
    this.group.add(this.plane, this.lines);
    h.scene.add(this.group);
  }

  setImage(img: HTMLImageElement | null) {
    this.texture?.dispose();
    this.texture = null;
    if (img) {
      const tex = new Texture(img);
      tex.colorSpace = SRGBColorSpace;
      tex.needsUpdate = true;
      this.texture = tex;
    }
    this.plane.material.map = this.texture;
    this.plane.material.needsUpdate = true;
    this.h.requestRender();
  }

  update(pose: { pos: Vec3; q: Quat }, lens: LensModel, opacity: number, show: boolean) {
    this.group.visible = show;
    if (!show) {
      this.h.requestRender();
      return;
    }
    const o = new Vector3(...pose.pos);
    const q = new Quaternion(...pose.q);
    const tx = Math.tan((Math.min(150, lens.hfovDeg) * Math.PI) / 360);
    const ty = tx / lens.aspect;
    const dist = this.h.camera.position.distanceTo(o);
    let L = Math.min(200, Math.max(1, dist * 0.15));
    const corners = [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
    ].map(([sx, sy]) => new Vector3((sx ?? 0) * tx, (sy ?? 0) * ty, -1).applyQuaternion(q));
    for (const d of corners) if (d.y < -1e-6) L = Math.min(L, (0.98 * o.y) / -d.y);
    L = Math.max(0.3, L);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
    this.plane.position.copy(o).addScaledVector(fwd, L);
    this.plane.quaternion.copy(q);
    this.plane.scale.set(2 * L * tx, 2 * L * ty, 1);
    this.plane.material.opacity = opacity;
    const pts = corners.map((d) => o.clone().addScaledVector(d, L));
    const arr = (this.lines.geometry.getAttribute('position') as BufferAttribute)
      .array as Float32Array;
    let k = 0;
    const put = (v: Vector3) => {
      arr[k++] = v.x;
      arr[k++] = v.y;
      arr[k++] = v.z;
    };
    for (let i = 0; i < 4; i++) {
      put(o);
      put(pts[i] ?? o);
      put(pts[i] ?? o);
      put(pts[(i + 1) % 4] ?? o);
    }
    this.lines.geometry.getAttribute('position').needsUpdate = true;
    this.h.requestRender();
  }

  dispose() {
    this.h.scene.remove(this.group);
    this.texture?.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.lines.geometry.dispose();
    this.h.requestRender();
  }
}

/**
 * "Align photo to map", in place: the photo lies on the map where its camera sees it and as an
 * image plane at the end of its frustum in 3D. Drag it to turn, the far edge or the wheel to tilt,
 * Shift-drag to roll; exact angles and a position nudge in the bar. Esc cancels, Enter is Done,
 * Ctrl+Z undoes.
 */
export function AlignPhoto() {
  const t = useT();
  const session = usePhotoAlign((s) => s.session);
  const opacity = usePhotoAlign((s) => s.opacity);
  const say = usePhotoAlign((s) => s.say);
  const project = useWorkspace((s) => s.project);
  const scene = useScene();
  const map = useMap();
  const active = session !== null;
  const photo = useMemo(() => {
    const l = project?.manifest.layers.find((x) => x.id === session?.layerId);
    return l?.kind === 'photos' ? (l.items.find((p) => p.id === session?.photoId) ?? null) : null;
  }, [project, session?.layerId, session?.photoId]);
  const lens = photo?.lens ?? DEFAULT_PHOTO_LENS;
  // the session changes with every turn: pose and direction follow it
  const pose = session ? photoAlign.getState().pose() : null;
  const dir: CameraDirection | null = session ? photoAlign.getState().current() : null;

  // the photo itself, for the map drape and the 3D plane
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!project || !photo) return;
    let live = true;
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => {
      if (live) setImg(el);
    };
    el.src = assetUrl(project.id, photo.src);
    return () => {
      live = false;
      setImg(null);
    };
  }, [project, photo]);

  // 3D: the frustum and the photo plane
  const frame3d = useRef<PhotoFrame3D | null>(null);
  useEffect(() => {
    if (!scene || !active) return;
    const f = new PhotoFrame3D(scene);
    frame3d.current = f;
    return () => {
      f.dispose();
      frame3d.current = null;
    };
  }, [scene, active]);
  useEffect(() => {
    frame3d.current?.setImage(img);
  }, [img, scene, active]);
  useEffect(() => {
    if (pose) frame3d.current?.update(pose, lens, opacity, true);
  });

  // the map: drape and handles
  const overlay = useRef<DirectionMapOverlay | null>(null);
  const [, setReady] = useState(0);
  useEffect(() => {
    const m = map?.map;
    const manifest = workspace.getState().project?.manifest;
    const proj = manifest ? frameProjection(manifest.crs, manifest.origin) : null;
    if (!m || !proj || !active) return;
    let o: DirectionMapOverlay | null = null;
    const make = () => {
      if (o || !m.isStyleLoaded()) return;
      o = new DirectionMapOverlay(m, proj, {
        turn: (p) => {
          photoAlign.getState().turn(p);
        },
        gesture: (a) => {
          photoAlign.getState().gesture(a);
        },
        pick: () => undefined,
      });
      overlay.current = o;
      setReady((n) => n + 1);
    };
    make();
    m.on('idle', make);
    return () => {
      m.off('idle', make);
      o?.dispose();
      overlay.current = null;
    };
  }, [map, active]);
  useEffect(() => {
    overlay.current?.update({
      pose,
      dir,
      lens,
      frame: img ? { source: img, width: img.naturalWidth, height: img.naturalHeight } : null,
      opacity,
      target: null,
      picking: false,
    });
  });

  // 3D: drag the photo plane to turn (Shift: roll), wheel over it to tilt
  useEffect(() => {
    const pane = document.querySelector<HTMLElement>('.pane-3d');
    if (!scene || !pane || !active) return;
    let drag: { x: number; y: number; dir: CameraDirection; roll: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !frameHit(scene, pane, e.clientX, e.clientY, PLANE)) return;
      const d = photoAlign.getState().current();
      if (!d) return;
      e.stopPropagation();
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, dir: d, roll: e.shiftKey };
      pane.setPointerCapture(e.pointerId);
      photoAlign.getState().gesture(true);
    };
    const move = (e: PointerEvent) => {
      if (!drag) {
        pane.style.cursor = frameHit(scene, pane, e.clientX, e.clientY, PLANE) ? 'grab' : '';
        return;
      }
      e.stopPropagation();
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (drag.roll) photoAlign.getState().turn({ roll: drag.dir.roll + dx * DRAG_DEG_PX * 2 });
      else
        photoAlign.getState().turn({
          yaw: drag.dir.yaw + dx * DRAG_DEG_PX,
          pitch: Math.max(-90, Math.min(30, drag.dir.pitch - dy * DRAG_DEG_PX)),
        });
    };
    const up = (e: PointerEvent) => {
      if (!drag) return;
      e.stopPropagation();
      drag = null;
      pane.releasePointerCapture(e.pointerId);
      photoAlign.getState().gesture(false);
    };
    const wheel = (e: WheelEvent) => {
      if (!frameHit(scene, pane, e.clientX, e.clientY, PLANE)) return;
      const d = photoAlign.getState().current();
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      photoAlign.getState().gesture(true);
      photoAlign
        .getState()
        .turn({ pitch: Math.max(-90, Math.min(30, d.pitch + (e.deltaY > 0 ? -1 : 1))) });
      photoAlign.getState().gesture(false);
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

  // keys: Esc cancels, Enter is Done, Ctrl+Z undoes
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      const a = photoAlign.getState();
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        a.cancel();
      } else if (e.key === 'Enter' && !editable(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        void a.done();
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

  // the bar sits next to the photo on the map (or in 3D)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const px = pose?.pos[0];
  const pz = pose?.pos[2];
  const py = pose?.pos[1];
  useEffect(() => {
    if (px === undefined || py === undefined || pz === undefined) return;
    const place = () => {
      const m = map?.map;
      const manifest = workspace.getState().project?.manifest;
      const proj = manifest ? frameProjection(manifest.crs, manifest.origin) : null;
      const mapPane = document.querySelector<HTMLElement>('.pane-map');
      if (m && proj && mapPane && mapPane.offsetWidth > 0) {
        const r = m.getContainer().getBoundingClientRect();
        const p = m.project(proj.toLonLat([px, py, pz]));
        setAt(clampBar(r, r.left + p.x, r.top + p.y));
        return;
      }
      const pane = document.querySelector<HTMLElement>('.pane-3d');
      if (scene && pane) {
        const r = pane.getBoundingClientRect();
        const v = new Vector3(px, py, pz).project(scene.camera);
        setAt(clampBar(r, r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height));
      }
    };
    place();
    const m = map?.map;
    m?.on('move', place);
    return () => {
      m?.off('move', place);
    };
  }, [px, py, pz, map, scene]);

  if (!session || !photo) return null;
  const offset = session.corr.offsetM ?? [0, 0, 0];
  const bar = (
    <div
      className="align-bar"
      role="dialog"
      aria-label={t('photoAlign.title')}
      data-testid="photo-align-bar"
      style={at ? { left: at.x, top: at.y } : { right: 16, top: 120 }}
    >
      <header>
        <Icon name="photo" size={14} />
        <b>{t('photoAlign.title')}</b>
        <span className="faint">{photo.id}</span>
      </header>
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
            photoAlign.getState().setOpacity(Number(e.target.value));
          }}
        />
      </label>
      <details
        open={session.exact}
        onToggle={(e) => {
          photoAlign.getState().setExact(e.currentTarget.open);
        }}
        data-testid="photo-align-exact"
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
                  photoAlign.getState().gesture(true);
                }}
                onPointerUp={() => {
                  photoAlign.getState().gesture(false);
                }}
                onChange={(e) => {
                  photoAlign.getState().turn({ [key]: Number(e.target.value) });
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
                    photoAlign.getState().turn({ [key]: n });
                }}
                data-testid={`photo-align-input-${key}`}
              />
            </div>
          );
        })}
        <span className="faint">{t('photoAlign.offset')}</span>
        <div className="row">
          {OFFSET.map(({ label, index, sign }) => (
            <label key={label} className="row">
              <span className="faint">{t(label)}</span>
              <input
                className="input mono sm"
                type="number"
                step={0.1}
                value={Math.round(sign * offset[index] * 100) / 100}
                aria-label={t('direction.input', { axis: t(label) })}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (e.target.value === '' || !Number.isFinite(n) || Math.abs(n) > 500) return;
                  const o: Vec3 = [offset[0], offset[1], offset[2]];
                  o[index] = sign * n;
                  photoAlign.getState().setOffset(o);
                }}
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            photoAlign.getState().reset();
          }}
        >
          {t('photoAlign.reset')}
        </button>
      </details>
      {say && <p className={`say ${say.tone ?? ''}`}>{say.text}</p>}
      <div className="acts end">
        <button
          type="button"
          className="btn sm ghost"
          title={t('direction.undoTip')}
          onClick={() => {
            photoAlign.getState().undo();
          }}
        >
          <Icon name="undo" size={12} />
          {t('direction.undo')}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          title="Esc"
          onClick={() => {
            photoAlign.getState().cancel();
          }}
          data-testid="photo-align-cancel"
        >
          {t('direction.cancel')}
        </button>
        <button
          type="button"
          className="btn sm primary"
          title="Enter"
          onClick={() => void photoAlign.getState().done()}
          data-testid="photo-align-done"
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
  const H = 260;
  const left = x + 40 + W > r.right ? x - 40 - W : x + 40;
  return {
    x: Math.max(r.left + 8, Math.min(r.right - W - 8, left)),
    y: Math.max(r.top + 8, Math.min(r.bottom - H - 8, y - 40)),
  };
}
