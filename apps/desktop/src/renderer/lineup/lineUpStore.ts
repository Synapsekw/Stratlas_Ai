import type {
  CaptureLineUp,
  CaptureLineUpTurn,
  Issue,
  LineUpMeasure,
  ProjectManifest,
  SurveyMeasurement,
} from '@aio/schema';
import { t } from '@aio/ui';
import {
  captureShift,
  hintOnlyLayers,
  shiftKey,
  type CaptureHints,
  type Workspace,
} from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Box } from '../shell/layerBounds';
import type { LineUpMemory } from './lineUpMemory';
import { dateLabel, formatMetres, movesWith, planLineUp } from './planLineUp';

/**
 * Line up dates: the step (measure two dates, choose the one that stays, save the other's
 * shift, turn and scale), the background offer, and the done notice with Undo and Redo. Writes
 * only through the deps: `builder:updateCapture` `{ lineUp, lineUpTurn }` (always as a pair) and, for layers only the volume hints file under the
 * moved date, an explicit `capture` (Decision 2), undone with it.
 */

export interface LineUpDeps {
  workspace: StoreApi<Workspace>;
  /**
   * Run `change.lineup` for the two dates: its `lineup.json`, or why there is none. Aborting
   * `signal` gives the measurement up: its job is cancelled and the answer is an `{ error }`.
   */
  measure(
    keep: string,
    move: string,
    signal?: AbortSignal,
  ): Promise<LineUpMeasure | { error: string }>;
  /**
   * One `builder:updateCapture` `{ lineUp, lineUpTurn }` write, always the pair (a null turn is a
   * plain shift; a null `lineUp` removes both): an error or null.
   */
  saveCapture(
    captureId: string,
    lineUp: CaptureLineUp | null,
    lineUpTurn: CaptureLineUpTurn | null,
  ): Promise<string | null>;
  /** File layers under a date (null: take the own `capture` off again): an error or null. */
  pinCaptures(layerIds: readonly string[], captureId: string | null): Promise<string | null>;
  hints(): CaptureHints;
  issues(): readonly Issue[];
  measurements(): readonly SurveyMeasurement[];
  memory: LineUpMemory;
  now(): string;
}

export interface LineUpDialogState {
  a: string;
  b: string;
  /** The date that stays; none until the person chooses (call 2). */
  keep: string | null;
  measuring: boolean;
  measure: LineUpMeasure | null;
  /** Why it cannot be lined up: a refusal or a failed measurement. */
  error: string | null;
  /** What moves with the date that is not kept, once one is chosen. */
  moves: { layers: number; items: number } | null;
  /** Run after a saved line-up (the Changes panel runs the refused change again). */
  then?: () => void;
  /** Both dates' shifts when the measurement was taken (`shiftsOf`): a change measures again. */
  shifts?: string;
}

export interface LineUpOfferState {
  projectId: string;
  key: string;
  measure: LineUpMeasure;
  text: string;
  /** Both dates' shifts when it was measured (`shiftsOf`). */
  shifts: string;
}

/** One write of Undo or Redo, and the write that takes it back again. */
export interface LineUpWrite {
  captureId: string;
  lineUp: CaptureLineUp | null;
  /** The turn written with `lineUp` (null: none). */
  turn: CaptureLineUpTurn | null;
  back: CaptureLineUp | null;
  /** The turn written with `back`. */
  backTurn: CaptureLineUpTurn | null;
  /** Layers filed under the date for this line-up (hint-only), and whether this write files them. */
  pins: string[];
  pin: boolean;
}

export interface LineUpNoticeState {
  /** The project it was raised for: another project takes it away, and its Undo writes nothing. */
  projectId: string;
  text: string;
  action: { kind: 'undo' | 'redo'; write: LineUpWrite } | null;
}

export interface LineUpStore {
  dialog: LineUpDialogState | null;
  offer: LineUpOfferState | null;
  notice: LineUpNoticeState | null;
  /** Open the step for two dates and measure them. */
  open(a: string, b: string, then?: () => void, opts?: { keep?: string }): Promise<void>;
  choose(keepId: string): void;
  /** Save the line-up of the date not kept. */
  confirm(): Promise<void>;
  /** Close the step without saving. */
  close(): void;
  /** Take a date's line-up off, with Undo. */
  remove(captureId: string): Promise<void>;
  /** The notice's Undo or Redo. */
  apply(): Promise<void>;
  dismiss(): void;
  /** Offer the step for a measured pair (background check). */
  offerFrom(m: LineUpMeasure, key: string): void;
  acceptOffer(): Promise<void>;
  notNow(): void;
}

// no dedicated string for a thrown write: the error's own text, else the generic one
const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : t('library.failed');

const labelOf = (m: ProjectManifest | undefined, id: string) => dateLabel(m?.captures, id);

/** The measurement's verdict: the fit's when `lineup-fit.json` came with it (it may say `range`). */
export function verdictOf(m: LineUpMeasure): NonNullable<LineUpMeasure['fit']>['verdict'] {
  return m.fit?.verdict ?? m.verdict;
}

/** The sentence for a measurement that cannot be saved; null for one that can. */
export function refusalOf(m: LineUpMeasure): string | null {
  switch (verdictOf(m)) {
    case 'ok':
      return null;
    case 'aligned':
      return t('lineUp.refuse.aligned', { distance: formatMetres(m.tolerancePx * m.cellM) });
    case 'texture':
      return t('lineUp.refuse.texture');
    case 'disagree':
      return t('lineUp.refuse.disagree');
    case 'overlap':
      return t('lineUp.refuse.overlap');
    case 'range':
      return t('lineUp.refuse.range');
  }
}

/** Both dates' shifts as one key, to the millimetre: a measurement holds while it is unchanged. */
function shiftsOf(m: ProjectManifest, a: string, b: string): string {
  return `${shiftKey(captureShift(m, a))};${shiftKey(captureShift(m, b))}`;
}

/** Why the step cannot save with this measurement and this choice; null when it can. */
function blockOf(m: ProjectManifest, measure: LineUpMeasure, keep: string | null): string | null {
  const refused = refusalOf(measure);
  if (refused || keep === null) return refused;
  return planLineUp(measure, keep, m, new Date(0).toISOString()).inRange
    ? null
    : t('lineUp.refuse.far');
}

/** The manifest as it will be once these layers carry `captureId` of their own. */
function withPins(m: ProjectManifest, pins: readonly string[], captureId: string): ProjectManifest {
  if (pins.length === 0) return m;
  return {
    ...m,
    layers: m.layers.map((l) => (pins.includes(l.id) ? { ...l, capture: captureId } : l)),
  };
}

export function createLineUpStore(deps: LineUpDeps): StoreApi<LineUpStore> {
  // one run at a time: a double click or a key held down must not save twice
  let busy = false;
  const openId = () => deps.workspace.getState().project?.id ?? null;
  const manifest = () => deps.workspace.getState().project?.manifest;

  /**
   * Write one line-up, Undo or Redo step into `projectId`: pins before the line-up, unpins after
   * it. A refused save takes the pins it put in off again. `stopped` when another project opened
   * between two writes: nothing more is written, into either project.
   */
  const write = async (
    projectId: string,
    w: LineUpWrite,
  ): Promise<{ err: string | null; stopped: boolean }> => {
    const gone = () => openId() !== projectId;
    const pinning = w.pin && w.pins.length > 0;
    if (pinning) {
      const err = await deps.pinCaptures(w.pins, w.captureId);
      if (gone()) return { err: null, stopped: true };
      if (err) return { err, stopped: false };
    }
    const err = await deps.saveCapture(w.captureId, w.lineUp, w.turn);
    if (gone()) return { err: null, stopped: true };
    if (err) {
      if (pinning) await deps.pinCaptures(w.pins, null);
      return { err, stopped: gone() };
    }
    if (!w.pin && w.pins.length) {
      const unpinned = await deps.pinCaptures(w.pins, null);
      return { err: unpinned, stopped: gone() };
    }
    return { err: null, stopped: false };
  };

  const store = createStore<LineUpStore>()((set, get) => {
    const setDialog = (patch: Partial<LineUpDialogState>) => {
      const d = get().dialog;
      if (d) set({ dialog: { ...d, ...patch } });
    };
    /** Measure the dialog's dates as they are placed now and show the answer. */
    const measureInto = async (projectId: string, a: string, b: string) => {
      const m = manifest();
      if (!m) return;
      setDialog({ measuring: true, measure: null, error: null, shifts: shiftsOf(m, a, b) });
      let r: LineUpMeasure | { error: string };
      try {
        r = await deps.measure(a, b);
      } catch (e) {
        r = { error: errorText(e) };
      }
      // closed, opened for another pair, or another project meanwhile: not this answer's dialog
      const d = get().dialog;
      const now = manifest();
      if (d?.a !== a || d.b !== b || openId() !== projectId || !now) return;
      if ('error' in r)
        setDialog({ measuring: false, error: t('lineUp.failed', { error: r.error }) });
      else setDialog({ measuring: false, measure: r, error: blockOf(now, r, d.keep) });
    };
    return {
      dialog: null,
      offer: null,
      notice: null,
      open: async (a, b, then, opts) => {
        const projectId = openId();
        if (!projectId || a === b) return;
        const dialog: LineUpDialogState = {
          a,
          b,
          keep: null,
          measuring: true,
          measure: null,
          error: null,
          moves: null,
          ...(then ? { then } : {}),
        };
        set({ dialog });
        // the Compare dates chip chooses its left-hand date; the person can still switch
        if (opts?.keep) get().choose(opts.keep);
        await measureInto(projectId, a, b);
      },
      choose: (keepId) => {
        const d = get().dialog;
        const m = manifest();
        if (!d || !m || (keepId !== d.a && keepId !== d.b)) return;
        const moveId = keepId === d.a ? d.b : d.a;
        const pins = hintOnlyLayers(m, deps.hints(), moveId);
        setDialog({
          keep: keepId,
          moves: movesWith(withPins(m, pins, moveId), moveId, deps.issues(), deps.measurements()),
          ...(d.measure ? { error: blockOf(m, d.measure, keepId) } : {}),
        });
      },
      confirm: async () => {
        const d = get().dialog;
        const projectId = openId();
        const m = manifest();
        if (busy || !d?.keep || !d.measure || verdictOf(d.measure) !== 'ok' || !projectId || !m)
          return;
        busy = true;
        try {
          // a date moved since the measurement (Undo, another line-up): its answer is stale
          if (d.shifts !== shiftsOf(m, d.a, d.b)) {
            await measureInto(projectId, d.a, d.b);
            return;
          }
          const plan = planLineUp(d.measure, d.keep, m, deps.now());
          if (!plan.inRange) {
            setDialog({ error: t('lineUp.refuse.far') });
            return;
          }
          const pins = hintOnlyLayers(m, deps.hints(), plan.moveId);
          const { err, stopped } = await write(projectId, {
            captureId: plan.moveId,
            lineUp: plan.lineUp,
            turn: plan.lineUpTurn,
            back: plan.previous,
            backTurn: plan.previousTurn,
            pins,
            pin: true,
          });
          if (stopped || openId() !== projectId) return;
          if (err) {
            setDialog({ error: err });
            return;
          }
          set({
            dialog: null,
            notice: {
              projectId,
              text: t('lineUp.done', {
                moved: labelOf(m, plan.moveId),
                kept: labelOf(m, d.keep),
                distance: formatMetres(plan.totalM),
              }),
              action: {
                kind: 'undo',
                write: {
                  captureId: plan.moveId,
                  lineUp: plan.previous,
                  turn: plan.previousTurn,
                  back: plan.lineUp,
                  backTurn: plan.lineUpTurn,
                  pins,
                  pin: false,
                },
              },
            },
          });
          d.then?.();
        } catch (e) {
          setDialog({ error: errorText(e) });
        } finally {
          busy = false;
        }
      },
      close: () => {
        set({ dialog: null });
      },
      remove: async (captureId) => {
        const projectId = openId();
        const m = manifest();
        const capture = m?.captures.find((c) => c.id === captureId);
        const previous = capture?.lineUp;
        if (busy || !projectId || !m || !previous) return;
        const previousTurn = capture.lineUpTurn ?? null;
        busy = true;
        try {
          const err = await deps.saveCapture(captureId, null, null);
          if (openId() !== projectId) return;
          set({
            notice: {
              projectId,
              text: err ?? t('lineUp.removed', { moved: labelOf(m, captureId) }),
              action: err
                ? null
                : {
                    kind: 'undo',
                    write: {
                      captureId,
                      lineUp: previous,
                      turn: previousTurn,
                      back: null,
                      backTurn: null,
                      pins: [],
                      pin: false,
                    },
                  },
            },
          });
        } catch (e) {
          set({ notice: { projectId, text: errorText(e), action: null } });
        } finally {
          busy = false;
        }
      },
      apply: async () => {
        const n = get().notice;
        const a = n?.action;
        if (!n || !a || busy) return;
        // the write names another project's date: never put it into this one
        if (n.projectId !== openId()) {
          set({ notice: null });
          return;
        }
        busy = true;
        try {
          const { err, stopped } = await write(n.projectId, a.write);
          if (stopped || openId() !== n.projectId) return;
          const w = a.write;
          set({
            notice: err
              ? { projectId: n.projectId, text: err, action: a }
              : {
                  projectId: n.projectId,
                  text: t(a.kind === 'undo' ? 'lineUp.undone' : 'lineUp.redone'),
                  action: {
                    kind: a.kind === 'undo' ? 'redo' : 'undo',
                    write: {
                      ...w,
                      lineUp: w.back,
                      turn: w.backTurn,
                      back: w.lineUp,
                      backTurn: w.turn,
                      pin: !w.pin,
                    },
                  },
                },
          });
        } catch (e) {
          set({ notice: { projectId: n.projectId, text: errorText(e), action: a } });
        } finally {
          busy = false;
        }
      },
      dismiss: () => {
        set({ notice: null });
      },
      offerFrom: (m, key) => {
        const projectId = openId();
        const man = manifest();
        if (!projectId || !man || verdictOf(m) !== 'ok') return;
        set({
          offer: {
            projectId,
            key,
            measure: m,
            shifts: shiftsOf(man, m.keep, m.move),
            text: t('lineUp.offer', {
              moved: labelOf(man, m.move),
              kept: labelOf(man, m.keep),
              source: t(m.source === 'ortho' ? 'lineUp.source.ortho' : 'lineUp.source.dsm'),
              distance: formatMetres(m.fit?.maxMoveM ?? m.totalM),
            }),
          },
        });
      },
      acceptOffer: () => {
        const o = get().offer;
        if (!o) return Promise.resolve();
        if (o.projectId !== openId()) {
          set({ offer: null });
          return Promise.resolve();
        }
        // measured a moment ago: the step opens with that answer, no second run
        set({
          offer: null,
          dialog: {
            a: o.measure.keep,
            b: o.measure.move,
            keep: null,
            measuring: false,
            measure: o.measure,
            error: refusalOf(o.measure),
            moves: null,
            shifts: o.shifts,
          },
        });
        return Promise.resolve();
      },
      notNow: () => {
        const o = get().offer;
        if (o) deps.memory.notNow(o.projectId, o.key);
        set({ offer: null });
      },
    };
  });
  // the step, the offer and the notice belong to the project they were raised for
  deps.workspace.subscribe((s, prev) => {
    if (s.project?.id === prev.project?.id) return;
    const id = s.project?.id ?? null;
    const { notice, offer, dialog } = store.getState();
    if (notice && notice.projectId !== id) store.setState({ notice: null });
    if (offer && offer.projectId !== id) store.setState({ offer: null });
    if (dialog) store.setState({ dialog: null });
  });
  return store;
}

/** An ortho's overview as the preview draws it: the image and its box on the ground, as placed now. */
export interface LineUpImage {
  image: CanvasImageSource;
  /** Local frame, metres (x east, z south). */
  box: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** The overview of a layer for the preview, or null when there is none to draw. */
export type LineUpPreview = (layerId: string) => Promise<LineUpImage | null>;

/**
 * The app's line-up step, once the session has made it (`lineUpSession.ts`): the dialog, the
 * offer and the notice mounted in the shell read it, and show nothing until it is set.
 */
export const lineUpApp = createStore<{
  store: StoreApi<LineUpStore> | null;
  preview: LineUpPreview | null;
  /** Each layer's box in the local frame, as placed now (the date menu picks a partner by it). */
  extents: (() => Promise<Record<string, Box>>) | null;
}>()(() => ({ store: null, preview: null, extents: null }));
