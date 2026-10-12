import type { WalkLayer } from '@aio/schema';
import { formatDate, Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { drawings as drawingsStore } from '../drawings/store';
import type { RasterOverlayContext, RasterPick } from '../workspace/RasterPane';
import { surfaceFramesOf, surfaceKey, type PlaceSurface } from './placeModel';
import type { PlaceState } from './placeStore';
import {
  placeFlow,
  placeSession,
  placeUi,
  walkColour,
  wantsSurfaceClick,
  type PlaceUi,
  type PlaceWalkFlow,
} from './placeWalk';
import { walkDrawingsForSheet, walkNowOnSheet } from './walkOverlay';
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
  keep: 'Keep these pins?',
} as const;

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
  const [yawText, setYawText] = useState<string | null>(null);
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
            : st.armed === 'pin'
              ? SAY.pin
              : SAY[st.step];
  const problem = u.note ?? st.error;
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
          disabled={!enough || u.saving || st.error !== null}
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
              disabled={!enough || u.saving || st.error !== null}
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
                  <button
                    type="button"
                    className={current ? 'btn primary sm' : 'btn ghost sm'}
                    aria-current={current ? 'step' : undefined}
                    data-testid={`walk-place-step-${s.id}`}
                    disabled={!reached}
                    title={pinT !== undefined && !current ? 'Show this moment' : undefined}
                    onClick={() => {
                      seekTo(pinT);
                    }}
                  >
                    <b>{i + 1}</b>
                    {s.label}
                  </button>
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
            return (
              <span key={k} className="dplace-pair" data-testid="walk-place-pin">
                <b>{k + 1}</b>
                {r && !r.active
                  ? 'gone'
                  : r?.residualM !== null && r?.residualM !== undefined
                    ? `${r.residualM.toFixed(2)} m`
                    : 'set'}
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
      {pinsOnly && (
        <p className="wplace-note faint" data-testid="walk-place-pins-only">
          {SAY.pinsOnly}
        </p>
      )}
    </div>
  );
}

/**
 * The strip where it belongs: over the surface the walk is being placed on (`at`), or in the 360
 * pane (`at` 'walk') when the project offers no surface.
 */
export function PlaceWalkHere({ at }: { at: PlaceSurface | 'walk' }) {
  const host = useStore(placeUi, (s) => (s.layerId === null ? undefined : s.host));
  if (host === undefined) return null;
  const here = at === 'walk' ? host === null : host !== null && surfaceKey(host) === surfaceKey(at);
  if (!here) return null;
  return <PlaceWalkStrip flow={placeFlow} session={placeSession} ui={placeUi} />;
}

const NO_MARKS: RasterPick['marks'] = [];

/**
 * A walk being placed on the drawing `layerId`: the strip shows over it, clicks on the picture drop
 * the armed pin (`pick`), and the overlay draws the live path, stills, pins (draggable) and the
 * current position in the picture's pixels. Nothing while no walk is placed on this drawing.
 */
export function useWalkPlacingOn(
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
  const on = placingId !== null && surfaceId === layerId;
  const walk = on
    ? manifest?.layers.find((l): l is WalkLayer => l.kind === 'walk' && l.id === placingId)
    : undefined;
  const frame = useMemo(
    () => (on && manifest ? surfaceFramesOf(manifest, (id) => placed[id]).drawing(layerId) : null),
    [on, manifest, placed, layerId],
  );
  const colour = walk && manifest ? walkColour(manifest, walk) : 'var(--acc)';
  // the path is built again only when the fit changes, never on a time tick
  const sheet = useMemo(
    () =>
      walk && fit && frame
        ? walkDrawingsForSheet(
            [{ layer: { ...walk, visible: true }, fit, raw }],
            frame,
            () => colour,
            {
              placingId: walk.id,
              ...(size ? { size } : {}),
            },
          )
        : [],
    [walk, fit, frame, raw, colour, size],
  );
  const now =
    walk && fit && frame
      ? walkNowOnSheet({ layer: walk, fit, raw }, frame, () => colour, time, size)
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
  const overlay = on
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
