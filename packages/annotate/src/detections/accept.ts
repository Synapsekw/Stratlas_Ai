import { err, ok, type DetectionGeom, type Issue, type Result, type Sighting } from '@aio/schema';
import { findClass, findModel, type IssueContext } from '../model/ops';
import { scaleGeom, toFrameGeom } from './geometry';
import type { Detection } from './model';

/*
 * What an accepted detection becomes: a new issue (its first sighting) or one more sighting of an
 * existing issue. Pure; the app runs the result through the issue editor so it is validated,
 * saved and undoable like any other issue change.
 */

/**
 * Why a detection cannot be accepted yet; the app turns these into sentences (i18n).
 * - `no-class` / `unknown-class`: pick a class from the project's catalogues.
 * - `no-severity` / `bad-severity`: pick a severity of the class's model.
 * - `no-uncertain`: marked uncertain, but the model has no uncertain level: pick a severity.
 * - `mask-on-frame`: a video frame takes a box or polygon, not a mask.
 * - `no-model`: the class names a severity model the project does not have.
 */
export type AcceptProblem =
  | 'no-class'
  | 'unknown-class'
  | 'no-model'
  | 'no-severity'
  | 'bad-severity'
  | 'no-uncertain'
  | 'mask-on-frame';

/**
 * The shape in the pixels of the image an issue sighting uses. A normalized pass (`size` 1 x 1)
 * cannot be scaled without the image: `imageSize` gives it (the review knows it once loaded).
 */
export function inPixels(d: Detection, imageSize?: readonly [number, number]): DetectionGeom {
  const target = imageSize ?? d.size;
  if (target[0] === d.size[0] && target[1] === d.size[1]) return d.geom;
  return scaleGeom(d.geom, target[0] / d.size[0], target[1] / d.size[1]);
}

/** The sighting a detection adds to an issue. */
export function sightingOf(d: Detection, imageSize?: readonly [number, number]): Result<Sighting> {
  const geom0 = inPixels(d, imageSize);
  if (d.source.kind === 'photo') {
    return ok({ on: 'image', layer: d.source.layer, photo: d.source.photo, geom: geom0 });
  }
  const geom = toFrameGeom(geom0);
  if (!geom) return err('mask-on-frame');
  return ok({ on: 'video', layer: d.source.layer, track: [{ t: d.source.t, geom }] });
}

/** The severity an accepted detection gets: the uncertain level when flagged (if the model has one). */
export function acceptedSeverity(
  d: Detection,
  ctx: IssueContext,
): { ok: true; value: Issue['severity'] } | { ok: false; error: AcceptProblem } {
  if (!d.classId) return { ok: false, error: 'no-class' };
  const cls = findClass(ctx, d.classId);
  if (!cls) return { ok: false, error: 'unknown-class' };
  const model = findModel(ctx, cls.severityModel);
  if (!model) return { ok: false, error: 'no-model' };
  if (d.uncertain || d.severity === 'uncertain') {
    if (model.uncertain) return { ok: true, value: 'uncertain' };
    if (typeof d.severity !== 'number') return { ok: false, error: 'no-uncertain' };
  }
  if (typeof d.severity !== 'number') return { ok: false, error: 'no-severity' };
  if (!model.levels.some((l) => l.value === d.severity))
    return { ok: false, error: 'bad-severity' };
  return { ok: true, value: d.severity };
}

/** Null when the detection can be accepted, else the first problem. */
export function acceptProblem(
  d: Detection,
  ctx: IssueContext,
  imageSize?: readonly [number, number],
): AcceptProblem | null {
  const sev = acceptedSeverity(d, ctx);
  if (!sev.ok) return sev.error;
  const s = sightingOf(d, imageSize);
  return s.ok ? null : (s.error as AcceptProblem);
}

/**
 * The issue's `source`: AI and local model proposals make `agent` issues (as in the inspection
 * pipeline), imports `import`, a person's drawing `human`.
 */
export function issueSourceOf(d: Detection): Issue['source'] {
  switch (d.origin.kind) {
    case 'ai':
    case 'model':
      return 'agent';
    case 'import':
      return 'import';
    case 'human':
      return 'human';
  }
}

/** Provenance written into the issue note, so the register shows where a finding came from. */
export function provenanceLine(d: Detection): string {
  const conf = d.confidence !== undefined ? `, confidence ${Math.round(d.confidence * 100)} %` : '';
  const where =
    d.source.kind === 'photo'
      ? `photo ${d.source.photo}`
      : `${d.source.layer} at ${d.source.t.toFixed(1)} s`;
  switch (d.origin.kind) {
    case 'ai':
      return `Detected by ${d.origin.model} (prompt ${d.origin.promptVersion || 'unversioned'}${conf}) on ${where}, accepted by a reviewer.`;
    case 'model':
    case 'import':
      return `Detected by ${d.origin.producer}${conf} on ${where}, accepted by a reviewer.`;
    case 'human':
      return '';
  }
}

export interface AcceptAsNew {
  sighting: Sighting;
  classId: string;
  severity: Issue['severity'];
  title?: string;
  note: string;
  source: Issue['source'];
}

/** Input for `issueEditor.create`: a new draft issue from the detection. */
export function newIssueInput(
  d: Detection,
  ctx: IssueContext,
  imageSize?: readonly [number, number],
): { ok: true; value: AcceptAsNew } | { ok: false; error: AcceptProblem } {
  const sev = acceptedSeverity(d, ctx);
  if (!sev.ok) return sev;
  const s = sightingOf(d, imageSize);
  if (!s.ok) return { ok: false, error: s.error as AcceptProblem };
  const note = [d.note.trim(), provenanceLine(d)].filter(Boolean).join('\n');
  const cls = findClass(ctx, d.classId);
  return {
    ok: true,
    value: {
      sighting: s.value,
      classId: d.classId,
      severity: sev.value,
      ...(cls ? { title: cls.label } : {}),
      note,
      source: issueSourceOf(d),
    },
  };
}

/** Issues a detection may join: those with a sighting on the same photo or video layer first. */
export function linkCandidates(d: Detection, issues: readonly Issue[]): Issue[] {
  const here = (i: Issue) =>
    i.sightings.some((s) =>
      d.source.kind === 'photo'
        ? s.on === 'image' && s.layer === d.source.layer && s.photo === d.source.photo
        : s.on === 'video' && s.layer === d.source.layer,
    );
  const near = issues.filter(here);
  const sameClass = issues.filter((i) => !here(i) && i.classId === d.classId);
  const rest = issues.filter((i) => !here(i) && i.classId !== d.classId);
  return [...near, ...sameClass, ...rest];
}
