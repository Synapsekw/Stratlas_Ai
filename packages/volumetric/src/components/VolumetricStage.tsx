import type { EngineStage } from '@aio/engine';
import { defaultSurveySettings } from '@aio/schema';
import { formatRow } from '@aio/survey';
import { Icon, isShortcut, t, type MessageKey } from '@aio/ui';
import { workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Raycaster, Vector2, Vector3, type Camera, type Line, type Object3D } from 'three';
import { CHANGE_RAMP, RAMP_IDS, rampCss } from '../model/dsm';
import { VolumetricScene } from '../scene/controller';
import { useVolumetric, volumetric } from '../store';

function ndcOf(stage: EngineStage, clientX: number, clientY: number): [number, number] {
  const r = stage.renderer.domElement.getBoundingClientRect();
  return [((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1];
}

/** How near a toe line, in screen pixels, a click is on it. */
const TOE_PX = 6;

/** The pile an object of the volumetric scene draws (its `vol:<id>` group's id). */
function pileOf(o: Object3D | null): string | null {
  for (let p = o; p; p = p.parent) {
    const id: unknown = p.userData.pile;
    if (typeof id === 'string') return id;
  }
  return null;
}

/** Distance in pixels from (x, y) to the segment a-b. */
function segmentPx(x: number, y: number, a: Vector2, b: Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/**
 * The pile under a click on the volumetric scene: a body top in any body mode (lifted or in
 * place), else the nearest toe line within a few pixels (the outline left when bodies are hidden).
 * Hidden piles are not picked. `rect` is the canvas's client rectangle.
 */
export function pilePickAt(
  group: Object3D,
  camera: Camera,
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): string | null {
  const tops: Object3D[] = [];
  const toes: Line[] = [];
  group.traverseVisible((o) => {
    if (o.name === 'body-top') tops.push(o);
    // the toe lines are `LineLoop`s with a position attribute (`drawBodies`)
    else if (o.name === 'toe' || o.name === 'toe-selected') toes.push(o as Line);
  });
  const ray = new Raycaster();
  ray.setFromCamera(
    new Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1),
    camera,
  );
  const top = pileOf(ray.intersectObjects(tops, false)[0]?.object ?? null);
  if (top) return top;
  const v = new Vector3();
  const onScreen = (o: Line, i: number): Vector2 | null => {
    const pos = o.geometry.getAttribute('position');
    v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(camera);
    if (v.z > 1) return null;
    return new Vector2(
      rect.left + ((v.x + 1) / 2) * rect.width,
      rect.top + ((1 - v.y) / 2) * rect.height,
    );
  };
  let best: { pile: string; px: number } | null = null;
  for (const o of toes) {
    const n = o.geometry.getAttribute('position').count;
    const pile = pileOf(o);
    if (!pile || n < 2) continue;
    const pts = Array.from({ length: n }, (_, i) => onScreen(o, i));
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (!a || !b) continue;
      const px = segmentPx(x, y, a, b);
      if (px <= TOE_PX && (!best || px < best.px)) best = { pile, px };
    }
  }
  return best?.pile ?? null;
}

/**
 * Claim the stage's clicks after every other claimer: the claim is made again on each press, so
 * whatever registered since (pins, markers, a measurement drawn over a pile) is asked first and
 * keeps its click; a pile body only takes what nothing else wants. Returns the release.
 */
export function claimLast(
  stage: Pick<EngineStage, 'claimClicks'>,
  target: EventTarget,
  handler: (e: PointerEvent) => boolean,
): () => void {
  let release = stage.claimClicks(handler);
  const again = () => {
    release();
    release = stage.claimClicks(handler);
  };
  target.addEventListener('pointerdown', again, { capture: true });
  return () => {
    target.removeEventListener('pointerdown', again, { capture: true });
    release();
  };
}

/**
 * Select a clicked pile. A click on the pile already selected selects it again (through none), so
 * a listener to the selection (the app opening the pile's panel) sees every click, not only a
 * change.
 */
export function reselectPile(
  store: { getState(): { selected: string | null; select(pile: string | null): void } },
  pile: string,
): void {
  const s = store.getState();
  if (s.selected === pile) s.select(null);
  store.getState().select(pile);
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

function setCursor(stage: EngineStage, cursor: string) {
  stage.renderer.domElement.style.cursor = cursor;
}

function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement && (/INPUT|SELECT|TEXTAREA/.test(t.tagName) || t.isContentEditable)
  );
}

/* ------------------------------------------------------------------ overlays */

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

/**
 * A height or height change in metres, one decimal, through the app's formatter. The 3D layer has
 * no site settings of its own: the kit's grids are metric.
 */
const SITE = defaultSurveySettings();
const PRECISION = { ...SITE.precision, distance: 1 };
const m1 = (v: number) =>
  formatRow({ key: 'height', label: '', value: v, kind: 'distance' }, SITE.units, PRECISION);

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
 * Whether the main view's "Click a pile" hint shows: volumes are ready, the photo shows, no pile
 * is revealed, and no swipe or section is under way.
 */
export function useVolumeHint(): boolean {
  return useVolumetric(
    (s) =>
      s.status === 'ready' &&
      s.surface === 'photo' &&
      s.selected === null &&
      s.shown.length === 0 &&
      !s.swipe &&
      s.section.mode === 'idle',
  );
}

/** The "Click a pile" hint, for a host that places it itself (`VolumetricStage hint={false}`). */
export function VolumeHint() {
  return (
    <div className="vol-legend vol-hint overlay-box" data-testid="vol-hint">
      {t('vol.reveal')}
    </div>
  );
}

/** The kit's bases by their plain names, as the volume cards name them. */
const KIT_BASE_NAME: Readonly<Record<string, MessageKey>> = {
  tin: 'base.kitTin',
  plane: 'base.plane',
  avg: 'base.mean',
  low: 'base.lowest',
};

/**
 * The legend of a 3D view. `view` is the second view of a comparison: the same keys read only
 * (the ramp and range are set on the main view's legend and hold for both), no hint, and one
 * line when this view could not be coloured. `hint`: false when the host shows the hint itself.
 */
function Legend({ view, hint = true }: { view?: { refused: boolean }; hint?: boolean }) {
  const chosen = useVolumetric((s) => s.surface);
  const body = useVolumetric((s) => s.body);
  // the 3D bodies stand on the kit's default base (display only), named as the cards name it
  const base = useVolumetric((s) => {
    const id = s.file?.defaultBase;
    const key = id !== undefined ? KIT_BASE_NAME[id] : undefined;
    return key ? t(key) : (s.file?.bases.find((b) => b.id === id)?.label ?? id);
  });
  const deadband = useVolumetric((s) => s.file?.deadbandM ?? 0.1);
  const swipe = useVolumetric((s) => s.swipe);
  const sectionOpen = useVolumetric((s) => s.section.mode !== 'idle');
  const anyShown = useVolumetric((s) => s.selected !== null || s.shown.length > 0);
  // the swipe runs in the main view only; the section panel takes the legend's corner there
  if ((swipe || sectionOpen) && !view) return null;
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
    if (view || !hint) return null;
    return <VolumeHint />;
  }
  return (
    <div
      className={`vol-legend overlay-box${surface === 'elev' && !view ? ' live' : ''}`}
      aria-label={t('vol.legend.label')}
      {...(view ? { 'data-testid': 'vol-legend-view', 'data-surface-shown': surface } : {})}
    >
      {surface === 'change' && (
        <>
          <b>{t('vol.legend.change')}</b>
          <div
            className="ramp"
            style={{
              background: `linear-gradient(90deg, ${rgb(R.cutFar)}, ${rgb(R.cutNear)} 45%, ${rgb(R.grey)} 45% 55%, ${rgb(R.fillNear)} 55%, ${rgb(R.fillFar)})`,
            }}
          />
          <div className="ends">
            <span>{t('vol.legend.cutEnd', { value: m1(-R.rangeM) })}</span>
            <span>{t('vol.legend.deadband', { value: m1(deadband) })}</span>
            <span>{t('vol.legend.fillEnd', { value: m1(R.rangeM) })}</span>
          </div>
        </>
      )}
      {surface === 'elev' && (view ? <ElevationKey /> : <ElevationControls />)}
      {body !== 'off' && anyShown && surface !== 'change' && (
        <>
          <span className="key">
            <i className="vol-key-body" />
            {t('vol.legend.body')}
          </span>
          <span className="key">
            <i className="vol-key-base" />
            {t('vol.legend.base', { base: base ?? '' })}
          </span>
        </>
      )}
      {anyShown && (
        <span className="key">
          <i className="line" />
          {t('vol.legend.toe')}
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
 * The volumetric layer of the 3D stage: draws through `VolumetricScene` and adds the swipe
 * divider, the legend and notices. Mount it inside the 3D pane, over the canvas. The drawn
 * section line's panel is the host's (the desktop's `VolumeSection`, with its profile chart).
 *
 * A pane that shows one survey date of several passes its `epoch`. The second view of a
 * comparison is mounted with `display`: it draws the same bodies, toe lines and surface colours
 * for its own date and shows the legend read only; the section tool and the swipe stay with the
 * main view.
 */
export function VolumetricStage({
  stage,
  epoch = null,
  display = false,
  layerVisible,
  budget,
  hint = true,
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
  /** False: the host shows the "Click a pile" hint itself (`useVolumeHint`, `VolumeHint`). */
  hint?: boolean;
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

  // Esc: stop picking a section, else hide the revealed pile.
  useEffect(() => {
    if (!ready || display) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest('dialog, [role="dialog"]')) return;
      const s = volumetric.getState();
      if (!isShortcut('scene.escape', e)) return;
      if (s.section.mode === 'picking') s.clearSection();
      else if (s.selected) s.select(null);
      else return;
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

  // Clicks on the stage: section points while picking, and a pile's body (any body mode) or toe
  // line selects it.
  // Claimed through the stage, never by stopping the pointer events: the orbit controls must see
  // every release, or they keep turning the camera with the mouse after the first section point.
  useEffect(() => {
    if (!stage || !scene) return;
    const canvas = stage.renderer.domElement;
    const host = canvas.parentElement;
    if (!host) return;
    // section points while picking: asked in the order the claim was made
    const releaseSection = stage.claimClicks((e) => {
      if (stage.tool !== 'select') return false;
      const s = volumetric.getState();
      // a view that only draws takes no section point: it selects a pile
      if (display || s.section.mode !== 'picking') return false;
      const p = pickGround(stage, e.clientX, e.clientY);
      if (p) void s.addSectionPoint([p[0], p[1]]);
      return true;
    });
    // a pile's body or toe line: asked last, so a measurement over the pile keeps its click
    const releasePile = claimLast(stage, window, (e) => {
      if (stage.tool !== 'select') return false;
      if (volumetric.getState().section.mode === 'picking') return false;
      const pile = pilePickAt(
        scene.group,
        stage.camera,
        canvas.getBoundingClientRect(),
        e.clientX,
        e.clientY,
      );
      if (!pile) return false;
      reselectPile(volumetric, pile);
      return true;
    });
    // callout plates select on click: not while picking section points
    const onClick = (e: MouseEvent) => {
      const s = volumetric.getState();
      if (!display && s.section.mode === 'picking') e.stopPropagation();
    };
    host.addEventListener('click', onClick, true);
    return () => {
      releaseSection();
      releasePile();
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
      <SwipeDivider />
      <Legend hint={hint} />
      <Toast />
    </div>
  );
}
