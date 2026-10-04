import type { ImageGeom } from '@aio/schema';
import { compareCodes } from '../model/query';
import { sourceKey, type Detection, type DetectionRun, type DetectionSource } from './model';

/*
 * The review state machine (BLD-5). Pure: a reducer over the project's detections with a queue
 * (filter by status and confidence, ordered by photo or frame, then top to bottom), a cursor,
 * keyboard-first accept / reject / next, and undo for edits.
 *
 * Status moves: draft to rejected (reject), rejected to draft (reopen), draft or rejected to
 * accepted (accepted, after the caller created or extended the issue). An accepted detection is
 * an issue now: it cannot be edited, removed or reopened here, and undo stops at it (undo the
 * issue in the register instead).
 */

export type QueueFilter = 'draft' | 'all' | 'accepted' | 'rejected';

export type DetectionPatch = Partial<
  Pick<Detection, 'geom' | 'classId' | 'severity' | 'uncertain' | 'note'>
>;

interface Change {
  label: string;
  before: Readonly<Record<string, Detection | null>>;
  after: Readonly<Record<string, Detection | null>>;
  /** An acceptance: undo cannot step back past it. */
  final?: boolean;
}

export interface ReviewState {
  detections: readonly Detection[];
  runs: readonly DetectionRun[];
  filter: QueueFilter;
  /** Proposals (AI, pipeline) under this confidence are hidden; a person's are always shown. */
  minConfidence: number;
  currentId: string | null;
  past: readonly Change[];
  future: readonly Change[];
  /** Bumped on every change of `detections` or `runs`: the saver writes when it moves. */
  revision: number;
  lastError: ReviewError | null;
}

export type ReviewAction =
  | { type: 'load'; detections: readonly Detection[]; runs?: readonly DetectionRun[] }
  | { type: 'filter'; filter: QueueFilter }
  | { type: 'minConfidence'; value: number }
  | { type: 'select'; id: string | null }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'nextSource' }
  | { type: 'prevSource' }
  /** New drafts (drawn by hand, or a model's or pipeline's results with their run). */
  | { type: 'add'; detections: readonly Detection[]; label: string; run?: DetectionRun }
  | { type: 'edit'; id: string; patch: DetectionPatch; now: string }
  | { type: 'remove'; id: string }
  | { type: 'reject'; id: string; by: string; now: string }
  /**
   * Back to draft. An accepted detection reopens only when its issue no longer exists
   * (`issueGone`: the issue was deleted or its creation undone in the register).
   */
  | { type: 'reopen'; id: string; now: string; issueGone?: boolean }
  | { type: 'accepted'; id: string; issueId: string; by: string; now: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'clearError' };

const HISTORY_LIMIT = 200;

/**
 * Why an action was refused; the app turns these into sentences (i18n).
 * - `accepted`: the detection is an issue now; change it in the issue register.
 * - `proposal`: proposals from a model or pipeline are rejected, not deleted.
 * - `undo-accepted`: undo cannot step back past an acceptance.
 * - `missing`: no such detection. `duplicate`: the id exists already.
 */
export type ReviewError = 'accepted' | 'proposal' | 'undo-accepted' | 'missing' | 'duplicate';

export function initialReview(): ReviewState {
  return {
    detections: [],
    runs: [],
    filter: 'draft',
    minConfidence: 0,
    currentId: null,
    past: [],
    future: [],
    revision: 0,
    lastError: null,
  };
}

// ---- queue ----

function sourceOrder(a: DetectionSource, b: DetectionSource): number {
  if (a.kind !== b.kind) return a.kind === 'photo' ? -1 : 1;
  const byLayer = a.layer.localeCompare(b.layer);
  if (byLayer !== 0) return byLayer;
  if (a.kind === 'photo' && b.kind === 'photo') return compareCodes(a.photo, b.photo);
  if (a.kind === 'frame' && b.kind === 'frame') return a.t - b.t;
  return 0;
}

function topLeft(g: ImageGeom): [number, number] {
  switch (g.type) {
    case 'box':
    case 'rotbox':
    case 'point':
      return [g.y, g.x];
    case 'polygon': {
      let y = Infinity;
      let x = Infinity;
      for (const [px, py] of g.points) {
        y = Math.min(y, py);
        x = Math.min(x, px);
      }
      return [y, x];
    }
    case 'mask':
      return [0, 0];
  }
}

/** Review order: by source (photos by name, frames by time), then top to bottom, left to right. */
export function compareDetections(a: Detection, b: Detection): number {
  const s = sourceOrder(a.source, b.source);
  if (s !== 0) return s;
  const [ay, ax] = topLeft(a.geom);
  const [by, bx] = topLeft(b.geom);
  return ay - by || ax - bx || a.id.localeCompare(b.id);
}

export function inQueue(d: Detection, filter: QueueFilter, minConfidence: number): boolean {
  if (filter !== 'all' && d.status !== filter) return false;
  if (d.origin.kind !== 'human' && d.confidence !== undefined && d.confidence < minConfidence) {
    return false;
  }
  return true;
}

const sorted = new WeakMap<readonly Detection[], readonly Detection[]>();

/** All detections in review order (cached per list). */
export function ordered(detections: readonly Detection[]): readonly Detection[] {
  let s = sorted.get(detections);
  if (!s) {
    s = [...detections].sort(compareDetections);
    sorted.set(detections, s);
  }
  return s;
}

/** The detections the reviewer steps through, in order. */
export function queueOf(
  state: Pick<ReviewState, 'detections' | 'filter' | 'minConfidence'>,
): Detection[] {
  return ordered(state.detections).filter((d) => inQueue(d, state.filter, state.minConfidence));
}

export function currentOf(state: ReviewState): Detection | null {
  return state.detections.find((d) => d.id === state.currentId) ?? null;
}

export interface SourceCounts {
  source: DetectionSource;
  key: string;
  draft: number;
  accepted: number;
  rejected: number;
}

/** Per photo or frame: how many detections wait, were accepted, were rejected (review order). */
export function sourceCounts(detections: readonly Detection[]): SourceCounts[] {
  const out = new Map<string, SourceCounts>();
  for (const d of ordered(detections)) {
    const key = sourceKey(d.source);
    let c = out.get(key);
    if (!c) {
      c = { source: d.source, key, draft: 0, accepted: 0, rejected: 0 };
      out.set(key, c);
    }
    c[d.status] += 1;
  }
  return [...out.values()];
}

// ---- reducer ----

function apply(list: readonly Detection[], after: Change['after']): Detection[] {
  const out: Detection[] = [];
  const seen = new Set<string>();
  for (const d of list) {
    if (!(d.id in after)) {
      out.push(d);
      continue;
    }
    seen.add(d.id);
    const next = after[d.id];
    if (next) out.push(next);
  }
  for (const [id, next] of Object.entries(after)) {
    if (!seen.has(id) && next) out.push(next);
  }
  return out;
}

/** After the current item leaves the queue: the next one after it, else the one before. */
function followOn(state: ReviewState, nextDetections: readonly Detection[]): string | null {
  const before = queueOf(state);
  const after = queueOf({ ...state, detections: nextDetections });
  const keep = new Set(after.map((d) => d.id));
  if (state.currentId && keep.has(state.currentId)) return state.currentId;
  const at = before.findIndex((d) => d.id === state.currentId);
  if (at >= 0) {
    for (let i = at + 1; i < before.length; i++) {
      const id = before[i]?.id;
      if (id && keep.has(id)) return id;
    }
    for (let i = at - 1; i >= 0; i--) {
      const id = before[i]?.id;
      if (id && keep.has(id)) return id;
    }
  }
  return after[0]?.id ?? null;
}

function commit(state: ReviewState, change: Change, currentId?: string | null): ReviewState {
  const detections = apply(state.detections, change.after);
  const cur = currentId === undefined ? followOn(state, detections) : currentId;
  return {
    ...state,
    detections,
    currentId: cur,
    past: [...state.past, change].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
    lastError: null,
  };
}

const fail = (state: ReviewState, error: ReviewError): ReviewState => ({
  ...state,
  lastError: error,
});

function step(state: ReviewState, dir: 1 | -1): ReviewState {
  const q = queueOf(state);
  if (q.length === 0) return { ...state, currentId: null };
  const at = q.findIndex((d) => d.id === state.currentId);
  const i = at < 0 ? (dir === 1 ? 0 : q.length - 1) : (at + dir + q.length) % q.length;
  return { ...state, currentId: q[i]?.id ?? null };
}

function stepSource(state: ReviewState, dir: 1 | -1): ReviewState {
  const q = queueOf(state);
  if (q.length === 0) return { ...state, currentId: null };
  const cur = q.find((d) => d.id === state.currentId);
  if (!cur) return { ...state, currentId: q[0]?.id ?? null };
  const key = sourceKey(cur.source);
  const keys: string[] = [];
  const first = new Map<string, string>();
  for (const d of q) {
    const k = sourceKey(d.source);
    if (!first.has(k)) {
      first.set(k, d.id);
      keys.push(k);
    }
  }
  const at = keys.indexOf(key);
  const next = keys[(at + dir + keys.length) % keys.length];
  return { ...state, currentId: (next && first.get(next)) ?? state.currentId };
}

function changeOne(
  state: ReviewState,
  id: string,
  label: string,
  fn: (d: Detection) => Detection | ReviewError,
  opts: { final?: boolean; keepCursor?: boolean } = {},
): ReviewState {
  const d = state.detections.find((x) => x.id === id);
  if (!d) return fail(state, 'missing');
  const next = fn(d);
  if (typeof next === 'string') return fail(state, next);
  const change: Change = {
    label,
    before: { [id]: d },
    after: { [id]: next },
    ...(opts.final ? { final: true } : {}),
  };
  return commit(state, change, opts.keepCursor ? state.currentId : undefined);
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'load': {
      const base: ReviewState = {
        ...initialReview(),
        filter: state.filter,
        minConfidence: state.minConfidence,
        detections: [...action.detections],
        runs: [...(action.runs ?? [])],
      };
      // reading the same passes again keeps the reviewer's place
      const q = queueOf(base);
      const keep = q.some((d) => d.id === state.currentId) ? state.currentId : null;
      return { ...base, currentId: keep ?? q[0]?.id ?? null };
    }
    case 'filter': {
      const next = { ...state, filter: action.filter };
      const q = queueOf(next);
      return {
        ...next,
        currentId: q.some((d) => d.id === state.currentId) ? state.currentId : (q[0]?.id ?? null),
      };
    }
    case 'minConfidence': {
      const next = { ...state, minConfidence: Math.min(1, Math.max(0, action.value)) };
      const q = queueOf(next);
      return {
        ...next,
        currentId: q.some((d) => d.id === state.currentId) ? state.currentId : (q[0]?.id ?? null),
      };
    }
    case 'select':
      return { ...state, currentId: action.id, lastError: null };
    case 'next':
      return step(state, 1);
    case 'prev':
      return step(state, -1);
    case 'nextSource':
      return stepSource(state, 1);
    case 'prevSource':
      return stepSource(state, -1);
    case 'add': {
      if (action.detections.length === 0 && !action.run) return state;
      const known = new Set(state.detections.map((d) => d.id));
      const after: Record<string, Detection> = {};
      for (const d of action.detections) {
        if (known.has(d.id) || d.id in after) return fail(state, 'duplicate');
        after[d.id] = { ...d, status: 'draft' };
      }
      const firstNew = action.detections[0]?.id ?? null;
      const committed = commit(
        state,
        {
          label: action.label,
          before: Object.fromEntries(Object.keys(after).map((k) => [k, null])),
          after,
        },
        // a hand-drawn shape becomes the current one; model results keep the reviewer's place
        action.run ? (state.currentId ?? firstNew) : firstNew,
      );
      return action.run ? { ...committed, runs: [...state.runs, action.run] } : committed;
    }
    case 'edit':
      return changeOne(
        state,
        action.id,
        'Edit detection',
        (d) => {
          if (d.status === 'accepted') return 'accepted' as const;
          const next: Detection = { ...d, ...action.patch, updatedAt: action.now };
          return next;
        },
        { keepCursor: true },
      );
    case 'remove': {
      const d = state.detections.find((x) => x.id === action.id);
      if (!d) return fail(state, 'missing');
      if (d.status === 'accepted') return fail(state, 'accepted' as const);
      if (d.origin.kind !== 'human') return fail(state, 'proposal');
      return commit(state, {
        label: 'Delete detection',
        before: { [d.id]: d },
        after: { [d.id]: null },
      });
    }
    case 'reject':
      return changeOne(state, action.id, 'Reject detection', (d) => {
        if (d.status === 'accepted') return 'accepted' as const;
        if (d.status === 'rejected') return d;
        return {
          ...d,
          status: 'rejected',
          reviewedBy: action.by,
          reviewedAt: action.now,
          updatedAt: action.now,
        };
      });
    case 'reopen':
      return changeOne(state, action.id, 'Reopen detection', (d) => {
        if (d.status === 'accepted' && !action.issueGone) return 'accepted' as const;
        if (d.status === 'draft') return d;
        const next: Detection = { ...d, status: 'draft', updatedAt: action.now };
        delete next.reviewedBy;
        delete next.reviewedAt;
        delete next.issueId;
        return next;
      });
    case 'accepted':
      return changeOne(
        state,
        action.id,
        'Accept detection',
        (d) => {
          if (d.status === 'accepted') return 'accepted' as const;
          return {
            ...d,
            status: 'accepted',
            issueId: action.issueId,
            reviewedBy: action.by,
            reviewedAt: action.now,
            updatedAt: action.now,
          };
        },
        { final: true },
      );
    case 'undo': {
      const c = state.past.at(-1);
      if (!c) return state;
      if (c.final) return fail(state, 'undo-accepted');
      const detections = apply(state.detections, c.before);
      const touched = Object.keys(c.before)[0] ?? null;
      return {
        ...state,
        detections,
        currentId: touched && detections.some((d) => d.id === touched) ? touched : state.currentId,
        past: state.past.slice(0, -1),
        future: [...state.future, c],
        revision: state.revision + 1,
        lastError: null,
      };
    }
    case 'redo': {
      const c = state.future.at(-1);
      if (!c) return state;
      const detections = apply(state.detections, c.after);
      return {
        ...state,
        detections,
        past: [...state.past, c],
        future: state.future.slice(0, -1),
        revision: state.revision + 1,
        lastError: null,
      };
    }
    case 'clearError':
      return { ...state, lastError: null };
  }
}

export const canUndo = (s: ReviewState) => s.past.length > 0 && !s.past.at(-1)?.final;
export const canRedo = (s: ReviewState) => s.future.length > 0;
