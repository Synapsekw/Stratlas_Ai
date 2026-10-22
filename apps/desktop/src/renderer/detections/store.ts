/**
 * Detection review state for the open project (BLD-5): the pure review reducer from
 * `@aio/annotate/detections` over every detection pass of the project
 * (`<project>/detections/*.json`, `aio.detections/1`, data-conventions section 11). Each change is
 * written back into the pass it came from (atomic, with a `.bak`); drawings go to `review.json`,
 * each AI run to `ai-<run>.json`. Detections the inspection pipeline already turned into issues
 * show as accepted and are never changed. Acceptance runs through the app's issue editor
 * (validated, saved, undoable in the register like any other issue change).
 */
import { issueEditor, rememberImageSize } from '@aio/annotate';
import {
  acceptMany,
  currentOf,
  initialReview,
  newIssueInput,
  readPasses,
  REVIEW_PASS,
  reviewReducer,
  sightingOf,
  sourceKey,
  writePass,
  type AcceptProblem,
  type Detection,
  type DetectionRun,
  type PassRecord,
  type ReviewAction,
  type ReviewState,
} from '@aio/annotate/detections';
import type { DetectionsFile, ProjectManifest } from '@aio/schema';
import { t } from '@aio/ui';
import { assetUrl, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { authorName } from '../author';
import { beforeJobStart } from '../bridge';
import { offerPlacement } from '../placement';
import { bridge } from '../shell';
import { acceptLabel, planBatch, rejectLabel, undoStep, type BatchPlan } from './batch';
import {
  logMiss,
  logReview,
  missPassesFrom,
  type LedgerCtx,
  type MissPass,
} from './detectors/ledgerLog';

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
  /** Files in detections/ the review cannot read, left as they are. */
  problems: { name: string; error: string }[];
  /** Detections the review cannot show (contact sheet boxes, photos it cannot find). */
  hidden: number;
  /** The frame times (seconds, in order) the passes sampled, by walk layer (`sampledTimes`). */
  sampled: Readonly<Record<string, readonly number[]>>;
}

const initial = (): Omit<DetectionStore, 'projectId'> => ({
  loading: false,
  loadError: null,
  readOnly: false,
  review: initialReview(),
  save: { state: 'saved' },
  problem: null,
  issueError: null,
  problems: [],
  hidden: 0,
  sampled: {},
});

export const detections = createStore<DetectionStore>()(() => ({ projectId: null, ...initial() }));

export function useDetections<T>(selector: (s: DetectionStore) => T): T {
  return useStore(detections, selector);
}

// ---- pass files, as last read or written (not React state) ----

/** Pass name to its record (header and raw entries). */
const passes = new Map<string, PassRecord>();
/** Each detection as last read or written: unchanged ones are written back byte for byte. */
const saved = new Map<string, Detection>();
/** Pass name to the ids it held when last read or written. */
const savedIds = new Map<string, string[]>();
/** Passes whose run block is on disk. */
const savedRuns = new Set<string>();
/** Photos an AI pass looked at (its `assessed`), set when the run starts. */
const assessedOf = new Map<string, string[]>();
/** Pixel size of the images shown in the editor (normalized passes are scaled with it). */
const imageSizes = new Map<string, [number, number]>();

export function noteImageSize(key: string, size: [number, number]): void {
  imageSizes.set(key, size);
}

/** The photos an AI pass is sent (written as the pass's `assessed`). */
export function noteAssessed(pass: string, photos: readonly string[]): void {
  assessedOf.set(pass, [...photos]);
}

function headerFor(name: string, review: ReviewState): PassRecord['header'] {
  const known = passes.get(name)?.header;
  if (known) return known;
  const now = new Date().toISOString();
  if (name === REVIEW_PASS) {
    const author = authorName();
    return {
      schema: 'aio.detections/1',
      source: 'human',
      ...(author ? { producer: author } : {}),
      createdAt: now,
    };
  }
  const run = review.runs.find((r) => r.pass === name);
  const assessed = assessedOf.get(name);
  return {
    schema: 'aio.detections/1',
    source: 'ai',
    ...(run?.provider || run?.model
      ? { producer: [run.provider, run.model].filter(Boolean).join(' ') }
      : {}),
    createdAt: run?.at ?? now,
    ...(assessed?.length ? { assessed } : {}),
  };
}

/** Passes whose detections or run changed since they were last read or written. */
function dirtyPasses(review: ReviewState): string[] {
  const now = new Map<string, Detection[]>();
  for (const d of review.detections) now.set(d.pass, [...(now.get(d.pass) ?? []), d]);
  const names = new Set([...now.keys(), ...savedIds.keys()]);
  for (const r of review.runs) names.add(r.pass);
  const out: string[] = [];
  for (const name of names) {
    const list = now.get(name) ?? [];
    const before = savedIds.get(name) ?? [];
    const changed =
      list.length !== before.length ||
      list.some((d, i) => before[i] !== d.id || saved.get(d.id) !== d) ||
      review.runs.some((r) => r.pass === name && !savedRuns.has(name));
    if (changed) out.push(name);
  }
  return out;
}

/** A run as written in its pass (without the review's pass name). */
function runOf(r: DetectionRun): NonNullable<DetectionsFile['run']> {
  const out: Partial<DetectionRun> = { ...r };
  delete out.pass;
  return out as NonNullable<DetectionsFile['run']>;
}

const SAVE_DELAY_MS = 500;
let timer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> | null = null;

async function writeOne(
  projectId: string,
  name: string,
  review: ReviewState,
): Promise<string | null> {
  const rec: PassRecord = passes.get(name) ?? {
    name,
    header: headerFor(name, review),
    entries: [],
  };
  const runWithPass = review.runs.find((r) => r.pass === name);
  const run = runWithPass ? runOf(runWithPass) : undefined;
  const file = writePass(rec, review.detections, saved, run);
  const r = await bridge.call('detections:write', { projectId, name, file });
  const error = !r.ok ? r.error : r.value.ok ? null : (r.value.error ?? 'unknown error');
  if (error) return error;
  // what is on disk now
  const mine = review.detections.filter((d) => d.pass === name);
  const hiddenEntries = rec.entries.filter((e) => !e.reviewable);
  passes.set(name, {
    name,
    header: { ...rec.header, ...(run ? { run } : {}) },
    entries: [
      ...mine.map((d, i) => {
        const raw = file.detections[i] ?? file.detections[0];
        if (!raw) throw new Error('unreachable');
        return { id: d.id, raw, reviewable: true, hadId: raw.id !== undefined };
      }),
      ...hiddenEntries,
    ],
  });
  for (const id of savedIds.get(name) ?? []) saved.delete(id);
  for (const d of mine) saved.set(d.id, d);
  savedIds.set(
    name,
    mine.map((d) => d.id),
  );
  if (run) savedRuns.add(name);
  return null;
}

async function write(): Promise<void> {
  const s = detections.getState();
  if (!s.projectId || s.readOnly) return;
  const review = s.review;
  const names = dirtyPasses(review);
  if (names.length === 0) {
    detections.setState({ save: { state: 'saved' } });
    return;
  }
  detections.setState({ save: { state: 'saving' } });
  for (const name of names) {
    const error = await writeOne(s.projectId, name, review);
    if (detections.getState().projectId !== s.projectId) return;
    if (error) {
      detections.setState({ save: { state: 'error', error } });
      return;
    }
  }
  const latest = detections.getState().review;
  const more = latest !== review && dirtyPasses(latest).length > 0;
  detections.setState({ save: { state: more ? 'pending' : 'saved' } });
  if (more) schedule();
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

/**
 * A pipeline reads the pass files from disk (the inspection run counts the accepted detections):
 * write the pending review changes before any job starts. When an earlier write failed, nothing
 * is waiting any more, so the changed passes are written once more here; the job starts when that
 * write succeeds (and "Not saved" clears). Only a write that fails now stops the start, with the
 * review's own "Not saved" status still up. A failed save with no project to write to (closed, or
 * a read-only package) holds no job back.
 */
beforeJobStart(async () => {
  const s = detections.getState();
  if (s.save.state === 'error') {
    if (!s.projectId || s.readOnly) return null;
    if (!timer) writing = (writing ?? Promise.resolve()).then(write);
  }
  await flushDetections();
  const { state, error } = detections.getState().save;
  return state === 'error' ? t('jobs.unsaved.detections', { error: error ?? '' }).trim() : null;
});

/** The photo the review shows for a detection (the same URL the editor loads), or null. */
function ledgerCtx(projectId: string, d: Detection): LedgerCtx {
  const layer = d.source.layer;
  let photoUrl: string | null = null;
  try {
    const l = workspace.getState().project?.manifest.layers.find((x) => x.id === layer);
    const p =
      d.source.kind === 'photo' && l?.kind === 'photos'
        ? l.items.find((x) => x.id === (d.source as { photo: string }).photo)
        : undefined;
    if (p) photoUrl = assetUrl(projectId, p.src);
  } catch {
    // no URL: the ledger logs the reason and the review goes on
  }
  return { projectId, layer, photoUrl };
}

/** The headers of the passes as last read or written (the run, the detectors, when). */
export function passHeaders(): ReadonlyMap<string, PassRecord['header']> {
  return new Map([...passes].map(([name, rec]) => [name, rec.header]));
}

/** The local-detector passes (`vlm-*`) of the review, with the photos and detectors of each. */
function missPasses(review: ReviewState): MissPass[] {
  return missPassesFrom(
    review.detections,
    new Map([...passes].map(([name, rec]) => [name, rec.header])),
  );
}

/** Decisions on local-detector drafts, and hand-drawn findings, go to the detector ledger. */
function logDecisions(action: ReviewAction, before: ReviewState, after: ReviewState): void {
  const projectId = detections.getState().projectId;
  if (!projectId) return;
  const was = new Map(before.detections.map((d) => [d.id, d]));
  const now = new Map(after.detections.map((d) => [d.id, d]));
  const verdicts: [string, 'accepted' | 'rejected'][] = [];
  switch (action.type) {
    case 'accepted':
      verdicts.push([action.id, 'accepted']);
      break;
    case 'acceptedMany':
      for (const i of action.items) verdicts.push([i.id, 'accepted']);
      break;
    case 'reject':
      verdicts.push([action.id, 'rejected']);
      break;
    case 'rejectMany':
      for (const id of action.ids) verdicts.push([id, 'rejected']);
      break;
    case 'add': {
      const found = missPasses(after);
      for (const d of action.detections) {
        const added = now.get(d.id);
        if (added) void logMiss(added, found, ledgerCtx(projectId, added));
      }
      return;
    }
    case 'edit': {
      // relabelled to another class, a hand-drawn finding may be one a detector missed
      const edited = now.get(action.id);
      if (
        action.patch.classId !== undefined &&
        edited &&
        was.get(action.id)?.classId !== edited.classId
      )
        void logMiss(edited, missPasses(after), ledgerCtx(projectId, edited));
      return;
    }
    default:
      return;
  }
  for (const [id, verdict] of verdicts) {
    const d = now.get(id);
    // a rejected draft can be accepted from the inspector: the status changing to the verdict counts
    if (d?.status === verdict && was.get(id)?.status !== verdict)
      void logReview(d, verdict, ledgerCtx(projectId, d));
  }
}

export function dispatch(action: ReviewAction): void {
  const s = detections.getState();
  const review = reviewReducer(s.review, action);
  if (review === s.review) return;
  if (!s.readOnly) logDecisions(action, s.review, review);
  const changed = review.revision !== s.review.revision;
  detections.setState({
    review,
    ...(changed ? { problem: null, issueError: null } : {}),
    ...(changed && !s.readOnly ? { save: { state: 'pending' } } : {}),
  });
  if (changed && !s.readOnly) schedule();
}

function reset(): void {
  passes.clear();
  saved.clear();
  savedIds.clear();
  savedRuns.clear();
  assessedOf.clear();
  imageSizes.clear();
}

/** The class id for a class id or label of the project's catalogues. */
function classResolver(manifest: ProjectManifest): (raw: string) => string | null {
  const classes = manifest.classCatalogues.flatMap((c) => c.classes);
  const ids = new Set(classes.map((c) => c.id));
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const byLabel = new Map(classes.map((c) => [norm(c.label), c.id]));
  return (raw) => (ids.has(raw) ? raw : (byLabel.get(norm(raw)) ?? null));
}

/**
 * The frames each walk pass looked at, from the passes' `assessed` (`t:<milliseconds>`, written
 * by local detection on a walk), merged by layer: seconds, in order. The 360 overlay shows only
 * the nearest sampled frame's detections, so a frame that found nothing shows nothing.
 */
export function sampledTimes(headers: readonly PassRecord['header'][]): Record<string, number[]> {
  const out = new Map<string, Set<number>>();
  for (const h of headers) {
    if (!h.layer || !Array.isArray(h.assessed)) continue;
    for (const a of h.assessed) {
      const m = /^t:(\d+)$/.exec(a);
      if (!m) continue;
      const set = out.get(h.layer) ?? new Set<number>();
      set.add(Number(m[1]));
      out.set(h.layer, set);
    }
  }
  return Object.fromEntries(
    [...out].map(([layer, set]) => [layer, [...set].sort((a, b) => a - b).map((ms) => ms / 1000)]),
  );
}

/** Read every pass of a project (once per project; `force` reads again). */
export async function loadDetections(projectId: string, force = false): Promise<void> {
  const s = detections.getState();
  if (!force && s.projectId === projectId && (s.loading || !s.loadError)) return;
  await flushDetections();
  reset();
  // reading the same project again keeps the reviewer's filter and place
  const keep = s.projectId === projectId ? { review: s.review } : {};
  detections.setState({ projectId, ...initial(), ...keep, loading: true });
  const r = await bridge.call('detections:read', { projectId });
  if (detections.getState().projectId !== projectId) return;
  if (!r.ok || !r.value.ok) {
    detections.setState({
      loading: false,
      loadError: !r.ok ? r.error : r.value.ok ? null : r.value.error,
    });
    return;
  }
  const res = r.value;
  // the photos' pixel sizes: the crossview pin and placing findings on a model need them
  for (const [key, size] of Object.entries(res.sizes)) {
    const cut = key.indexOf('/');
    if (cut > 0) rememberImageSize(key.slice(0, cut), key.slice(cut + 1), [size[0], size[1]]);
  }
  const ws = workspace.getState();
  const manifest = ws.project?.manifest;
  if (!manifest) return;
  const issueIds = new Set(ws.issues.map((i) => i.id));
  const piped = new Map<string, string>();
  for (const [issueId, ids] of Object.entries(res.issuesMap)) {
    if (!issueIds.has(issueId)) continue;
    for (const id of ids) piped.set(id, issueId);
  }
  const photosLayers = manifest.layers.flatMap((l) => (l.kind === 'photos' ? [l] : []));
  const read = readPasses(res.files, {
    photoLayer: (photo, fileLayer) =>
      photosLayers.find(
        (l) =>
          (fileLayer === undefined || l.id === fileLayer) && l.items.some((p) => p.id === photo),
      )?.id ?? null,
    photoSize: (layer, photo) => {
      const v = res.sizes[`${layer}/${photo}`];
      return v ? [v[0], v[1]] : null;
    },
    classId: classResolver(manifest),
    pipelineIssue: (id) => piped.get(id) ?? null,
  });
  for (const p of read.passes) {
    passes.set(p.name, p);
    savedIds.set(
      p.name,
      read.detections.filter((d) => d.pass === p.name).map((d) => d.id),
    );
    if (p.header.run) savedRuns.add(p.name);
  }
  for (const d of read.detections) saved.set(d.id, d);
  const review = reviewReducer(detections.getState().review, {
    type: 'load',
    detections: read.detections,
    runs: read.runs,
  });
  detections.setState({
    loading: false,
    readOnly: res.readOnly,
    review,
    problems: res.problems,
    hidden: read.hidden,
    sampled: sampledTimes(read.passes.map((p) => p.header)),
  });
}

/** Forget the review when the project closes. */
workspace.subscribe((ws, prev) => {
  const id = ws.project?.id ?? null;
  if (id === (prev.project?.id ?? null)) return;
  void flushDetections().then(() => {
    if (id === null) {
      reset();
      detections.setState({ projectId: null, ...initial() });
    }
  });
});

export type AcceptMode = { kind: 'new' } | { kind: 'link'; issueId: string };

/**
 * Accept the current detection: create a draft issue from it, or add it as a sighting of an
 * existing issue. Only after the issue editor took the change is the detection marked accepted,
 * with the issue id, so the inspection pipeline places it instead of making a second issue.
 */
export function acceptCurrent(mode: AcceptMode): { ok: true; issueId: string } | { ok: false } {
  const s = detections.getState();
  const d = currentOf(s.review);
  if (!d || s.readOnly || d.status === 'accepted') return { ok: false };
  const now = new Date().toISOString();
  const size = imageSizes.get(sourceKey(d.source));
  if (mode.kind === 'new') {
    const input = newIssueInput(d, issueEditor.context(), size);
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
    offerPlacement([created.value.id], 'detections');
    return { ok: true, issueId: created.value.id };
  }
  const sighting = sightingOf(d, size);
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
  offerPlacement([mode.issueId], 'detections');
  return { ok: true, issueId: mode.issueId };
}

const sizeOf = (d: Detection) => imageSizes.get(sourceKey(d.source));

/** What Accept all and Reject all would do with `list` (the filtered list on screen). */
export function planFor(list: readonly Detection[]): BatchPlan {
  return planBatch(list, issueEditor.context(), sizeOf);
}

/**
 * Accept all: every waiting detection of `list` that can be accepted becomes a draft issue, as one
 * issue editor command and one review change of the same label (one Ctrl+Z undoes both).
 */
export function acceptAll(
  list: readonly Detection[],
): { accepted: number; skipped: number } | { error: string } {
  const s = detections.getState();
  if (s.readOnly) return { error: t('det.save.readOnly') };
  const r = acceptMany(list, issueEditor.context(), sizeOf);
  if (r.accepted.length === 0) return { accepted: 0, skipped: r.skipped.length };
  const label = acceptLabel(r.accepted.length);
  const created = issueEditor.createMany(
    r.accepted.map((a) => a.input),
    label,
  );
  if (!created.ok) {
    detections.setState({ problem: null, issueError: created.error });
    return { error: created.error };
  }
  const items = r.accepted.flatMap((a, i) => {
    const issue = created.value[i];
    return issue ? [{ id: a.detection.id, issueId: issue.id }] : [];
  });
  dispatch({
    type: 'acceptedMany',
    items,
    label,
    by: authorName() || 'user',
    now: new Date().toISOString(),
  });
  offerPlacement(
    items.map((x) => x.issueId),
    'detections',
  );
  return { accepted: items.length, skipped: r.skipped.length };
}

/**
 * Accept the named detections for the assistant (`place_on_model`): waiting ones become draft
 * issues as one editor step (as Accept all does); already accepted ones answer their issue.
 * No offer: the assistant places them itself.
 */
export function acceptByIds(
  ids: readonly string[],
):
  | { accepted: { id: string; issueId: string }[]; skipped: { id: string; problem: string }[] }
  | { error: string } {
  const s = detections.getState();
  if (s.readOnly) return { error: t('det.save.readOnly') };
  const want = new Set(ids);
  const list = s.review.detections.filter((d) => want.has(d.id));
  const done = list.flatMap((d) =>
    d.status === 'accepted' && d.issueId ? [{ id: d.id, issueId: d.issueId }] : [],
  );
  const known = new Set(list.map((d) => d.id));
  const skipped = [
    ...[...want].filter((id) => !known.has(id)).map((id) => ({ id, problem: 'not-found' })),
    ...list
      .filter((d) => d.status !== 'draft' && !(d.status === 'accepted' && d.issueId))
      .map((d) => ({ id: d.id, problem: 'not-waiting' })),
  ];
  const r = acceptMany(list, issueEditor.context(), sizeOf);
  skipped.push(...r.skipped.map((x) => ({ id: x.detection.id, problem: x.problem })));
  if (r.accepted.length === 0) return { accepted: done, skipped };
  const label = acceptLabel(r.accepted.length);
  const created = issueEditor.createMany(
    r.accepted.map((a) => a.input),
    label,
  );
  if (!created.ok) return { error: created.error };
  const items = r.accepted.flatMap((a, i) => {
    const issue = created.value[i];
    return issue ? [{ id: a.detection.id, issueId: issue.id }] : [];
  });
  dispatch({
    type: 'acceptedMany',
    items,
    label,
    by: authorName() || 'user',
    now: new Date().toISOString(),
  });
  return { accepted: [...done, ...items], skipped };
}

/** Reject all: every waiting detection of `list`, one undo step. */
export function rejectAll(list: readonly Detection[]): number {
  if (detections.getState().readOnly) return 0;
  const ids = list.filter((d) => d.status === 'draft').map((d) => d.id);
  if (ids.length === 0) return 0;
  dispatch({
    type: 'rejectMany',
    ids,
    label: rejectLabel(ids.length),
    by: authorName() || 'user',
    now: new Date().toISOString(),
  });
  return ids.length;
}

const hasIssue = (id: string) => workspace.getState().issues.some((i) => i.id === id);

/** Undo in the review: an Accept all is undone with its issues, or not at all. */
export function undoReview(): void {
  const s = detections.getState();
  const step = undoStep(s.review.past.at(-1), issueEditor.state.undoLabel, hasIssue);
  if (step === 'none') return;
  if (step === 'blocked') {
    detections.setState({ issueError: t('det.error.batchUndoMoved') });
    return;
  }
  if (step === 'with-issues' && !issueEditor.undo()) return;
  dispatch({ type: 'undo' });
}

/** Redo in the review: an Accept all is redone with its issues, or not at all. */
export function redoReview(): void {
  const s = detections.getState();
  const step = undoStep(s.review.future.at(-1), issueEditor.state.redoLabel, hasIssue, false);
  if (step === 'none') return;
  if (step === 'blocked') {
    detections.setState({ issueError: t('det.error.batchUndoMoved') });
    return;
  }
  if (step === 'with-issues' && !issueEditor.redo()) return;
  dispatch({ type: 'redo' });
}
