import { ImageGeom, err, ok, type Result } from '@aio/schema';

/*
 * Detections waiting for review (BLD-5): boxes and masks on photos and video frames, drawn by a
 * person, proposed by a vision model (BLD-6) or by a pipeline (BLD-4). A detection counts for
 * nothing until a person accepts it; then it becomes an issue or a sighting of an issue.
 *
 * The file format `aio.detections/1` is being defined in `@aio/schema` by the inspection pipeline
 * stream (P1). Until it lands, these local types are the review's own model and
 * `parseDetectionsFile` / `toDetectionsFile` are the adapter: when the schema arrives only the
 * adapter changes. Assumed layout of `<project>/detections.json`:
 *
 *   { "schema": "aio.detections/1", "detections": Detection[], "runs": DetectionRun[] }
 */

export const DETECTIONS_SCHEMA = 'aio.detections/1';
/** Project-relative file of the review (data-conventions section 2). */
export const DETECTIONS_FILE = 'detections.json';

export type DetectionStatus = 'draft' | 'accepted' | 'rejected';

/** Where a detection was seen: one photo of a photo layer, or one frame of a video layer. */
export type DetectionSource =
  | { kind: 'photo'; layer: string; photo: string }
  /** `t` in video seconds (data-conventions section 3). */
  | { kind: 'frame'; layer: string; t: number };

/** Who proposed a detection. Only `human` detections may be deleted outright. */
export type DetectionOrigin =
  | { kind: 'human'; author: string }
  | {
      kind: 'ai';
      provider: string;
      model: string;
      promptVersion: string;
      runId: string;
    }
  | { kind: 'pipeline'; pipeline: string; version?: string; model?: string };

export interface Detection {
  id: string;
  source: DetectionSource;
  /** Width and height in pixels of the image the geometry is drawn on. */
  size: [number, number];
  /** In image pixels of `size` (schema ImageGeom: box, rotbox, polygon, point, mask). */
  geom: ImageGeom;
  /** Class id from the project's catalogues; empty when the proposer's label matched none. */
  classId: string;
  /** The label the model or pipeline gave, kept for review. */
  label?: string;
  severity: number | 'uncertain' | null;
  /** Marked uncertain by the reviewer (or the model): accepted as the model's uncertain level. */
  uncertain: boolean;
  note: string;
  /** 0 to 1, from the model or pipeline. */
  confidence?: number;
  status: DetectionStatus;
  origin: DetectionOrigin;
  /** The issue an accepted detection became or joined. */
  issueId?: string;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** One AI or pipeline pass, for the record and the cost meter. */
export interface DetectionRun {
  id: string;
  at: string;
  kind: 'ai' | 'pipeline';
  provider?: string;
  model?: string;
  promptVersion?: string;
  images: number;
  detections: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface DetectionsFile {
  schema: typeof DETECTIONS_SCHEMA;
  detections: Detection[];
  runs: DetectionRun[];
}

export const emptyDetectionsFile = (): DetectionsFile => ({
  schema: DETECTIONS_SCHEMA,
  detections: [],
  runs: [],
});

// ---- small guards for untrusted JSON ----
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function parseSource(v: unknown): DetectionSource | null {
  if (!isObj(v)) return null;
  const layer = str(v.layer);
  if (!layer) return null;
  if (v.kind === 'photo') {
    const photo = str(v.photo);
    return photo ? { kind: 'photo', layer, photo } : null;
  }
  if (v.kind === 'frame') {
    const t = num(v.t);
    return t !== undefined && t >= 0 ? { kind: 'frame', layer, t } : null;
  }
  return null;
}

function parseOrigin(v: unknown): DetectionOrigin | null {
  if (!isObj(v)) return null;
  if (v.kind === 'human') return { kind: 'human', author: str(v.author) ?? 'user' };
  if (v.kind === 'ai') {
    const provider = str(v.provider);
    const model = str(v.model);
    if (!provider || !model) return null;
    return {
      kind: 'ai',
      provider,
      model,
      promptVersion: str(v.promptVersion) ?? '',
      runId: str(v.runId) ?? '',
    };
  }
  if (v.kind === 'pipeline') {
    const pipeline = str(v.pipeline);
    if (!pipeline) return null;
    const version = str(v.version);
    const model = str(v.model);
    return {
      kind: 'pipeline',
      pipeline,
      ...(version ? { version } : {}),
      ...(model ? { model } : {}),
    };
  }
  return null;
}

const STATUSES: readonly DetectionStatus[] = ['draft', 'accepted', 'rejected'];

/** One detection from JSON, or a reason it is not one. */
export function parseDetection(v: unknown, where = 'detection'): Result<Detection> {
  if (!isObj(v)) return err(`${where} is not an object`);
  const id = str(v.id);
  if (!id) return err(`${where} has no id`);
  const source = parseSource(v.source);
  if (!source) return err(`${where} (${id}) has no valid source`);
  const size = Array.isArray(v.size) ? v.size : [];
  const w = num(size[0]);
  const h = num(size[1]);
  if (!w || !h || w <= 0 || h <= 0) return err(`${where} (${id}) has no image size`);
  const geom = ImageGeom.safeParse(v.geom);
  if (!geom.success) return err(`${where} (${id}) has an invalid shape`);
  const status = STATUSES.find((s) => s === v.status);
  if (!status) return err(`${where} (${id}) has an unknown status`);
  const origin = parseOrigin(v.origin);
  if (!origin) return err(`${where} (${id}) has no valid origin`);
  const sev = v.severity;
  const severity =
    sev === 'uncertain'
      ? 'uncertain'
      : typeof sev === 'number' && Number.isInteger(sev)
        ? sev
        : null;
  const confidence = num(v.confidence);
  const createdAt = str(v.createdAt) ?? new Date(0).toISOString();
  const d: Detection = {
    id,
    source,
    size: [w, h],
    geom: geom.data,
    classId: str(v.classId) ?? '',
    severity,
    uncertain: v.uncertain === true,
    note: str(v.note) ?? '',
    status,
    origin,
    createdAt,
    updatedAt: str(v.updatedAt) ?? createdAt,
  };
  const label = str(v.label);
  if (label) d.label = label;
  if (confidence !== undefined) d.confidence = Math.min(1, Math.max(0, confidence));
  const issueId = str(v.issueId);
  if (issueId) d.issueId = issueId;
  const reviewedBy = str(v.reviewedBy);
  if (reviewedBy) d.reviewedBy = reviewedBy;
  const reviewedAt = str(v.reviewedAt);
  if (reviewedAt) d.reviewedAt = reviewedAt;
  if (d.status === 'accepted' && !d.issueId) {
    return err(`${where} (${id}) is accepted but names no issue`);
  }
  return ok(d);
}

function parseRun(v: unknown): DetectionRun | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const at = str(v.at);
  if (!id || !at) return null;
  const run: DetectionRun = {
    id,
    at,
    kind: v.kind === 'pipeline' ? 'pipeline' : 'ai',
    images: num(v.images) ?? 0,
    detections: num(v.detections) ?? 0,
  };
  for (const k of ['provider', 'model', 'promptVersion'] as const) {
    const s = str(v[k]);
    if (s) run[k] = s;
  }
  for (const k of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    const n = num(v[k]);
    if (n !== undefined) run[k] = n;
  }
  return run;
}

/**
 * Read `detections.json`. A file that is not `aio.detections/1` is refused; one bad detection
 * refuses the file (nothing is silently dropped, so a save never loses a reviewer's work).
 */
export function parseDetectionsFile(raw: unknown): Result<DetectionsFile> {
  if (!isObj(raw)) return err('The detections file is not a JSON object');
  if (raw.schema !== DETECTIONS_SCHEMA) {
    return err(`The detections file is not ${DETECTIONS_SCHEMA} (found ${String(raw.schema)})`);
  }
  if (!Array.isArray(raw.detections)) return err('The detections file has no detections list');
  const detections: Detection[] = [];
  const seen = new Set<string>();
  for (const [i, v] of raw.detections.entries()) {
    const r = parseDetection(v, `detections[${String(i)}]`);
    if (!r.ok) return r;
    if (seen.has(r.value.id)) return err(`Detection id ${r.value.id} appears twice`);
    seen.add(r.value.id);
    detections.push(r.value);
  }
  const runs = Array.isArray(raw.runs)
    ? raw.runs.map(parseRun).filter((r): r is DetectionRun => r !== null)
    : [];
  return ok({ schema: DETECTIONS_SCHEMA, detections, runs });
}

export function toDetectionsFile(
  detections: readonly Detection[],
  runs: readonly DetectionRun[] = [],
): DetectionsFile {
  return { schema: DETECTIONS_SCHEMA, detections: [...detections], runs: [...runs] };
}

/** Stable key of a source image: `photo:<layer>:<photo>` or `frame:<layer>:<t>` (ms). */
export function sourceKey(s: DetectionSource): string {
  return s.kind === 'photo'
    ? `photo:${s.layer}:${s.photo}`
    : `frame:${s.layer}:${String(Math.round(s.t * 1000))}`;
}

export function sameSource(a: DetectionSource, b: DetectionSource): boolean {
  return sourceKey(a) === sourceKey(b);
}
