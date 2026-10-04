/**
 * Detection review state for the open project (BLD-5): the pure review reducer from
 * `@aio/annotate/detections` over every detection pass of the project
 * (`<project>/detections/*.json`, `aio.detections/1`, data-conventions section 11). Each change is
 * written back into the pass it came from (atomic, with a `.bak`); drawings go to `review.json`,
 * each AI run to `ai-<run>.json`. Detections the inspection pipeline already turned into issues
 * show as accepted and are never changed. Acceptance runs through the app's issue editor
 * (validated, saved, undoable in the register like any other issue change).
 */
import { issueEditor } from '@aio/annotate';
import {
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
  /** Files in detections/ the review cannot read, left as they are. */
  problems: { name: string; error: string }[];
  /** Detections the review cannot show (contact sheet boxes, photos it cannot find). */
  hidden: number;
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
  const byLabel = new Map(classes.map((c) => [c.label.trim().toLowerCase(), c.id]));
  return (raw) => (ids.has(raw) ? raw : (byLabel.get(raw.trim().toLowerCase()) ?? null));
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
  return { ok: true, issueId: mode.issueId };
}
