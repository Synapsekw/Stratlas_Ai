import type { EngineStage } from '@aio/engine';
import { Icon, isShortcut, shortcutHint, t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Raycaster, Vector2, Vector3, type Object3D } from 'three';
import type { EN } from '../model/edit';
import { CHANGE_RAMP, RAMP_IDS, rampCss } from '../model/dsm';
import { VolumetricScene } from '../scene/controller';
import { useVolumetric, volumetric } from '../store';
import { f0, sgn } from './format';
import { CUT_CSS, FILL_CSS, ProfileChart } from './ProfileChart';

const short = (label: string) => label.replace(/ 20\d\d$/, '');

function ndcOf(stage: EngineStage, clientX: number, clientY: number): [number, number] {
  const r = stage.renderer.domElement.getBoundingClientRect();
  return [((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1];
}

/** Ground point (E, N, H) under the pointer, from the stage's own picking. */
function pickGround(
  stage: EngineStage,
  clientX: number,
  clientY: number,
): [number, number, number] | null {
  const hit = stage.raycast(...ndcOf(stage, clientX, clientY));
  if (!hit) return null;
  const o = volumetric.getState().origin;
  return [hit.point.x + o[0], o[1] - hit.point.z, hit.point.y + o[2]];
}

/** Orbit controls off while a handle is dragged. */
function setOrbit(stage: EngineStage, on: boolean) {
  stage.controls.enabled = on;
}

function setCursor(stage: EngineStage, cursor: string) {
  stage.renderer.domElement.style.cursor = cursor;
}

function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement && (/INPUT|SELECT|TEXTAREA/.test(t.tagName) || t.isContentEditable)
  );
}

/* ------------------------------------------------------------------ boundary handles */

interface Drag {
  index: number;
  insert: boolean;
  ring: EN[];
  z: number[];
  moved: boolean;
}

function Handles({ scene, stage }: { scene: VolumetricScene; stage: EngineStage }) {
  const edit = useVolumetric((s) => s.edit);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const ring = edit?.ring ?? [];
  const verts = edit?.live?.vertices;

  // vertex heights: the worker's surface under each point, the last known while it computes
  const vertZ = verts?.length === ring.length && !edit?.busy ? verts.map((v) => v[2]) : null;
  const lastZ = useRef<number[]>([]);

  useLayoutEffect(() => {
    if (vertZ) lastZ.current = vertZ;
    const el = host.current;
    if (!el) return;
    const place = () => {
      const r = stage.renderer.domElement.getBoundingClientRect();
      const own = el.getBoundingClientRect();
      const d = drag.current;
      const pts = d ? d.ring : ring;
      const z = d ? d.z : (vertZ ?? lastZ.current);
      const v = new Vector3();
      const at = (E: number, N: number, H: number, node: HTMLElement) => {
        v.copy(scene.world(E, N, H + 0.4)).project(stage.camera);
        const vis = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        node.style.display = vis ? '' : 'none';
        if (vis)
          node.style.transform = `translate(${(((v.x + 1) / 2) * r.width + r.left - own.left).toFixed(1)}px, ${(((1 - v.y) / 2) * r.height + r.top - own.top).toFixed(1)}px) translate(-50%, -50%)`;
      };
      const n = pts.length;
      el.querySelectorAll<HTMLElement>('[data-v]').forEach((node) => {
        const k = Number(node.dataset.v);
        const p = pts[k];
        if (p) at(p[0], p[1], z[k] ?? 0, node);
      });
      el.querySelectorAll<HTMLElement>('[data-m]').forEach((node) => {
        const k = Number(node.dataset.m);
        const a = pts[k];
        const b = pts[(k + 1) % n];
        if (a && b && !d)
          at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ((z[k] ?? 0) + (z[(k + 1) % n] ?? 0)) / 2, node);
        else if (d) node.style.display = 'none';
      });
    };
    place();
    const off = scene.onFrame(place);
    stage.requestRender();
    return off;
  });

  // Delete removes the selected point, Ctrl+Z undoes
  useEffect(() => {
    if (!edit) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const s = volumetric.getState();
      const ed = s.edit;
      if (!ed) return;
      if (isShortcut('volumes.deletePoint', e) && ed.sel >= 0) {
        e.preventDefault();
        void s.deleteVertex(ed.sel);
      } else if (isShortcut('volumes.undo', e)) {
        e.preventDefault();
        void s.undo();
      }
    };
    // capture: the outline's undo runs before the issue register's (it skips handled keys)
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [edit]);

  if (!edit) return null;

  const begin = (e: ReactPointerEvent<HTMLButtonElement>, index: number, insert: boolean) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = ring.map((q): EN => [q[0], q[1]]);
    const z = [...(vertZ ?? lastZ.current)];
    let k = index;
    if (insert) {
      const a = r[index];
      const b = r[(index + 1) % r.length];
      if (!a || !b) return;
      r.splice(index + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      z.splice(index + 1, 0, ((z[index] ?? 0) + (z[(index + 1) % z.length] ?? 0)) / 2);
      k = index + 1;
    } else volumetric.getState().selectVertex(index);
    drag.current = { index: k, insert, ring: r, z, moved: false };
    setOrbit(stage, false);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = pickGround(stage, e.clientX, e.clientY);
    if (!p) return;
    d.ring[d.index] = [p[0], p[1]];
    d.z[d.index] = p[2];
    d.moved = true;
    scene.setDragRing({ ring: d.ring, z: d.z });
    stage.requestRender();
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    setOrbit(stage, true);
    scene.setDragRing(null);
    if (!d) return;
    const p = d.ring[d.index];
    if (!p) return;
    lastZ.current = d.z;
    const s = volumetric.getState();
    if (d.insert) void s.insertVertex(d.index - 1, p);
    else if (d.moved) void s.moveVertex(d.index, p);
  };

  return (
    <div className="vol-handles" ref={host}>
      {ring.map((_, k) => (
        <button
          key={`m${String(k)}`}
          type="button"
          className="vol-mh"
          data-m={k}
          title="Drag to add a point here"
          aria-label={`Add a point between points ${String(k + 1)} and ${String(((k + 1) % ring.length) + 1)}`}
          onPointerDown={(e) => {
            begin(e, k, true);
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
      {ring.map((_, k) => (
        <button
          key={`v${String(k)}`}
          type="button"
          className={`vol-vh${edit.sel === k ? ' sel' : ''}`}
          data-v={k}
          title="Drag to move. Select and press Delete to remove."
          aria-label={`Boundary point ${String(k + 1)}`}
          onPointerDown={(e) => {
            begin(e, k, false);
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onContextMenu={(e) => {
            e.preventDefault();
            void volumetric.getState().deleteVertex(k);
          }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ bars and panels */

function EditBar() {
  const edit = useVolumetric((s) => s.edit);
  const base = useVolumetric((s) => s.base);
  const piles = useVolumetric((s) => s.piles);
  const saving = useVolumetric((s) => s.saving);
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  if (!edit) return null;
  const auto = piles.find((p) => p.id === edit.pile)?.auto[edit.epoch]?.volumes[base].net;
  const v = edit.live?.result.volumes[base].net;
  const label = captures.find((c) => c.epoch === edit.epoch)?.label ?? edit.epoch;
  let note: string;
  if (!edit.dirty && !edit.resetToAuto)
    note = auto === undefined ? 'No changes yet' : `No changes yet. Automatic ${f0(auto)} m³`;
  else if (auto !== undefined && v !== undefined)
    note = `automatic ${f0(auto)} m³ · ${sgn(v - auto)} m³`;
  else note = 'not detected on this date';
  return (
    <div
      className="vol-editbar overlay-box"
      role="toolbar"
      aria-label="Boundary editor"
      data-testid="vol-editbar"
    >
      <div className="vol-eb-t">
        <span>
          Editing {edit.pile} · {short(label)}
        </span>
        <b data-testid="vol-edit-net">{edit.busy && !edit.live ? '·' : `${f0(v)} m³`}</b>
        <small>{note}</small>
        <small className="vol-eb-hint">
          {t('vol.edit.hint', { undo: shortcutHint('volumes.undo') })}
        </small>
      </div>
      <div className="vol-eb-a">
        <button
          type="button"
          className="btn sm"
          disabled={!edit.hist.length}
          onClick={() => {
            void volumetric.getState().undo();
          }}
        >
          <Icon name="undo" size={14} />
          Undo
        </button>
        <button
          type="button"
          className="btn sm"
          title="Back to the automatic toe line"
          onClick={() => {
            void volumetric.getState().resetEdit();
          }}
        >
          Automatic
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            volumetric.getState().cancelEdit();
            volumetric.getState().setMessage('Edit discarded');
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={(!edit.dirty && !edit.resetToAuto) || saving || edit.busy}
          onClick={() => {
            void volumetric.getState().saveEdit();
          }}
        >
          <Icon name="check" size={14} />
          Save
        </button>
      </div>
    </div>
  );
}

function SectionPanel() {
  const section = useVolumetric((s) => s.section);
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  const deadband = useVolumetric((s) => s.file?.deadbandM ?? 0.1);
  if (section.mode === 'idle') return null;
  const first = captures[0];
  const last = captures.at(-1);
  const p = section.profile;
  return (
    <div
      className="vol-secpanel overlay-box"
      role="region"
      aria-label="Section"
      data-testid="vol-section"
    >
      <div className="vol-row">
        <b>{p ? `Section · ${f0(p.lengthM)} m` : 'Section'}</b>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            volumetric.getState().clearSection();
          }}
        >
          {section.mode === 'picking' ? 'Cancel' : 'Clear'}
        </button>
      </div>
      {section.mode === 'picking' ? (
        <p className="vol-note">
          Click two points on the ground: {section.points.length === 0 ? 'start' : 'end'} of the
          line.
        </p>
      ) : p ? (
        <>
          <ProfileChart
            s={p.s}
            series={[
              { z: p.z1, label: short(first?.label ?? ''), color: 'var(--fg-3)' },
              { z: p.z2, label: short(last?.label ?? ''), color: 'var(--acc)' },
            ]}
            deadband={deadband}
            height={170}
            label="Elevation profile along the drawn line for both survey dates"
          />
          <p className="vol-note">
            Area between the two surfaces along the line:{' '}
            <span className="vol-cut" data-testid="vol-sec-cut">
              {f0(p.cutM2)} m² cut
            </span>{' '}
            ·{' '}
            <span className="vol-fill" data-testid="vol-sec-fill">
              {f0(p.fillM2)} m² fill
            </span>
          </p>
        </>
      ) : (
        <p className="vol-note">Profiling…</p>
      )}
    </div>
  );
}

function SwipeDivider() {
  const swipe = useVolumetric((s) => s.swipe);
  const x = useVolumetric((s) => s.swipeX);
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  const ref = useRef<HTMLDivElement>(null);
  if (!swipe) return null;
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!(e.buttons & 1)) return;
    const host = ref.current?.parentElement?.getBoundingClientRect();
    if (host) volumetric.getState().setSwipeX((e.clientX - host.left) / host.width);
  };
  return (
    <>
      <div className="vol-swipe-lbl vol-l">{captures[0]?.label}</div>
      <div className="vol-swipe-lbl vol-r">{captures.at(-1)?.label}</div>
      <div
        ref={ref}
        className="vol-swipe"
        style={{ left: `${(x * 100).toFixed(2)}%` }}
        role="slider"
        aria-label="Swipe between surveys"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(x * 100)}
        tabIndex={0}
        data-testid="vol-swipe"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={onMove}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') volumetric.getState().setSwipeX(x - 0.02);
          else if (e.key === 'ArrowRight') volumetric.getState().setSwipeX(x + 0.02);
        }}
      >
        <span className="knob" aria-hidden>
          <Icon name="split" size={14} />
        </span>
      </div>
    </>
  );
}

const m1 = (v: number) => t('vol.elev.metres', { value: v.toFixed(1) });

/** Ramp, range (metres) and hillshade of the Elevation surface, with its legend. */
function ElevationControls() {
  const elevation = useVolumetric((s) => s.elevation);
  const relief = useVolumetric((s) => s.relief);
  const v = volumetric.getState();
  const range = elevation.range ?? relief?.auto;
  const style = range ? { ramp: elevation.ramp, lo: range[0], hi: range[1] } : null;
  if (!relief || !style)
    return (
      <>
        <b>{t('vol.elev.title')}</b>
        <span className="vol-elev-note">{t('vol.elev.reading')}</span>
      </>
    );
  const [min, max] = relief.extent;
  const step = Math.max(0.1, Math.round(((max - min) / 200) * 10) / 10);
  const setRange = (lo: number, hi: number) => {
    if (hi - lo < step) return;
    v.setElevation({ range: [lo, hi] });
  };
  return (
    <div className="vol-elev" data-testid="vol-elev">
      <div className="vol-row">
        <b>{t('vol.elev.title')}</b>
        <label className="vol-hs" title={t('vol.elev.hillshadeTip')}>
          <input
            type="checkbox"
            checked={elevation.hillshade}
            onChange={(e) => {
              v.setElevation({ hillshade: e.target.checked });
            }}
          />
          {t('vol.elev.hillshade')}
        </label>
      </div>
      <div className="vol-ramps" role="radiogroup" aria-label={t('vol.elev.ramp')}>
        {RAMP_IDS.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={elevation.ramp === r}
            aria-label={t(`vol.elev.ramp.${r}`)}
            title={t(`vol.elev.ramp.${r}`)}
            data-ramp={r}
            style={{ background: rampCss(r) }}
            onClick={() => {
              v.setElevation({ ramp: r });
            }}
          />
        ))}
      </div>
      <div className="ramp" style={{ background: rampCss(style.ramp) }} />
      <div className="ends">
        <span>{m1(style.lo)}</span>
        <span>{m1((style.lo + style.hi) / 2)}</span>
        <span>{m1(style.hi)}</span>
      </div>
      <label className="vol-rng">
        <span>{t('vol.elev.low')}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={style.lo}
          aria-label={t('vol.elev.low')}
          onChange={(e) => {
            setRange(parseFloat(e.target.value), style.hi);
          }}
        />
      </label>
      <label className="vol-rng">
        <span>{t('vol.elev.high')}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={style.hi}
          aria-label={t('vol.elev.high')}
          onChange={(e) => {
            setRange(style.lo, parseFloat(e.target.value));
          }}
        />
      </label>
      <button
        type="button"
        className="btn sm ghost"
        aria-pressed={elevation.range === null}
        title={t('vol.elev.autoTip')}
        onClick={() => {
          v.setElevation({ range: null });
        }}
      >
        {t('vol.elev.auto')}
      </button>
    </div>
  );
}

/** The Elevation surface's ramp and range as the second view of a comparison shows them. */
function ElevationKey() {
  const elevation = useVolumetric((s) => s.elevation);
  const relief = useVolumetric((s) => s.relief);
  const range = elevation.range ?? relief?.auto;
  return (
    <>
      <b>{t('vol.elev.title')}</b>
      {range ? (
        <>
          <div className="ramp" style={{ background: rampCss(elevation.ramp) }} />
          <div className="ends">
            <span>{m1(range[0])}</span>
            <span>{m1((range[0] + range[1]) / 2)}</span>
            <span>{m1(range[1])}</span>
          </div>
        </>
      ) : (
        <span className="vol-elev-note">{t('vol.elev.reading')}</span>
      )}
    </>
  );
}

/**
 * The legend of a 3D view. `view` is the second view of a comparison: the same keys read only
 * (the ramp and range are set on the main view's legend and hold for both), no hint, and one
 * line when this view could not be coloured.
 */
function Legend({ view }: { view?: { refused: boolean } }) {
  const chosen = useVolumetric((s) => s.surface);
  const body = useVolumetric((s) => s.body);
  const base = useVolumetric((s) => s.file?.bases.find((b) => b.id === s.base)?.label);
  const deadband = useVolumetric((s) => s.file?.deadbandM ?? 0.1);
  const swipe = useVolumetric((s) => s.swipe);
  const anyShown = useVolumetric((s) => s.selected !== null || s.shown.length > 0);
  // the swipe runs in the main view only
  if (swipe && !view) return null;
  // a view left uncoloured shows the photo, whatever the switch says
  const surface = view?.refused ? 'photo' : chosen;
  const R = CHANGE_RAMP;
  const rgb = (c: readonly number[]) => `rgb(${c.join(',')})`;
  if (surface === 'photo' && !anyShown) {
    if (view?.refused)
      return (
        <div className="vol-legend overlay-box" data-testid="vol-legend-view">
          <span className="vol-legend-note" role="status" data-testid="vol-no-drape">
            {t('vol.compare.noDrape')}
          </span>
        </div>
      );
    if (view) return null;
    return (
      <div className="vol-legend vol-hint overlay-box" data-testid="vol-hint">
        {t('vol.reveal')}
      </div>
    );
  }
  return (
    <div
      className={`vol-legend overlay-box${surface === 'elev' && !view ? ' live' : ''}`}
      aria-label="Legend"
      {...(view ? { 'data-testid': 'vol-legend-view', 'data-surface-shown': surface } : {})}
    >
      {surface === 'change' && (
        <>
          <b>Height change</b>
          <div
            className="ramp"
            style={{
              background: `linear-gradient(90deg, ${rgb(R.cutFar)}, ${rgb(R.cutNear)} 45%, ${rgb(R.grey)} 45% 55%, ${rgb(R.fillNear)} 55%, ${rgb(R.fillFar)})`,
            }}
          />
          <div className="ends">
            <span>{`−${String(R.rangeM)} m cut`}</span>
            <span>±{deadband.toFixed(1)}</span>
            <span>+{R.rangeM} m fill</span>
          </div>
        </>
      )}
      {surface === 'elev' && (view ? <ElevationKey /> : <ElevationControls />)}
      {body !== 'off' &&
        anyShown &&
        (surface === 'change' ? (
          <>
            <span className="key">
              <i style={{ background: CUT_CSS }} />
              Material removed
            </span>
            <span className="key">
              <i style={{ background: FILL_CSS }} />
              Material placed
            </span>
          </>
        ) : (
          <>
            <span className="key">
              <i style={{ background: '#ff4d4d' }} />
              Volume above base
            </span>
            <span className="key">
              <i style={{ background: '#e6ebf2' }} />
              {base} base
            </span>
          </>
        ))}
      {anyShown && (
        <span className="key">
          <i className="line" />
          Toe line
        </span>
      )}
      {view?.refused && (
        <span className="vol-legend-note" role="status" data-testid="vol-no-drape">
          {t('vol.compare.noDrape')}
        </span>
      )}
    </div>
  );
}

function Toast() {
  const message = useVolumetric((s) => s.message);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => {
      volumetric.getState().setMessage(null);
    }, 2600);
    return () => {
      clearTimeout(t);
    };
  }, [message]);
  if (!message) return null;
  return (
    <div className="vol-toast" role="status">
      {message}
    </div>
  );
}

/**
 * The volumetric layer of the 3D stage: draws through `VolumetricScene` and adds the boundary
 * handles, the swipe divider, the section and edit bars, the legend and notices. Mount it inside
 * the 3D pane, over the canvas.
 *
 * A pane that shows one survey date of several passes its `epoch`. The second view of a
 * comparison is mounted with `display`: it draws the same bodies, toe lines and surface colours
 * for its own date and shows the legend read only; editing, the section tool and the swipe stay
 * with the main view.
 */
export function VolumetricStage({
  stage,
  epoch = null,
  display = false,
  layerVisible,
  budget,
}: {
  stage: EngineStage | null;
  /**
   * The survey this view shows. Null: the one the volumetric store shows, or, in a view that
   * only draws, a date without volumes (nothing is drawn and no legend shows).
   */
  epoch?: string | null;
  /** Draw only (the second view of a comparison). */
  display?: boolean;
  /** Whether this view shows a layer; defaults to the workspace's layer switches. */
  layerVisible?: (id: string) => boolean;
  /** Whether a drape texture of that many bytes fits the graphics memory of the views. */
  budget?: (bytes: number) => boolean;
}) {
  const ready = useVolumetric((s) => s.status === 'ready');
  const picking = useVolumetric((s) => s.section.mode === 'picking');
  const scene = useMemo(
    () =>
      stage && ready
        ? new VolumetricScene(
            stage,
            volumetric,
            layerVisible ?? ((id) => workspace.getState().isLayerVisible(id)),
            { display, ...(budget ? { budget } : {}) },
          )
        : null,
    [stage, ready, display, layerVisible, budget],
  );
  // the pane's date, before the scene first draws
  useEffect(() => {
    scene?.setEpoch(epoch);
  }, [scene, epoch]);
  const refused = useSyncExternalStore(
    useCallback((cb: () => void) => scene?.onDrapeRefused(cb) ?? (() => undefined), [scene]),
    () => scene?.drapeRefused ?? false,
  );

  // Esc: stop picking a section, else hide the revealed pile (not while a boundary is edited);
  // Enter saves a boundary edit.
  useEffect(() => {
    if (!ready || display) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest('dialog, [role="dialog"]')) return;
      const s = volumetric.getState();
      if (isShortcut('scene.escape', e)) {
        if (s.section.mode === 'picking') s.clearSection();
        else if (s.selected && !s.edit) s.select(null);
        else return;
      } else if (isShortcut('volumes.save', e) && s.edit && (s.edit.dirty || s.edit.resetToAuto)) {
        if (s.saving || s.edit.busy) return;
        if (e.target instanceof HTMLElement && e.target.closest('button, a, tr, [role="button"]'))
          return;
        void s.saveEdit();
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [ready, display]);

  useEffect(() => {
    if (!scene) return;
    scene.attach();
    return () => {
      scene.detach();
    };
  }, [scene]);

  // Clicks on the stage: section points while picking, and lifted volume bodies select their pile.
  // Claimed through the stage, never by stopping the pointer events: the orbit controls must see
  // every release, or they keep turning the camera with the mouse after the first section point.
  useEffect(() => {
    if (!stage || !scene) return;
    const canvas = stage.renderer.domElement;
    const host = canvas.parentElement;
    if (!host) return;
    const ray = new Raycaster();
    const release = stage.claimClicks((e) => {
      if (stage.tool !== 'select') return false;
      const s = volumetric.getState();
      // a view that only draws takes no section point and guards no edit: it selects a pile
      if (display && (s.section.mode === 'picking' || s.edit)) return false;
      if (s.section.mode === 'picking') {
        const p = pickGround(stage, e.clientX, e.clientY);
        if (p) void s.addSectionPoint([p[0], p[1]]);
        return true;
      }
      // the scene selection stays on the pile being edited
      if (s.edit) return true;
      if (s.body !== 'lift') return false;
      ray.setFromCamera(new Vector2(...ndcOf(stage, e.clientX, e.clientY)), stage.camera);
      const tops: Object3D[] = [];
      scene.group.traverse((o) => {
        if (o.name === 'body-top' && o.visible) tops.push(o);
      });
      const pile = ray.intersectObjects(tops, false)[0]?.object.parent?.userData.pile as
        string | undefined;
      if (!pile) return false;
      s.select(pile);
      return true;
    });
    // callout plates select on click: not while picking section points or editing a boundary
    const onClick = (e: MouseEvent) => {
      const s = volumetric.getState();
      if (!display && (s.section.mode === 'picking' || s.edit)) e.stopPropagation();
    };
    host.addEventListener('click', onClick, true);
    return () => {
      release();
      host.removeEventListener('click', onClick, true);
    };
  }, [stage, scene, display]);

  useEffect(() => {
    if (!stage || display) return;
    setCursor(stage, picking ? 'crosshair' : '');
    return () => {
      setCursor(stage, '');
    };
  }, [stage, picking, display]);

  if (!ready) return null;
  if (display)
    // on a date without volumes the view draws none, so there is nothing to explain
    return epoch === null ? null : (
      <div className="vol-stage">
        <Legend view={{ refused }} />
      </div>
    );
  return (
    <div className="vol-stage">
      {scene && stage && <Handles scene={scene} stage={stage} />}
      <SwipeDivider />
      <Legend />
      <div className="vol-under">
        <SectionPanel />
        <EditBar />
      </div>
      <Toast />
    </div>
  );
}
