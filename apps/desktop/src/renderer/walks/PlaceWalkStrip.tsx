import type { WalkLayer } from '@aio/schema';
import { formatDate, Icon } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useStore, type StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { drawings as drawingsStore } from '../drawings/store';
import type { RasterOverlayContext, RasterPick } from '../workspace/RasterPane';
import { placeImagery } from './placeBasemap';
import { surfaceFramesOf, surfaceKey, type PlaceSurface } from './placeModel';
import type { PlaceState } from './placeStore';
import {
  placeFlow,
  placeSession,
  placeUi,
  useHiddenLayers,
  usePlacedWalkFits,
  walkColour,
  walksOnSheet,
  wantsSurfaceClick,
  type PlaceUi,
  type PlaceWalkFlow,
} from './placeWalk';
import { walkNowOnSheet } from './walkOverlay';
import { WalkSheetOverlay } from './WalkSheetOverlay';
import './placeWalk.css';

/*
 * The Place walk strip (design "Placing a walk: the flow", "Visual direction"): over the surface
 * pane, laid out like the drawing's Place on the site strip. One line says what to do; the steps
 * Start, End and Correct are numbered and only the current one is primary; the date question and
 * the unsaved pins question are asked inline, never in a dialog.
 */

const STEPS = [
  { id: 'start', label: 'Start' },
  { id: 'end', label: 'End' },
  { id: 'correct', label: 'Correct' },
] as const;

const SAY = {
  date: 'Choose the survey date of this walk',
  surface: 'Choose what to place the walk on.',
  start: 'Where did the walk start? Click the spot.',
  end: 'Where did it end? Click the spot.',
  correct: 'Scrub to a moment, then Pin here and click the true spot.',
  pin: 'Click the true spot for this moment.',
  align360: 'Click a landmark in the 360 view',
  alignSurface: 'Now click the same landmark here',
  pinsOnly: 'Path not computed: the walk is placed between your pins.',
  noImagery:
    'No satellite imagery here. Turn on Online satellite in the map type picker, or import an imagery pack.',
  orthoOff: 'Your orthomosaic is switched off.',
  keep: 'Keep these pins?',
} as const;

const moveSay = (i: number): string => `Click the new spot for pin ${String(i + 1)}.`;

const surfaceName = (s: PlaceSurface): string => (s.kind === 'map' ? 'Map' : s.name);

export function PlaceWalkStrip({
  flow,
  session,
  ui,
}: {
  flow: PlaceWalkFlow;
  session: StoreApi<PlaceState>;
  ui: StoreApi<PlaceUi>;
}) {
  const st = useStore(session);
  const u = useStore(ui);
  const imagery = useStore(placeImagery, (s) => s.imagery);
  const hidden = useWorkspace((s) => s.hidden);
  const [yawText, setYawText] = useState<string | null>(null);
  // Esc lets go of a pin waiting to be moved; it stays where it is
  const movingPin = st.armed === 'move' ? st.moving : null;
  useEffect(() => {
    if (movingPin === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      session.getState().armMove(movingPin);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [movingPin, session]);
  const walk = flow.walk();
  if (u.layerId === null || walk?.id !== u.layerId || st.layerId !== u.layerId) return null;

  const pinsOnly = u.inputs.raw === null || u.inputs.raw.source === 'pins-only';
  const placing = st.step === 'start' || st.step === 'end' || st.step === 'correct';
  const enough = st.pins.length >= 2;
  const say =
    st.step === 'date'
      ? SAY.date
      : st.step === 'surface'
        ? SAY.surface
        : st.armed === 'align-360'
          ? SAY.align360
          : st.armed === 'align-surface'
            ? SAY.alignSurface
            : st.armed === 'move' && st.moving !== null
              ? moveSay(st.moving)
              : st.armed === 'pin'
                ? SAY.pin
                : SAY[st.step];
  const problem = u.note ?? st.error;
  // only the fit's own refusal stops a save; a passing note (a drawing not ready) does not
  const refused = (st.fit?.error ?? null) !== null;
  const stepIndex = STEPS.findIndex((s) => s.id === st.step);

  const seekTo = (time: number | undefined) => {
    if (time === undefined) return;
    session.getState().setTime(time);
    ui.setState((s) => ({ seek: { t: time, n: (s.seek?.n ?? 0) + 1 } }));
  };

  const yawKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const by = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
    session.getState().setYaw(session.getState().yawOffsetDeg + by);
    setYawText(null);
  };

  const cancelEnd = (
    <span className="dplace-end">
      <button
        type="button"
        className="btn ghost sm"
        data-testid="walk-place-cancel"
        onClick={() => {
          flow.close();
        }}
      >
        Cancel
      </button>
      {placing && (
        <button
          type="button"
          className="btn sm"
          data-testid="walk-place-save"
          disabled={!enough || u.saving || refused}
          onClick={() => void flow.save()}
        >
          <Icon name="check" size={14} />
          Save
        </button>
      )}
    </span>
  );

  if (u.asking)
    return (
      <div
        className="dplace wplace"
        role="group"
        aria-label={`Place ${walk.name}`}
        data-testid="walk-place-strip"
      >
        <div className="dplace-row" role="group" aria-label={SAY.keep}>
          <p className="dplace-say" role="status">
            {SAY.keep}
          </p>
          <span className="dplace-end">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                flow.keepPlacing();
              }}
            >
              Keep placing
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="walk-place-discard"
              onClick={() => {
                flow.discard();
              }}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn primary sm"
              data-testid="walk-place-keep"
              disabled={!enough || u.saving || refused}
              onClick={() => void flow.save()}
            >
              <Icon name="check" size={14} />
              Save
            </button>
          </span>
        </div>
      </div>
    );

  if (st.step === 'date') {
    const { pick, add } = flow.dates();
    return (
      <div
        className="dplace wplace"
        role="group"
        aria-label={`Place ${walk.name}`}
        data-testid="walk-place-strip"
        data-step="date"
      >
        <p className={problem ? 'dplace-say bad' : 'dplace-say'} role="status">
          {problem ?? SAY.date}
        </p>
        <div className="dplace-row" role="group" aria-label={SAY.date}>
          {pick.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={i === 0 && add === undefined ? 'btn primary sm' : 'btn sm'}
              data-testid="walk-place-date"
              onClick={() => void flow.chooseDate(c.id)}
            >
              <span
                className="wplace-swatch"
                style={{ '--sw': c.colour } as CSSProperties}
                aria-hidden="true"
              />
              {c.label}
            </button>
          ))}
          {add !== undefined && (
            <button
              type="button"
              className="btn primary sm"
              data-testid="walk-place-add-date"
              onClick={() => void flow.addDate(add)}
            >
              <Icon name="plus" size={14} />
              Add survey date {formatDate(add)}
            </button>
          )}
          {cancelEnd}
        </div>
      </div>
    );
  }

  const surfaces = flow.surfaces();
  // on the map the spots are found on imagery: the project's orthomosaics, else satellite
  const onMap = st.surface?.kind === 'map';
  const orthos = onMap ? flow.orthos() : [];
  const orthosOff = orthos.filter((id) => hidden[id]);
  const orthosOn = orthos.length - orthosOff.length;
  const value = st.surface ? surfaceKey(st.surface) : '';
  return (
    <div
      className="dplace wplace"
      role="group"
      aria-label={`Place ${walk.name}`}
      data-testid="walk-place-strip"
      data-step={st.step}
    >
      <p className={problem ? 'dplace-say bad' : 'dplace-say'} role="status">
        {problem ?? say}
      </p>
      <div className="dplace-row">
        <label className="wplace-on">
          <span className="faint">Place on</span>
          <select
            className="input"
            aria-label="Place on"
            data-testid="walk-place-on"
            value={value}
            onChange={(e) => {
              const s = surfaces.find((x) => surfaceKey(x) === e.target.value);
              if (s) flow.chooseSurface(s);
            }}
          >
            {value === '' && (
              <option value="" disabled>
                {surfaces.length === 0 ? 'No placed drawing' : 'Choose'}
              </option>
            )}
            {surfaces.map((s) => (
              <option key={surfaceKey(s)} value={surfaceKey(s)}>
                {surfaceName(s)}
              </option>
            ))}
          </select>
        </label>
        {st.surface && (
          <ol className="wplace-steps" aria-label="Steps">
            {STEPS.map((s, i) => {
              const current = s.id === st.step;
              const reached = i <= stepIndex;
              const pinT =
                s.id === 'start' ? st.pins[0]?.t : s.id === 'end' ? st.pins.at(-1)?.t : undefined;
              return (
                <li key={s.id}>
                  {current ? (
                    // the step in hand: a marker, not a button (it does nothing)
                    <span
                      className="btn primary sm wplace-now"
                      aria-current="step"
                      data-testid={`walk-place-step-${s.id}`}
                    >
                      <b>{i + 1}</b>
                      {s.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost sm"
                      data-testid={`walk-place-step-${s.id}`}
                      disabled={!reached || pinT === undefined}
                      title={pinT !== undefined ? 'Show this moment' : undefined}
                      onClick={() => {
                        seekTo(pinT);
                      }}
                    >
                      <b>{i + 1}</b>
                      {s.label}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {cancelEnd}
      </div>
      {st.surface && (
        <div className="dplace-row">
          {st.pins.map((p, k) => {
            const r = st.fit?.pins.find((f) => f.index === k);
            const moving = st.armed === 'move' && st.moving === k;
            const status =
              r && !r.active
                ? 'gone'
                : r?.residualM !== null && r?.residualM !== undefined
                  ? `${r.residualM.toFixed(2)} m`
                  : 'set';
            return (
              <span
                key={k}
                className={moving ? 'dplace-pair wplace-pin moving' : 'dplace-pair wplace-pin'}
                data-testid="walk-place-pin"
              >
                {/* the chip itself moves its pin: armed, the next click on the surface is its spot */}
                <button
                  type="button"
                  className="wplace-pin-move"
                  data-testid="walk-place-pin-move"
                  aria-pressed={moving}
                  aria-label={`Pin ${String(k + 1)}: ${status}. Click to move`}
                  disabled={u.saving}
                  title={
                    moving
                      ? 'Click the new spot, or click here again to keep the pin where it is'
                      : 'Click to move, then click the new spot'
                  }
                  onClick={() => {
                    session.getState().armMove(k);
                  }}
                >
                  <b>{k + 1}</b>
                  {status}
                </button>
                <button
                  type="button"
                  aria-label={`Remove pin ${String(k + 1)}`}
                  title="Remove this pin"
                  onClick={() => {
                    session.getState().removePin(k);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
                <span className="sr-only">at {p.t.toFixed(1)} s</span>
              </span>
            );
          })}
          <button
            type="button"
            className="btn sm"
            data-testid="walk-place-pin-here"
            aria-pressed={st.armed === 'pin'}
            disabled={!enough || st.step !== 'correct'}
            onClick={() => {
              session.getState().pinHere();
            }}
          >
            <Icon name="pin" size={14} />
            Pin here
          </button>
          <button
            type="button"
            className="btn sm"
            data-testid="walk-place-align"
            aria-pressed={st.armed === 'align-360' || st.armed === 'align-surface'}
            disabled={!enough || st.step !== 'correct'}
            onClick={() => {
              session.getState().armAlign();
            }}
          >
            <Icon name="target" size={14} />
            Align view
          </button>
          <label className="wplace-yaw">
            <span className="faint">Heading</span>
            <input
              className="input mono"
              type="number"
              inputMode="decimal"
              step={1}
              min={-180}
              max={180}
              aria-label="Heading offset in degrees"
              data-testid="walk-place-yaw"
              disabled={!enough}
              value={yawText ?? String(Math.round(st.yawOffsetDeg * 10) / 10)}
              onKeyDown={yawKey}
              onChange={(e) => {
                setYawText(e.target.value);
                const v = Number(e.target.value);
                if (e.target.value.trim() !== '' && Number.isFinite(v))
                  session.getState().setYaw(v);
              }}
              onBlur={() => {
                setYawText(null);
              }}
            />
            <span className="faint">deg</span>
          </label>
        </div>
      )}
      {onMap && orthosOff.length > 0 && (
        <p className="wplace-note faint" data-testid="walk-place-ortho-off">
          {SAY.orthoOff}{' '}
          <button
            type="button"
            className="wplace-link"
            data-testid="walk-place-ortho-show"
            onClick={() => {
              workspace.getState().setLayersVisible(orthosOff, true);
            }}
          >
            Show it
          </button>
        </p>
      )}
      {onMap && imagery === false && orthosOff.length === 0 && orthosOn === 0 && (
        <p className="wplace-note faint" data-testid="walk-place-no-imagery">
          {SAY.noImagery}
        </p>
      )}
      {pinsOnly && (
        <p className="wplace-note faint" data-testid="walk-place-pins-only">
          {SAY.pinsOnly}
        </p>
      )}
    </div>
  );
}
/** How many surface panes show the strip now (the 360 pane shows it when none does). */
export const stripHosts = createStore<{ shown: number }>()(() => ({ shown: 0 }));

/**
 * Whether the 360 pane shows the strip: when no surface can be offered (`host` null), or when the
 * surface it sits over is on neither side of the split, so a running session is never invisible.
 */
export function stripInWalkPane(host: PlaceSurface | null, surfacesShowing: number): boolean {
  return host === null || surfacesShowing === 0;
}

/**
 * The strip where it belongs: over the surface the walk is being placed on (`at`), or in the 360
 * pane (`at` 'walk') when that surface is not on screen.
 */
export function PlaceWalkHere({ at }: { at: PlaceSurface | 'walk' }) {
  const host = useStore(placeUi, (s) => (s.layerId === null ? undefined : s.host));
  const showing = useStore(stripHosts, (s) => s.shown);
  const onSurface =
    at !== 'walk' && host !== undefined && host !== null && surfaceKey(host) === surfaceKey(at);
  useEffect(() => {
    if (!onSurface) return;
    stripHosts.setState((s) => ({ shown: s.shown + 1 }));
    return () => {
      stripHosts.setState((s) => ({ shown: s.shown - 1 }));
    };
  }, [onSurface]);
  if (host === undefined) return null;
  const here = at === 'walk' ? stripInWalkPane(host, showing) : onSurface;
  if (!here) return null;
  return <PlaceWalkStrip flow={placeFlow} session={placeSession} ui={placeUi} />;
}

const NO_MARKS: RasterPick['marks'] = [];

/**
 * The walks on the drawing `layerId`: every visible, placed walk at 60 %, and while a walk is
 * being placed on this drawing its live path with draggable pins and the current position, plus
 * a pick for the armed pin. No overlay when the drawing has no frame (not placed, size unknown).
 */
export function useWalksOnDrawing(
  layerId: string,
  size: { width: number; height: number } | undefined,
): {
  on: boolean;
  pick: RasterPick | undefined;
  overlay: ((ctx: RasterOverlayContext) => ReactNode) | undefined;
} {
  const placingId = useStore(placeSession, (s) => s.layerId);
  const surfaceId = useStore(placeSession, (s) =>
    s.surface?.kind === 'drawing' ? s.surface.id : null,
  );
  const fit = useStore(placeSession, (s) => s.fit);
  const clickable = useStore(placeSession, wantsSurfaceClick);
  const time = useStore(placeSession, (s) => s.timeS);
  const raw = useStore(placeUi, (s) => s.inputs.raw);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const placed = useStore(drawingsStore, (s) => s.placed);
  const hidden = useHiddenLayers();
  const { fits } = usePlacedWalkFits();
  const on = placingId !== null && surfaceId === layerId;
  const walk = on
    ? manifest?.layers.find((l): l is WalkLayer => l.kind === 'walk' && l.id === placingId)
    : undefined;
  const placing = useMemo(() => (walk && fit ? { layer: walk, fit, raw } : null), [walk, fit, raw]);
  // the paths are built again only when a fit or the drawing changes, never on a time tick
  const sheet = useMemo(
    () =>
      manifest
        ? walksOnSheet(manifest, layerId, fits, (id) => placed[id], { placing, hidden, size })
        : [],
    [manifest, layerId, fits, placed, placing, hidden, size],
  );
  const frame = useMemo(
    () =>
      placing && manifest ? surfaceFramesOf(manifest, (id) => placed[id]).drawing(layerId) : null,
    [placing, manifest, placed, layerId],
  );
  const now =
    placing && frame && manifest
      ? walkNowOnSheet(placing, frame, (l) => walkColour(manifest, l), time, size)
      : null;
  const pick = useMemo<RasterPick | undefined>(
    () =>
      on && clickable
        ? {
            onPick: (px) => {
              placeSession.getState().click(px);
            },
            marks: NO_MARKS,
          }
        : undefined,
    [on, clickable],
  );
  const overlay =
    on || sheet.length > 0
      ? (ctx: RasterOverlayContext) => (
          <WalkSheetOverlay
            drawings={sheet}
            scale={ctx.scale}
            now={now}
            size={ctx.size}
            toImage={ctx.toImage}
            onPinDrag={(_id, i, px) => {
              placeSession.getState().movePin(i, px);
            }}
            onPinDragEnd={(_id, i, px) => {
              placeSession.getState().movePin(i, px);
            }}
          />
        )
      : undefined;
  return { on, pick, overlay };
}

/** The Place walk strip sits over the map pane (its layout makes room for it). */
export function usePlacingOnMap(): boolean {
  return useStore(placeUi, (s) => s.layerId !== null && s.host?.kind === 'map');
}
