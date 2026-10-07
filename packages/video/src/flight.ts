import { normaliseSamples } from '@aio/geo';
import { LensModel, PoseSample, type Quat } from '@aio/schema';

/** A parsed `aio.flight/1` pose file (docs/architecture/data-conventions.md section 3). */
export interface Flight {
  schema: 'aio.flight/1';
  /** UTC milliseconds of sample `t = 0`. */
  startUtcMs: number;
  lens: LensModel;
  /** Camera poses, sorted by `t` (ms since `startUtcMs`), unit quaternions. */
  samples: PoseSample[];
  /** Time of the last sample. */
  durationMs: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface ZodLikeIssue {
  path: readonly PropertyKey[];
  message: string;
}

function describeIssue(issue: ZodLikeIssue | undefined): string {
  if (!issue) return 'invalid';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function fail(msg: string): never {
  throw new Error(`Flight file: ${msg}`);
}

function normaliseQuat(q: Quat, index: number): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 1e-9)) fail(`sample ${index} has a zero quaternion`);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * Validates and parses an `aio.flight/1` document (object or JSON text). Throws an Error whose
 * message names the offending field or sample. Stair-stepped positions and an estimated heading
 * are smoothed as they load (`normaliseFlight` in @aio/geo) unless `raw` is set; the file on disk
 * is never changed.
 */
export function parseFlight(input: unknown, opts: { raw?: boolean } = {}): Flight {
  let json = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input) as unknown;
    } catch (e) {
      throw new Error(`Flight file is not valid JSON (${(e as Error).message})`, { cause: e });
    }
  }
  if (!isRecord(json)) fail('expected a JSON object');
  if (json.schema !== 'aio.flight/1')
    fail(`expected schema "aio.flight/1", got ${JSON.stringify(json.schema)}`);
  const start = json.startUtcMs;
  if (typeof start !== 'number' || !Number.isFinite(start))
    fail('startUtcMs must be a number (UTC milliseconds)');

  const lens = LensModel.safeParse(json.lens);
  if (!lens.success) fail(`lens ${describeIssue(lens.error.issues[0])}`);

  const raw = json.samples;
  if (!Array.isArray(raw)) fail('samples must be an array');
  if (raw.length === 0) fail('needs at least one sample');

  const samples: PoseSample[] = [];
  let prevT = -Infinity;
  for (const [i, s] of (raw as unknown[]).entries()) {
    const r = PoseSample.safeParse(s);
    if (!r.success) fail(`sample ${i} ${describeIssue(r.error.issues[0])}`);
    const v = r.data;
    if (v.t < prevT) fail(`samples are not sorted by time (sample ${i} at t=${v.t} ms)`);
    prevT = v.t;
    samples.push({ ...v, q: normaliseQuat(v.q, i) });
  }
  const last = samples[samples.length - 1];
  return {
    schema: 'aio.flight/1',
    startUtcMs: start,
    lens: lens.data,
    samples: opts.raw ? samples : normaliseSamples(samples),
    durationMs: last ? last.t : 0,
  };
}
