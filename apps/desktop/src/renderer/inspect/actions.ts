/**
 * Inspect's actions on AI suggestions, over the detection review store: one key accepts a draft
 * (filling a missing class or severity from the project's last choice when it fits), Change
 * accepts with a picked class and severity, Same as links the draft to an existing finding,
 * Dismiss rejects it with a reason, and the review queue accepts or rejects one class at once.
 *
 * No accept writes a normalized shape: a draft stored as 0..1 (`size` [1, 1]) is scaled to its
 * photo's pixels, whose size comes from the viewer or the library (`imageSizeOf`) or, for a photo
 * never opened, from decoding the file (`resolveImageSize`). The accepts are async for that read;
 * a draft whose photo cannot be read is refused rather than saved in the wrong grid.
 */
import {
  findClass,
  findModel,
  imageSizeOf,
  isAnnotateReadOnly,
  issueEditor,
  rememberImageSize,
} from '@aio/annotate';
import {
  acceptProblem,
  ordered,
  sourceKey,
  type AcceptProblem,
  type Detection,
  type DetectionPatch,
} from '@aio/annotate/detections';
import type { RejectReason } from '@aio/schema';
import { t, type MessageKey } from '@aio/ui';
import { assetUrl, workspace } from '@aio/workspace';
import { authorName } from '../author';
import {
  acceptAll,
  acceptCurrent,
  detections,
  dispatch,
  noteImageSize,
  rejectAll,
  type AcceptMode,
} from '../detections/store';
import { visibleDetections } from './findings';
import { lastChoiceFor, rememberChoice, type Choice } from './lastChoice';

export type AcceptOutcome =
  { ok: true; issueId: string } | { ok: false; needs: 'picker' } | { ok: false; error: string };

/** The sentence the inspector shows for each accept problem. */
const PROBLEM_KEY: Record<AcceptProblem, MessageKey> = {
  'no-class': 'det.problem.noClass',
  'unknown-class': 'det.problem.unknownClass',
  'no-model': 'det.problem.noModel',
  'no-severity': 'det.problem.noSeverity',
  'bad-severity': 'det.problem.badSeverity',
  'no-uncertain': 'det.problem.noUncertain',
  'mask-on-frame': 'det.problem.maskOnFrame',
};

/** Problems the project's last class and severity may fix. */
const FILLABLE = new Set<AcceptProblem>([
  'no-class',
  'unknown-class',
  'no-severity',
  'bad-severity',
  'no-uncertain',
]);

const DECODE_TIMEOUT_MS = 20_000;

const readOnly = () => detections.getState().readOnly || isAnnotateReadOnly();
const readOnlyOutcome = (): AcceptOutcome => ({ ok: false, error: t('inspect.readOnly') });
const isNormalized = (d: Detection) => d.size[0] <= 1 && d.size[1] <= 1;
const find = (id: string) => detections.getState().review.detections.find((d) => d.id === id);

/** The photo item a `photo:<layer>:<photo>` key names in the open project. */
function photoOfKey(key: string) {
  const project = workspace.getState().project;
  if (!project || !key.startsWith('photo:')) return null;
  for (const l of project.manifest.layers) {
    if (l.kind !== 'photos' || !key.startsWith(`photo:${l.id}:`)) continue;
    const id = key.slice(`photo:${l.id}:`.length);
    const item = l.items.find((p) => p.id === id);
    if (item) return { projectId: project.id, layer: l.id, item };
  }
  return null;
}

function decodeSize(url: string): Promise<[number, number] | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      resolve(null);
    }, DECODE_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      resolve(w > 0 && h > 0 ? [w, h] : null);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * The pixel size of a source image (`sourceKey`): the size the viewer or the library registered,
 * else, for a photo, its file decoded once (and remembered). Null when neither knows it. A found
 * size is also noted in the review store, so its accepts scale normalized drafts with it.
 */
export async function resolveImageSize(key: string): Promise<[number, number] | null> {
  const known = knownSize(key);
  if (known) {
    noteImageSize(key, known);
    return known;
  }
  const photo = photoOfKey(key);
  if (!photo) return null;
  let url: string;
  try {
    url = assetUrl(photo.projectId, photo.item.src);
  } catch {
    return null;
  }
  const size = await decodeSize(url);
  if (!size) return null;
  rememberImageSize(photo.layer, photo.item.id, size);
  noteImageSize(key, size);
  return size;
}

function knownSize(key: string): [number, number] | null {
  const photo = photoOfKey(key);
  if (photo) {
    const s = imageSizeOf(photo.layer, photo.item.id);
    return s ? [s[0], s[1]] : null;
  }
  const m = /^frame:(.+):\d+$/.exec(key);
  const s = m?.[1] ? imageSizeOf(m[1], null) : null;
  return s ? [s[0], s[1]] : null;
}

/**
 * The size an accept of `d` scales with. A draft in pixels needs none (the review scaled it to
 * its photo when it was read); a normalized one needs its photo read first, else it is refused.
 */
async function sizeFor(d: Detection): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isNormalized(d)) {
    const known = knownSize(sourceKey(d.source));
    if (known) noteImageSize(sourceKey(d.source), known);
    return { ok: true };
  }
  const size = await resolveImageSize(sourceKey(d.source));
  return size ? { ok: true } : { ok: false, error: t('card.photoFailed') };
}

/**
 * Wait for the size, then check the draft is still the same one waiting in the same project
 * (the person may have moved on, or closed the project, while the photo was read).
 */
async function prepared(
  id: string,
): Promise<{ ok: true; d: Detection } | { ok: false; out: AcceptOutcome }> {
  if (readOnly()) return { ok: false, out: readOnlyOutcome() };
  const d = find(id);
  if (!d) return { ok: false, out: { ok: false, error: t('det.error.missing') } };
  if (d.status === 'accepted')
    return { ok: false, out: { ok: false, error: t('det.error.accepted') } };
  const projectId = detections.getState().projectId;
  const size = await sizeFor(d);
  if (!size.ok) return { ok: false, out: size };
  const now = find(id);
  if (detections.getState().projectId !== projectId || !now)
    return { ok: false, out: { ok: false, error: t('det.error.missing') } };
  if (now.status === 'accepted')
    return { ok: false, out: { ok: false, error: t('det.error.accepted') } };
  if (readOnly()) return { ok: false, out: readOnlyOutcome() };
  return { ok: true, d: now };
}

/** Make `id` current and accept it through the review store; the store's error otherwise. */
function acceptNow(d: Detection, mode: AcceptMode, patch: DetectionPatch | null): AcceptOutcome {
  if (patch) dispatch({ type: 'edit', id: d.id, patch, now: new Date().toISOString() });
  dispatch({ type: 'select', id: d.id });
  const r = acceptCurrent(mode);
  if (r.ok) return r;
  const s = detections.getState();
  const error = s.issueError ?? (s.problem ? t(PROBLEM_KEY[s.problem]) : t('det.error.missing'));
  return { ok: false, error };
}

/** The patch the last choice makes to `d`: empty when its severity does not fit `d`'s class. */
function fillFromLast(d: Detection, last: Choice): DetectionPatch {
  const ctx = issueEditor.context();
  const sev = { severity: last.severity, uncertain: last.severity === 'uncertain' };
  const cls = d.classId ? findClass(ctx, d.classId) : undefined;
  if (!cls) return { classId: last.classId, ...sev };
  const model = findModel(ctx, cls.severityModel);
  const fits =
    last.severity === 'uncertain'
      ? !!model?.uncertain
      : !!model?.levels.some((l) => l.value === last.severity);
  return fits ? sev : {};
}

/** One key: make `id` current, fill a missing or unfitting class and severity from the last choice when it fits the class's model, accept as a new issue. Opens nothing itself: `needs: 'picker'` asks the caller to. */
export async function acceptSuggestion(projectId: string, id: string): Promise<AcceptOutcome> {
  const p = await prepared(id);
  if (!p.ok) return p.out;
  const d = p.d;
  const ctx = issueEditor.context();
  const problem = acceptProblem(d, ctx);
  if (problem === null) return acceptNow(d, { kind: 'new' }, null);
  if (problem === 'mask-on-frame') return { ok: false, error: t(PROBLEM_KEY[problem]) };
  const last = lastChoiceFor(projectId);
  if (!FILLABLE.has(problem) || !last) return { ok: false, needs: 'picker' };
  const patch = fillFromLast(d, last);
  if (Object.keys(patch).length === 0 || acceptProblem({ ...d, ...patch }, ctx) !== null)
    return { ok: false, needs: 'picker' };
  return acceptNow(d, { kind: 'new' }, patch);
}

/** Change, then accept: patch class and severity, accept, remember the choice. */
export async function acceptWith(
  projectId: string,
  id: string,
  choice: Choice,
): Promise<AcceptOutcome> {
  const p = await prepared(id);
  if (!p.ok) return p.out;
  const patch: DetectionPatch = {
    classId: choice.classId,
    severity: choice.severity,
    uncertain: choice.severity === 'uncertain',
  };
  const problem = acceptProblem({ ...p.d, ...patch }, issueEditor.context());
  if (problem) return { ok: false, error: t(PROBLEM_KEY[problem]) };
  const r = acceptNow(p.d, { kind: 'new' }, patch);
  if (r.ok) rememberChoice(projectId, choice);
  return r;
}

/** Same as an existing finding: add the draft as a sighting of `issueId`. */
export async function linkSuggestion(id: string, issueId: string): Promise<AcceptOutcome> {
  const p = await prepared(id);
  if (!p.ok) return p.out;
  return acceptNow(p.d, { kind: 'link', issueId }, null);
}

export function dismissSuggestion(id: string, reason?: RejectReason, note?: string): void {
  if (readOnly()) return;
  dispatch({
    type: 'reject',
    id,
    by: authorName() || 'user',
    now: new Date().toISOString(),
    ...(reason ? { reason } : {}),
    ...(note?.trim() ? { note: note.trim() } : {}),
  });
}

/** The waiting drafts of `classId` (or all) at or above `threshold`, in review order. */
export function waitingOf(classId: string | null, threshold: number): Detection[] {
  const review = detections.getState().review;
  const shown = new Set(visibleDetections(review).map((d) => d.id));
  return ordered(review.detections).filter(
    (d) =>
      d.status === 'draft' &&
      shown.has(d.id) &&
      (classId === null || d.classId === classId) &&
      (d.unscored === true || d.confidence === undefined || d.confidence >= threshold),
  );
}

/**
 * Accept all of `classId` above `threshold` as one undo step. Only scored drafts count ("above
 * 80 %" says nothing about an unscored one); a normalized draft whose photo cannot be read is
 * skipped, not accepted in the wrong grid.
 */
export async function acceptAllAbove(
  classId: string,
  threshold: number,
): Promise<{ accepted: number; skipped: number } | { error: string }> {
  if (readOnly()) return { error: t('inspect.readOnly') };
  const projectId = detections.getState().projectId;
  const list = waitingOf(classId, threshold).filter(
    (d) => !d.unscored && d.confidence !== undefined && d.confidence >= threshold,
  );
  const ready = await Promise.all(list.map(async (d) => ((await sizeFor(d)).ok ? d : null)));
  if (detections.getState().projectId !== projectId) return { error: t('det.error.missing') };
  if (readOnly()) return { error: t('inspect.readOnly') };
  const ids = new Set(ready.flatMap((d) => (d ? [d.id] : [])));
  const unread = list.length - ids.size;
  // the drafts as they are now: one may have been decided while the photos were read
  const now = detections.getState().review.detections.filter((d) => ids.has(d.id));
  const r = acceptAll(now);
  return 'error' in r ? r : { accepted: r.accepted, skipped: r.skipped + unread };
}

export function rejectAllOfClass(classId: string): number {
  if (readOnly()) return 0;
  return rejectAll(waitingOf(classId, 0));
}
