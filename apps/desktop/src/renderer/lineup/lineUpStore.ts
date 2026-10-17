import type {
  CaptureLineUp,
  Issue,
  LineUpMeasure,
  ProjectManifest,
  SurveyMeasurement,
} from '@aio/schema';
import { t } from '@aio/ui';
import { hintOnlyLayers, type CaptureHints, type Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { LineUpMemory } from './lineUpMemory';
import { formatMetres, movesWith, planLineUp } from './planLineUp';

/**
 * Line up dates: the step (measure two dates, choose the one that stays, save the other's
 * shift), the background offer, and the done notice with Undo and Redo. Writes only through the
 * deps: `builder:updateCapture` `{ lineUp }` and, for layers only the volume hints file under the
 * moved date, an explicit `capture` (Decision 2), undone with it.
 */

export interface LineUpDeps {
  workspace: StoreApi<Workspace>;
  /** Run `change.lineup` for the two dates: its `lineup.json`, or why there is none. */
  measure(keep: string, move: string): Promise<LineUpMeasure | { error: string }>;
  /** One `builder:updateCapture` `{ lineUp }` write (null removes it): an error or null. */
  saveCapture(captureId: string, lineUp: CaptureLineUp | null): Promise<string | null>;
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
}

export interface LineUpOfferState {
  projectId: string;
  key: string;
  measure: LineUpMeasure;
  text: string;
}

/** One write of Undo or Redo, and the write that takes it back again. */
export interface LineUpWrite {
  captureId: string;
  lineUp: CaptureLineUp | null;
  back: CaptureLineUp | null;
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
  open(a: string, b: string, then?: () => void): Promise<void>;
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

const labelOf = (m: ProjectManifest | undefined, id: string) =>
  m?.captures.find((c) => c.id === id)?.label ?? id;

/** The sentence for a measurement that cannot be saved; null for one that can. */
export function refusalOf(m: LineUpMeasure): string | null {
  switch (m.verdict) {
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
  }
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

  /** Write one Undo or Redo step: pins before the line-up, unpins after it. Null when done. */
  const write = async (w: LineUpWrite): Promise<string | null> => {
    if (w.pin && w.pins.length) {
      const err = await deps.pinCaptures(w.pins, w.captureId);
      if (err) return err;
    }
    const err = await deps.saveCapture(w.captureId, w.lineUp);
    if (err) return err;
    if (!w.pin && w.pins.length) return deps.pinCaptures(w.pins, null);
    return null;
  };

  const store = createStore<LineUpStore>()((set, get) => {
    const setDialog = (patch: Partial<LineUpDialogState>) => {
      const d = get().dialog;
      if (d) set({ dialog: { ...d, ...patch } });
    };
    return {
      dialog: null,
      offer: null,
      notice: null,
      open: async (a, b, then) => {
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
        let r: LineUpMeasure | { error: string };
        try {
          r = await deps.measure(a, b);
        } catch (e) {
          r = { error: errorText(e) };
        }
        // closed, opened for another pair, or another project meanwhile: not this answer's dialog
        if (get().dialog?.a !== a || get().dialog?.b !== b || openId() !== projectId) return;
        if ('error' in r)
          setDialog({ measuring: false, error: t('lineUp.failed', { error: r.error }) });
        else setDialog({ measuring: false, measure: r, error: refusalOf(r) });
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
        });
      },
      confirm: async () => {
        const d = get().dialog;
        const projectId = openId();
        const m = manifest();
        if (busy || !d?.keep || d.measure?.verdict !== 'ok' || !projectId || !m) return;
        busy = true;
        try {
          const plan = planLineUp(d.measure, d.keep, m, deps.now());
          const pins = hintOnlyLayers(m, deps.hints(), plan.moveId);
          const err = await write({
            captureId: plan.moveId,
            lineUp: plan.lineUp,
            back: plan.previous,
            pins,
            pin: true,
          });
          if (openId() !== projectId) return;
          if (err) {
            // the pins went in before a refused line-up: take them off again
            if (pins.length) await deps.pinCaptures(pins, null);
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
                  back: plan.lineUp,
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
        const previous = m?.captures.find((c) => c.id === captureId)?.lineUp;
        if (busy || !projectId || !m || !previous) return;
        busy = true;
        try {
          const err = await deps.saveCapture(captureId, null);
          if (openId() !== projectId) return;
          set({
            notice: {
              projectId,
              text: err ?? t('lineUp.removed', { moved: labelOf(m, captureId) }),
              action: err
                ? null
                : {
                    kind: 'undo',
                    write: { captureId, lineUp: previous, back: null, pins: [], pin: false },
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
          const err = await write(a.write);
          if (openId() !== n.projectId) return;
          const w = a.write;
          set({
            notice: err
              ? { projectId: n.projectId, text: err, action: a }
              : {
                  projectId: n.projectId,
                  text: t(a.kind === 'undo' ? 'lineUp.undone' : 'lineUp.redone'),
                  action: {
                    kind: a.kind === 'undo' ? 'redo' : 'undo',
                    write: { ...w, lineUp: w.back, back: w.lineUp, pin: !w.pin },
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
        if (!projectId || !man || m.verdict !== 'ok') return;
        set({
          offer: {
            projectId,
            key,
            measure: m,
            text: t('lineUp.offer', {
              moved: labelOf(man, m.move),
              kept: labelOf(man, m.keep),
              source: t(m.source === 'ortho' ? 'lineUp.source.ortho' : 'lineUp.source.dsm'),
              distance: formatMetres(m.totalM),
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
}>()(() => ({ store: null, preview: null }));
