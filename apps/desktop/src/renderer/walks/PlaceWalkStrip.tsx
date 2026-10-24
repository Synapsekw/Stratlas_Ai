import type { WalkLayer } from '@aio/schema';
import { formatDate, Icon, t } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useStore, type StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { drawings as drawingsStore } from '../drawings/store';
import { useProcessingTools } from '../processingTools';
import { useJobs } from '../shell';
import type { RasterOverlayContext, RasterPick } from '../workspace/RasterPane';
import { placeImagery } from './placeBasemap';
import {
  surfaceById,
  surfaceFramesOf,
  surfaceId,
  surfaceLabel,
  type PlaceSurface,
  type WalkPathState,
} from './placeModel';
import { canRemovePin, type PlaceState } from './placeStore';
import {
  placedNowOnSheet,
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
import { packOffersWalkProcess } from './walkModel';
import { previewOnSheet, walkNowOnSheet } from './walkOverlay';
import { useWalkView, useWalkViewsAmong } from './walkView';
import { WalkSheetOverlay } from './WalkSheetOverlay';
import './placeWalk.css';

/*
 * The placing toolbar (design "Walk placing by start and end"): one slim line over the surface,
 * the current step's hint first and Save last. A walk without a computed path shows the path
 * notice first; once placed, Start and End are dragged on the surface and Fine-tune opens the
 * pin tools with the 360 video. Every question is asked inline, never in a dialog.
 */

const SAY = {
  start: 'Click where the walk started. Its shape follows the pointer.',
  end: 'Click where the walk ended. Esc moves the start.',
  tooClose: 'These pins are at the same moment of the walk. Pick another moment.',
  placed: 'Drag Start or End to adjust the walk, then Save.',
  dragRefused: 'These pins are at the same moment of the walk. Pick another moment.',
  fineTune: 'Scrub to a moment, then Pin here and click the true spot.',
  pin: 'Click the true spot for this moment.',
  align360: 'Click a landmark in the 360 view',
  alignSurface: 'Now click the same landmark here',
  pinsOnly: 'Path not computed: the walk is placed between your two points.',
  keep: 'Keep these changes?',
  removeAsk: 'Remove this placement? The walk stays in the project.',
  noImagery:
    'No satellite imagery here. Turn on Online satellite in the map type picker, or import an imagery pack.',
  orthoOff: 'Your orthomosaic is switched off.',
} as const;

const NOTICE: Record<Exclude<WalkPathState, 'ready'>, string> = {
  none: 'This walk is not processed yet, so its path is unknown.',
  running: 'This walk is processing. Its shape appears here when it finishes.',
  failed: 'Processing this walk failed, so its path is unknown.',
  interrupted: 'Processing stopped before the path was computed.',
};

const moveSay = (i: number): string => `Click the new spot for pin ${String(i + 1)}.`;

/** What the hint line says for the session as it stands (a problem is said instead). */
function hintFor(st: PlaceState, pathState: WalkPathState): string {
  switch (st.step) {
    case 'check':
      return NOTICE[pathState === 'ready' ? 'none' : pathState];
    case 'start':
      return SAY.start;
    case 'end':
      return st.preview?.tooClose ? SAY.tooClose : SAY.end;
    case 'placed':
      return st.dragging?.refused ? SAY.dragRefused : SAY.placed;
    case 'fine-tune':
      if (st.dragging?.refused) return SAY.dragRefused;
      if (st.armed === 'align-360') return SAY.align360;
      if (st.armed === 'align-surface') return SAY.alignSurface;
      if (st.armed === 'move' && st.moving !== null) return moveSay(st.moving);
      if (st.armed === 'pin') return SAY.pin;
      return SAY.fineTune;
  }
}

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
  // re-render on job progress, so the notice and its button follow the walk's processing
  useJobs((s) => s.jobs);
  const offered = useProcessingTools((s) => packOffersWalkProcess(s.status));
  const packId = useId();
  const [yawText, setYawText] = useState<string | null>(null);
  // Remove placement's question and its refusal belong to the walk they were asked for
  const [askRemoveFor, setAskRemoveFor] = useState<string | null>(null);
  const [removeRefused, setRemoveRefused] = useState<{ id: string; error: string } | null>(null);
  const askRemove = askRemoveFor !== null && askRemoveFor === u.layerId;
  const removeError = removeRefused?.id === u.layerId ? removeRefused.error : null;
  const askId = useId();
  const removeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // the question takes the focus when it opens, so a keyboard answers it at once
  useEffect(() => {
    if (askRemove) keepRef.current?.focus();
  }, [askRemove]);
  const closeAsk = () => {
    setAskRemoveFor(null);
    removeRef.current?.focus();
  };
  // Esc lets go of a pin waiting to be moved (it stays where it is), and on End takes the start
  // back (bubble phase: a 3D drag or an open question stops its own Escape before it gets here)
  const movingPin = st.armed === 'move' ? st.moving : null;
  const onEnd = st.step === 'end';
  useEffect(() => {
    if (movingPin === null && !onEnd) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // an Escape typed in the yaw or date field only leaves the field
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (
        el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      e.preventDefault();
      if (movingPin !== null) session.getState().armMove(movingPin);
      else session.getState().back();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [movingPin, onEnd, session]);
  const walk = flow.walk();
  if (u.layerId === null || walk?.id !== u.layerId || st.layerId !== u.layerId) return null;

  const pathState = flow.pathState();
  const pinsOnly = u.inputs.raw === null || u.inputs.raw.source === 'pins-only';
  const enough = st.pins.length >= 2;
  const problem = removeError ?? u.note ?? st.error ?? st.fit?.warning;
  const checking = st.step === 'check';
  // on the check the notice's sentence stays beside a problem: why the path is unknown still holds
  const hint = checking ? hintFor(st, pathState) : (problem ?? hintFor(st, pathState));
  // only the fit's own refusal stops a save; a passing note (a drawing not ready) does not
  const refused = (st.fit?.error ?? null) !== null;
  const fineTuning = st.step === 'fine-tune';

  const hintLine = (
    <p
      className={problem && !checking ? 'dplace-say wplace-hint bad' : 'dplace-say wplace-hint'}
      role="status"
      data-testid="walk-place-hint"
    >
      {checking && problem ? (
        <>
          {hint} <span className="wplace-problem">{problem}</span>
        </>
      ) : (
        hint
      )}
    </p>
  );
  const placedBefore =
    walk.place !== undefined && walk.place.quality !== 'unplaced' && walk.place.pins.length >= 2;
  // Save only when there is something to save: a placed walk with changes (pins, heading, or the
  // survey date of an undated walk)
  const changed = st.dirty || (walk.capture === undefined && u.date !== null);
  const canSave =
    (st.step === 'placed' || st.step === 'fine-tune') && enough && changed && !u.saving && !refused;

  if (u.asking)
    return (
      <div
        className="dplace wplace"
        role="group"
        aria-label={`Place ${walk.name}`}
        data-testid="walk-place-strip"
        data-step={st.step}
      >
        <div className="dplace-row" role="group" aria-label={SAY.keep}>
          <p className="dplace-say wplace-hint" role="status" data-testid="walk-place-hint">
            {problem ?? SAY.keep}
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
              disabled={!enough || u.saving || refused || checking}
              onClick={() => void flow.save()}
            >
              <Icon name="check" size={14} />
              Save
            </button>
          </span>
        </div>
      </div>
    );

  const surfaces = flow.surfaces();
  // on the map the spots are found on imagery: the project's orthomosaics, else satellite
  const onMap = st.surface?.kind === 'map';
  const orthos = onMap ? flow.orthos() : [];
  const orthosOff = orthos.filter((id) => hidden[id]);
  const orthosOn = orthos.length - orthosOff.length;
  const value = st.surface ? surfaceId(st.surface) : '';
  const dates = walk.capture === undefined ? flow.dates() : null;

  const cancel = (
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
  );

  // the fields name themselves (aria-label, title): the toolbar stays two rows on a narrow pane
  const placeOn = (
    <span className="wplace-field">
      <select
        className="input"
        aria-label="Place on"
        title="Place on"
        data-testid="walk-place-on"
        value={value}
        onChange={(e) => {
          const s = surfaceById(surfaces, e.target.value);
          if (s) flow.chooseSurface(s);
        }}
      >
        {value === '' && (
          <option value="" disabled>
            {surfaces.length === 0 ? 'No placed drawing' : 'Choose'}
          </option>
        )}
        {surfaces.map((s) => (
          <option key={surfaceId(s)} value={surfaceId(s)}>
            {surfaceLabel(s)}
          </option>
        ))}
      </select>
    </span>
  );

  const dateField = dates && (
    <span className="wplace-field">
      <select
        className="input"
        aria-label="Survey date"
        title="Survey date"
        data-testid="walk-place-date-field"
        value={u.date ?? ''}
        disabled={u.saving}
        onChange={(e) => {
          flow.setDate(e.target.value === '' ? null : e.target.value);
        }}
      >
        {dates.pick.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
        {dates.add !== undefined && (
          <option value={`add:${dates.add}`}>Add survey date {formatDate(dates.add)}</option>
        )}
        {(dates.pick.length === 0 && dates.add === undefined) || u.date === null ? (
          <option value="">No survey date</option>
        ) : null}
      </select>
    </span>
  );

  return (
    <div
      className="dplace wplace"
      role="group"
      aria-label={`Place ${walk.name}`}
      data-testid="walk-place-strip"
      data-step={st.step}
    >
      {checking ? (
        <div className="dplace-row">
          <div
            className="wplace-notice"
            data-testid="walk-place-notice"
            data-state={pathState === 'ready' ? 'none' : pathState}
          >
            {hintLine}
            {pathState !== 'running' && (
              <button
                type="button"
                className="btn primary sm"
                data-testid="walk-place-process"
                disabled={!offered || u.saving}
                aria-describedby={offered ? undefined : packId}
                onClick={() => void flow.process()}
              >
                <Icon name="play" size={14} />
                {pathState === 'none' ? 'Process walk' : 'Process again'}
              </button>
            )}
            <button
              type="button"
              className="btn ghost sm"
              data-testid="walk-place-anyway"
              onClick={() => {
                flow.placeAnyway();
              }}
            >
              Place between two points anyway
            </button>
            {!offered && pathState !== 'running' && (
              <span className="faint" id={packId}>
                {t('walk.process.needsPack')}
              </span>
            )}
          </div>
          <span className="dplace-end">{cancel}</span>
        </div>
      ) : (
        <>
          <div className="dplace-row">
            {hintLine}
            <span className="dplace-end">
              {cancel}
              <button
                type="button"
                className="btn primary sm"
                data-testid="walk-place-save"
                disabled={!canSave}
                onClick={() => void flow.save()}
              >
                <Icon name="check" size={14} />
                Save
              </button>
            </span>
          </div>
          <div className="dplace-row wplace-tools">
            {placeOn}
            {dateField}
            <button
              type="button"
              className="btn ghost sm"
              data-testid="walk-place-finetune"
              aria-pressed={fineTuning}
              disabled={st.step !== 'placed' && !fineTuning}
              title="Pin moments of the 360 video for a closer fit"
              onClick={() => {
                flow.fineTune(!fineTuning);
              }}
            >
              <Icon name="target" size={14} />
              Fine-tune
            </button>
            {placedBefore && (
              <button
                ref={removeRef}
                type="button"
                className="btn ghost sm"
                data-testid="walk-place-remove"
                aria-expanded={askRemove}
                aria-controls={askRemove ? askId : undefined}
                disabled={u.saving}
                onClick={() => {
                  setRemoveRefused(null);
                  setAskRemoveFor(walk.id);
                }}
              >
                Remove placement
              </button>
            )}
          </div>
        </>
      )}
      {askRemove && placedBefore && (
        <div
          id={askId}
          className="dplace-row wplace-ask"
          role="group"
          aria-label={SAY.removeAsk}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            closeAsk();
          }}
        >
          <p className="dplace-say wplace-hint">{SAY.removeAsk}</p>
          <span className="dplace-end">
            <button ref={keepRef} type="button" className="btn ghost sm" onClick={closeAsk}>
              Keep it
            </button>
            <button
              type="button"
              className="btn danger sm"
              data-testid="walk-place-remove-yes"
              onClick={() => {
                const id = walk.id;
                setAskRemoveFor(null);
                void flow.removePlacement(id).then((error) => {
                  if (error) setRemoveRefused({ id, error });
                });
              }}
            >
              Remove placement
            </button>
          </span>
        </div>
      )}
      {fineTuning && (
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
                {canRemovePin(st, k) && (
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
                )}
                <span className="sr-only">at {p.t.toFixed(1)} s</span>
              </span>
            );
          })}
          <button
            type="button"
            className="btn sm"
            data-testid="walk-place-pin-here"
            aria-pressed={st.armed === 'pin'}
            disabled={!enough || u.saving}
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
            disabled={!enough || u.saving}
            onClick={() => {
              session.getState().armAlign();
            }}
          >
            <Icon name="target" size={14} />
            Align view
          </button>
          <YawField session={session} st={st} text={yawText} setText={setYawText} />
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
      {pinsOnly && !checking && (
        <p className="wplace-note faint" data-testid="walk-place-pins-only">
          {SAY.pinsOnly}
        </p>
      )}
    </div>
  );
}

/** Fine-tune's heading offset: arrows step 1 degree, Shift 10. */
function YawField({
  session,
  st,
  text,
  setText,
}: {
  session: StoreApi<PlaceState>;
  st: PlaceState;
  text: string | null;
  setText: (v: string | null) => void;
}) {
  const yawKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const by = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
    session.getState().setYaw(session.getState().yawOffsetDeg + by);
    setText(null);
  };
  return (
    <label className="wplace-field wplace-yaw">
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
        disabled={st.pins.length < 2}
        value={text ?? String(Math.round(st.yawOffsetDeg * 10) / 10)}
        onKeyDown={yawKey}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(v)) session.getState().setYaw(v);
        }}
        onBlur={() => {
          setText(null);
        }}
      />
      <span className="faint">deg</span>
    </label>
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
    at !== 'walk' && host !== undefined && host !== null && surfaceId(host) === surfaceId(at);
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
 * being placed on this drawing its live path with the Start and End handles and the current
 * position, the shape under the pointer (the ghost before the start, the live line before the
 * end) and a pick for Start, End and the armed fine-tune click. No overlay when the drawing has
 * no frame (not placed, size unknown).
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
  const preview = useStore(placeSession, (s) => s.preview);
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
    () => (on && manifest ? surfaceFramesOf(manifest, (id) => placed[id]).drawing(layerId) : null),
    [on, manifest, placed, layerId],
  );
  // every placed walk a 360 pane shows has its Beam here (two while comparing), as the walk being
  // placed does; each reads its own pane, and only the shown walks' views render the drawing again
  const shownIds = useMemo(
    () => new Set(fits.map((w) => w.layer.id).filter((id) => id !== placingId && !hidden.has(id))),
    [fits, placingId, hidden],
  );
  const views = useWalkViewsAmong(shownIds);
  const placingView = useWalkView(on ? placingId : null);
  const nows = useMemo(() => {
    if (!manifest) return [];
    if (placing && frame) {
      const now = walkNowOnSheet(
        placing,
        frame,
        (l) => walkColour(manifest, l),
        time,
        size,
        placingView,
      );
      return now ? [now] : [];
    }
    return placedNowOnSheet(manifest, layerId, fits, (id) => placed[id], views, {
      except: placingId,
      hidden,
      size,
    });
  }, [
    manifest,
    placing,
    frame,
    time,
    size,
    placingView,
    layerId,
    fits,
    placed,
    views,
    placingId,
    hidden,
  ]);
  const shape = useMemo(
    () =>
      frame && preview ? previewOnSheet(preview.xz, frame, preview.ghost, preview.tooClose) : null,
    [frame, preview],
  );
  const pick = useMemo<RasterPick | undefined>(
    () =>
      on && clickable
        ? {
            onPick: (px) => {
              placeSession.getState().click(px);
            },
            onHover: (px) => {
              placeSession.getState().hover(px);
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
            nows={nows}
            preview={on ? shape : null}
            size={ctx.size}
            toImage={ctx.toImage}
            onPinDrag={(_id, i, px, role) => {
              if (role === 'pin') placeSession.getState().movePin(i, px);
              else placeSession.getState().dragHandle(role, px);
            }}
            onPinDragEnd={(_id, i, px, role) => {
              if (role === 'pin') placeSession.getState().movePin(i, px);
              placeSession.getState().endDrag();
            }}
          />
        )
      : undefined;
  return { on, pick, overlay };
}
