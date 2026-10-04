/**
 * Detection review state for the open project (BLD-5): the pure review reducer from
 * `@aio/annotate/detections`, loaded from and saved to `detections.json` through main, and the
 * acceptance step that turns a detection into an issue through the app's issue editor (validated,
 * saved, undoable in the register like any other issue change).
 */
import { issueEditor } from '@aio/annotate';
import {
  currentOf,
  initialReview,
  newIssueInput,
  parseDetectionsFile,
  reviewReducer,
  sightingOf,
  toDetectionsFile,
  type AcceptProblem,
  type ReviewAction,
  type ReviewState,
} from '@aio/annotate/detections';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { authorName } from '../author';
import { bridge } from '../shell';

export type DetectionSaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface DetectionStore {
  projectId: string | null;
  loading: boolean;
  loadError: string | null;
  /** A package: the review shows but nothing is saved or accepted. */
  readOnly: boolean;
  review: ReviewState;
  save: { state: DetectionSaveState; error?: string };
  /** Why the last accept was refused (the inspector names the missing field). */
  problem: AcceptProblem | null;
  /** The issue editor's error for the last accept (validation, read-only package). */
  issueError: string | null;
}

export const detections = createStore<DetectionStore>()(() => ({
  projectId: null,
  loading: false,
  loadError: null,
  readOnly: false,
  review: initialReview(),
  save: { state: 'saved' },
  problem: null,
  issueError: null,
}));

export function useDetections<T>(selector: (s: DetectionStore) => T): T {
  return useStore(detections, selector);
}

const SAVE_DELAY_MS = 500;
let timer: ReturnType<typeof setTimeout> | null = null;
let savedRevision = 0;
let writing: Promise<void> | null = null;

async function write(): Promise<void> {
  const s = detections.getState();
  if (!s.projectId || s.readOnly) return;
  const revision = s.review.revision;
  detections.setState({ save: { state: 'saving' } });
  const r = await bridge.call('detections:write', {
    projectId: s.projectId,
    file: { ...toDetectionsFile(s.review.detections, s.review.runs) },
  });
  const error = !r.ok ? r.error : r.value.ok ? undefined : (r.value.error ?? 'unknown error');
  if (detections.getState().projectId !== s.projectId) return;
  if (error) {
    detections.setState({ save: { state: 'error', error } });
    return;
  }
  savedRevision = revision;
  const latest = detections.getState().review.revision;
  detections.setState({ save: { state: latest === revision ? 'saved' : 'pending' } });
  if (latest !== revision) schedule();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    writing = (writing ?? Promise.resolve()).then(write);
  }, SAVE_DELAY_MS);
}

/** Write pending changes now (before closing the project or leaving the screen). */
export async function flushDetections(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    writing = (writing ?? Promise.resolve()).then(write);
  }
  await writing;
}

export function dispatch(action: ReviewAction): void {
  const s = detections.getState();
  const review = reviewReducer(s.review, action);
  if (review === s.review) return;
  const changed = review.revision !== s.review.revision;
  detections.setState({
    review,
    ...(changed ? { problem: null, issueError: null } : {}),
    ...(changed && !s.readOnly ? { save: { state: 'pending' } } : {}),
  });
  if (changed && !s.readOnly) schedule();
}

/** Read the review of a project (once per project; `force` reloads). */
export async function loadDetections(projectId: string, force = false): Promise<void> {
  const s = detections.getState();
  if (!force && s.projectId === projectId && (s.loading || !s.loadError)) return;
  await flushDetections();
  detections.setState({
    projectId,
    loading: true,
    loadError: null,
    readOnly: false,
    review: reviewReducer(s.review, { type: 'load', detections: [] }),
    save: { state: 'saved' },
    problem: null,
    issueError: null,
  });
  const r = await bridge.call('detections:read', { projectId });
  if (detections.getState().projectId !== projectId) return;
  if (!r.ok || !r.value.ok) {
    detections.setState({
      loading: false,
      loadError: !r.ok ? r.error : r.value.ok ? null : r.value.error,
    });
    return;
  }
  const parsed = r.value.file ? parseDetectionsFile(r.value.file) : null;
  if (parsed && !parsed.ok) {
    detections.setState({ loading: false, loadError: parsed.error });
    return;
  }
  const review = reviewReducer(detections.getState().review, {
    type: 'load',
    detections: parsed?.value.detections ?? [],
    runs: parsed?.value.runs ?? [],
  });
  savedRevision = review.revision;
  detections.setState({ loading: false, readOnly: r.value.readOnly, review });
}

/** Forget the review when the project closes. */
workspace.subscribe((ws, prev) => {
  const id = ws.project?.id ?? null;
  if (id === (prev.project?.id ?? null)) return;
  void flushDetections().then(() => {
    if (id === null) {
      detections.setState({
        projectId: null,
        loading: false,
        loadError: null,
        readOnly: false,
        review: initialReview(),
        save: { state: 'saved' },
      });
    }
  });
});

export type AcceptMode = { kind: 'new' } | { kind: 'link'; issueId: string };

/**
 * Accept the current detection: create a draft issue from it, or add it as a sighting of an
 * existing issue. Only after the issue editor took the change is the detection marked accepted.
 */
export function acceptCurrent(mode: AcceptMode): { ok: true; issueId: string } | { ok: false } {
  const s = detections.getState();
  const d = currentOf(s.review);
  if (!d || s.readOnly || d.status === 'accepted') return { ok: false };
  const now = new Date().toISOString();
  if (mode.kind === 'new') {
    const input = newIssueInput(d, issueEditor.context());
    if (!input.ok) {
      detections.setState({ problem: input.error, issueError: null });
      return { ok: false };
    }
    const created = issueEditor.create(input.value);
    if (!created.ok) {
      detections.setState({ problem: null, issueError: created.error });
      return { ok: false };
    }
    dispatch({
      type: 'accepted',
      id: d.id,
      issueId: created.value.id,
      by: authorName() || 'user',
      now,
    });
    return { ok: true, issueId: created.value.id };
  }
  const sighting = sightingOf(d);
  if (!sighting.ok) {
    detections.setState({ problem: sighting.error as AcceptProblem, issueError: null });
    return { ok: false };
  }
  const added = issueEditor.addSighting(mode.issueId, sighting.value);
  if (!added.ok) {
    detections.setState({ problem: null, issueError: added.error });
    return { ok: false };
  }
  dispatch({ type: 'accepted', id: d.id, issueId: mode.issueId, by: authorName() || 'user', now });
  return { ok: true, issueId: mode.issueId };
}

/** Test hook: the revision the last successful save wrote. */
export const savedRevisionForTests = () => savedRevision;
