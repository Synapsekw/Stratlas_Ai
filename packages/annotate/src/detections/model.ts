import type {
  DetectionGeom,
  Detection as PassDetection,
  DetectionRun as PassRun,
  DetectionsFile,
} from '@aio/schema';

/*
 * Detections waiting for review (BLD-5): boxes and outlines on photos and video frames, drawn by
 * a person, proposed by a vision model (BLD-6), a local model or an import. A detection counts
 * for nothing until a person accepts it; then it becomes an issue or a sighting of an issue.
 *
 * On disk they are the inspection pipeline's passes: one `aio.detections/1` file per pass in
 * `<project>/detections/` (`@aio/schema` `detections.ts`, data-conventions section 11). This module
 * is the bridge: `readPasses` turns the files into the review's model and `writePass` writes a
 * pass back, keeping every field the review does not own exactly as it was. Hand-drawn
 * detections go to `review.json`, each AI run to `ai-<run>.json`.
 */

export const DETECTIONS_SCHEMA = 'aio.detections/1';
/** Folder of the pass files in a project. */
export const DETECTIONS_DIR = 'detections';
/** The pass file of detections drawn in the review. */
export const REVIEW_PASS = 'review.json';

/** The pass file of one AI run. */
export const aiPassName = (runId: string) =>
  `ai-${runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}.json`;

export type DetectionStatus = 'draft' | 'accepted' | 'rejected';

/** Where a detection was seen: one photo of a photo layer, or one frame of a video layer. */
export type DetectionSource =
  | { kind: 'photo'; layer: string; photo: string }
  /** `t` in video seconds (data-conventions section 3). */
  | { kind: 'frame'; layer: string; t: number };

/** Who proposed a detection (the pass `source` with its details). Only `human` may be deleted. */
export type DetectionOrigin =
  | { kind: 'human'; author: string }
  | { kind: 'ai'; provider: string; model: string; promptVersion: string; runId: string }
  | { kind: 'model' | 'import'; producer: string };

export interface Detection {
  /** The file's id, or `<pass>#<index>` for a detection the file gives none (not written back). */
  id: string;
  /** The pass file it lives in (`review.json`, `ai-<run>.json`, ...). */
  pass: string;
  source: DetectionSource;
  /** Width and height of the pixel grid `geom` is in (`[1, 1]` for a normalized pass). */
  size: [number, number];
  geom: DetectionGeom;
  /** Class id from the project's catalogues; empty when the proposer's word matched none. */
  classId: string;
  /** The proposer's own word, kept for review. */
  label?: string;
  severity: number | 'uncertain' | null;
  /** Marked uncertain: accepted as the model's uncertain level. */
  uncertain: boolean;
  note: string;
  /** 0 to 1, from the model. */
  confidence?: number;
  /**
   * `accepted` without `issueId`: counted by the inspection pipeline, which makes the issue.
   * `accepted` with `issueId`: an issue already (made in the review, or by the pipeline).
   */
  status: DetectionStatus;
  origin: DetectionOrigin;
  issueId?: string;
  /** The pipeline made the issue (`inspection/issues-map.json`); never written to the pass. */
  issuedBy?: 'pipeline';
  /** Part of the asset, from the producer. */
  component?: string;
  createdAt?: string;
  updatedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** An AI or model run, kept in its pass file (`run`). */
export type DetectionRun = PassRun & { pass: string };

export interface PassFile {
  name: string;
  file: DetectionsFile;
}

/** What the bridge needs from the project to read passes. */
export interface PassContext {
  /** The photos layer of a photo (the file's `layer`, else the first layer that has it). */
  photoLayer(photo: string, fileLayer: string | undefined): string | null;
  /** Pixel size of a photo file (for boxes in preview space). */
  photoSize(layer: string, photo: string): [number, number] | null;
  /** A class id for a class id or label, or null. */
  classId(raw: string): string | null;
  /** Detection id to the inspection pipeline's issue id, for issues that still exist. */
  pipelineIssue(detectionId: string): string | null;
}

/** One pass as read: its header, and every raw detection with the review's id for it. */
export interface PassRecord {
  name: string;
  header: Omit<DetectionsFile, 'detections'>;
  entries: {
    id: string;
    raw: PassDetection;
    /** False for boxes the review cannot show (a contact sheet box, a photo of unknown size). */
    reviewable: boolean;
    hadId: boolean;
  }[];
}

export interface ReadResult {
  detections: Detection[];
  runs: DetectionRun[];
  passes: PassRecord[];
  /** Detections the review cannot show (kept as they are in their files). */
  hidden: number;
}

function boxGeom(b: readonly [number, number, number, number]): DetectionGeom {
  return { type: 'box', x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
}

function originOf(raw: PassDetection, file: DetectionsFile): DetectionOrigin {
  const kind = raw.source ?? file.source;
  const o = raw.origin ?? {};
  if (kind === 'human') return { kind: 'human', author: o.author ?? file.producer ?? '' };
  if (kind === 'ai') {
    return {
      kind: 'ai',
      provider: o.provider ?? file.run?.provider ?? '',
      model: o.model ?? file.run?.model ?? file.producer ?? '',
      promptVersion: o.promptVersion ?? file.run?.promptVersion ?? '',
      runId: o.runId ?? file.run?.id ?? '',
    };
  }
  return { kind, producer: o.model ?? file.producer ?? kind };
}

/** One raw detection as the review's model, or null when the review cannot show it. */
function fromPass(
  raw: PassDetection,
  id: string,
  pass: PassFile,
  ctx: PassContext,
): Detection | null {
  const { file, name } = pass;
  const space = raw.space ?? 'preview';
  if (space === 'sheet') return null;
  let source: DetectionSource;
  if (raw.frame) {
    source = { kind: 'frame', layer: raw.frame.layer, t: raw.frame.t };
  } else {
    if (!raw.photo) return null;
    const layer = ctx.photoLayer(raw.photo, file.layer);
    if (!layer) return null;
    source = { kind: 'photo', layer, photo: raw.photo };
  }
  let size: [number, number] | null;
  if (space === 'normalized') size = [1, 1];
  else if (raw.width && raw.height) size = [raw.width, raw.height];
  else size = source.kind === 'photo' ? ctx.photoSize(source.layer, source.photo) : null;
  if (!size) return null;
  const classId = ctx.classId(raw.class) ?? '';
  const d: Detection = {
    id,
    pass: name,
    source,
    size,
    geom: raw.geom ?? boxGeom(raw.bbox),
    classId,
    severity: raw.severity ?? null,
    uncertain: raw.uncertain ?? raw.severity === 'uncertain',
    note: raw.note ?? '',
    status: raw.status ?? 'accepted',
    origin: originOf(raw, file),
  };
  const label = raw.label ?? (classId ? undefined : raw.class);
  if (label) d.label = label;
  if (raw.confidence !== undefined) d.confidence = raw.confidence;
  if (raw.issueId) d.issueId = raw.issueId;
  if (raw.component) d.component = raw.component;
  for (const k of ['createdAt', 'updatedAt', 'reviewedBy', 'reviewedAt'] as const) {
    const v = raw[k];
    if (v) d[k] = v;
  }
  if (!d.issueId) {
    const piped = ctx.pipelineIssue(id);
    if (piped) {
      d.status = 'accepted';
      d.issueId = piped;
      d.issuedBy = 'pipeline';
    }
  }
  return d;
}

/** Read every pass file into the review's model. */
export function readPasses(files: readonly PassFile[], ctx: PassContext): ReadResult {
  const detections: Detection[] = [];
  const runs: DetectionRun[] = [];
  const passes: PassRecord[] = [];
  const seen = new Set<string>();
  let hidden = 0;
  for (const pass of files) {
    const { detections: list, ...header } = pass.file;
    const rec: PassRecord = { name: pass.name, header, entries: [] };
    list.forEach((raw, i) => {
      let id = raw.id ?? `${pass.name}#${String(i)}`;
      // the same id in two passes: the review keys the second by its place
      if (seen.has(id)) id = `${pass.name}#${String(i)}`;
      seen.add(id);
      const d = fromPass(raw, id, pass, ctx);
      if (d) detections.push(d);
      else hidden++;
      rec.entries.push({
        id,
        raw,
        reviewable: d !== null,
        hadId: raw.id !== undefined && raw.id === id,
      });
    });
    if (pass.file.run) runs.push({ ...pass.file.run, pass: pass.name });
    passes.push(rec);
  }
  return { detections, runs, passes, hidden };
}

const POINT_HALF = 4;

/** `[x0, y0, x1, y1]` bounds of a shape (a point gets a small box), never empty. */
export function boundsOf(g: DetectionGeom): [number, number, number, number] {
  let xs: number[];
  let ys: number[];
  switch (g.type) {
    case 'point':
      return [g.x - POINT_HALF, g.y - POINT_HALF, g.x + POINT_HALF, g.y + POINT_HALF];
    case 'box':
      return [g.x, g.y, g.x + g.w, g.y + g.h];
    case 'rotbox': {
      const cx = g.x + g.w / 2;
      const cy = g.y + g.h / 2;
      const a = (g.angleDeg * Math.PI) / 180;
      const corners = [
        [-g.w / 2, -g.h / 2],
        [g.w / 2, -g.h / 2],
        [g.w / 2, g.h / 2],
        [-g.w / 2, g.h / 2],
      ].map(([dx = 0, dy = 0]) => [
        cx + dx * Math.cos(a) - dy * Math.sin(a),
        cy + dx * Math.sin(a) + dy * Math.cos(a),
      ]);
      xs = corners.map((c) => c[0] ?? 0);
      ys = corners.map((c) => c[1] ?? 0);
      break;
    }
    case 'polygon':
      xs = g.points.map((p) => p[0]);
      ys = g.points.map((p) => p[1]);
      break;
  }
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (x1 <= x0) {
    x0 -= 0.5;
    x1 += 0.5;
  }
  if (y1 <= y0) {
    y0 -= 0.5;
    y1 += 0.5;
  }
  return [x0, y0, x1, y1];
}

/** The pass entry for a detection, keeping the fields the review does not own. */
export function toPassDetection(
  d: Detection,
  base: { raw?: PassDetection; hadId?: boolean; fileSource: DetectionsFile['source'] },
): PassDetection {
  const raw = base.raw;
  const out: Record<string, unknown> = {};
  // fields the review does not own come through unchanged
  if (raw?.component !== undefined) out.component = raw.component;
  if (raw?.origin) out.origin = raw.origin;
  if (base.hadId !== false) out.id = d.id;
  if (d.source.kind === 'photo') out.photo = d.source.photo;
  else out.frame = { layer: d.source.layer, t: d.source.t };
  out.class = d.classId !== '' ? d.classId : (d.label ?? 'unclassified');
  if (d.label) out.label = d.label;
  if (d.severity !== null) out.severity = d.severity;
  if (d.uncertain) out.uncertain = true;
  if (d.confidence !== undefined) out.confidence = d.confidence;
  if (d.note) out.note = d.note;
  out.status = d.status;
  const kind = d.origin.kind;
  if (kind !== base.fileSource) out.source = kind;
  if (d.origin.kind === 'ai') {
    out.origin = {
      provider: d.origin.provider,
      model: d.origin.model,
      promptVersion: d.origin.promptVersion,
      runId: d.origin.runId,
    };
  } else if (d.origin.kind === 'human' && d.origin.author) {
    out.origin = { author: d.origin.author };
  }
  const normalized = raw?.space === 'normalized' && d.size[0] === 1 && d.size[1] === 1;
  if (normalized) out.space = 'normalized';
  else {
    out.space = 'source';
    out.width = d.size[0];
    out.height = d.size[1];
  }
  const r = (n: number) => Math.round(n * 1000) / 1000;
  out.bbox = boundsOf(d.geom).map(r);
  out.geom = d.geom;
  if (d.issueId && d.issuedBy !== 'pipeline') out.issueId = d.issueId;
  for (const k of ['createdAt', 'updatedAt', 'reviewedBy', 'reviewedAt'] as const) {
    const v = d[k];
    if (v) out[k] = v;
  }
  return out as PassDetection;
}

/**
 * The file of one pass as it should be on disk: detections the review did not change are the
 * original entries, byte for byte; changed and new ones are written from the review's model;
 * entries the review cannot show stay. `loaded` holds each detection as it was read.
 */
export function writePass(
  rec: PassRecord,
  detections: readonly Detection[],
  loaded: ReadonlyMap<string, Detection>,
  run?: PassRun,
): DetectionsFile {
  const raws = new Map(rec.entries.map((e) => [e.id, e]));
  const out: PassDetection[] = [];
  for (const d of detections) {
    if (d.pass !== rec.name) continue;
    const e = raws.get(d.id);
    if (e && loaded.get(d.id) === d) out.push(e.raw);
    else {
      out.push(
        toPassDetection(d, {
          ...(e ? { raw: e.raw, hadId: e.hadId } : {}),
          fileSource: rec.header.source,
        }),
      );
    }
  }
  for (const e of rec.entries) if (!e.reviewable) out.push(e.raw);
  return { ...rec.header, ...(run ? { run } : {}), detections: out };
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
