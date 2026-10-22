/** Pure, bounded model correction transactions. No scene, disk, source re-fit or network access. */
import {
  CorrectionProposalInput,
  ModelCorrection,
  ModelCorrectionInput,
  MODEL_WIDE_PATCH_LIMIT,
  ProcModel,
  type Assembly,
  type CorrectionPatch,
  type CorrectionTarget,
} from '@aio/schema';
import { ctxFor } from './builders/ctx';
import { MeshSink, SEGMENTS } from './geom';
import { buildAssembly } from './meshAssemblies';

/** Canonical JSON: object key order is irrelevant, array/assembly order remains meaningful. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** SHA-256 binds every model field except the save timestamp, including geometry, statuses and frame. */
export async function modelCorrectionFingerprint(model: ProcModel): Promise<string> {
  const content: Record<string, unknown> = ProcModel.parse(model);
  delete content.updatedAt;
  const bytes = new TextEncoder().encode(canonical(content));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

type Matrix16 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function hasMatrixValues(matrix: readonly number[]): matrix is Matrix16 {
  return matrix.length === 16 && Array.from(matrix).every(Number.isFinite);
}

/** Why a location pin cannot be placed on this model, or null when it can. */
export function pinTargetRefusal(model: ProcModel): string | null {
  const frame = model.georef;
  if (!frame || frame.horizontal.status === 'unplaced')
    return 'A location pin needs a known model placement and coordinate frame.';
  if (!model.scale || model.scale.status === 'provisional' || frame.scale.status === 'provisional')
    return 'A location pin needs a known model scale.';
  // An unknown absolute height datum does not make source-aligned local coordinates unknown.
  // Keep that datum explicitly unknown; only require a usable, invertible affine local frame.
  const m = frame.modelToCrs;
  if (!hasMatrixValues(m)) return 'A location pin needs sixteen finite model transform values.';
  const determinant =
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (
    !Number.isFinite(determinant) ||
    Math.abs(determinant) < 1e-12 ||
    Math.abs(m[3]) > 1e-9 ||
    Math.abs(m[7]) > 1e-9 ||
    Math.abs(m[11]) > 1e-9 ||
    Math.abs(m[15] - 1) > 1e-9
  )
    return 'A location pin needs an invertible affine model coordinate frame.';
  return null;
}

function validateTarget(model: ProcModel, target: CorrectionTarget): void {
  if (target.kind === 'model') return;
  if (target.kind === 'part') {
    if (!model.assemblies.some((a) => a.id === target.partId))
      throw new Error('The correction target is not an engineering component in this model.');
    return;
  }
  const refusal = pinTargetRefusal(model);
  if (refusal) throw new Error(refusal);
}

type Vec3Tuple = [number, number, number];
export interface CorrectionBounds {
  min: Vec3Tuple;
  max: Vec3Tuple;
}

/**
 * Grow a box about its centre: each half-extent by 10%, each floored at 5% of the longest
 * half-extent, so a flat model still leaves room for additions.
 */
export function growCorrectionBox(
  [x0, y0, z0]: readonly [number, number, number],
  [x1, y1, z1]: readonly [number, number, number],
): CorrectionBounds {
  const longest = Math.max(x1 - x0, y1 - y0, z1 - z0) / 2;
  const grow = (lo: number, hi: number): [number, number] => {
    const centre = (lo + hi) / 2;
    const half = Math.max(((hi - lo) / 2) * 1.1, longest * 0.05);
    return [centre - half, centre + half];
  };
  const [gx0, gx1] = grow(x0, x1);
  const [gy0, gy1] = grow(y0, y1);
  const [gz0, gz1] = grow(z0, z1);
  return { min: [gx0, gy0, gz0], max: [gx1, gy1, gz1] };
}

/** Built vertices of `assemblies` at standard detail, in model-local metres. */
function* builtVertices(model: ProcModel, assemblies: readonly Assembly[]): Generator<Vec3Tuple> {
  const sink = new MeshSink(SEGMENTS.standard);
  const ctx = ctxFor(model);
  for (const a of assemblies) buildAssembly(sink, a, ctx);
  for (const prim of sink.out())
    for (let i = 0; i < prim.positions.length; i += 3)
      yield [prim.positions[i] ?? NaN, prim.positions[i + 1] ?? NaN, prim.positions[i + 2] ?? NaN];
}

/** The box a model-wide addition must fit in: the base model's built geometry, grown (or null). */
export function modelCorrectionBounds(model: ProcModel): CorrectionBounds | null {
  let min: Vec3Tuple = [Infinity, Infinity, Infinity];
  let max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
  let vertices = 0;
  for (const [x, y, z] of builtVertices(
    model,
    model.assemblies.filter((a) => a.status !== 'rejected'),
  )) {
    if (!Number.isFinite(x + y + z)) continue;
    min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
    max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];
    vertices++;
  }
  return vertices === 0 ? null : growCorrectionBox(min, max);
}

/** Verify every generated vertex of a model-wide addition lies inside the grown model box. */
function checkWithinBounds(model: ProcModel, a: Assembly, { min, max }: CorrectionBounds): void {
  const tol = 1e-6;
  let vertices = 0;
  for (const [x, y, z] of builtVertices(model, [a])) {
    if (
      !Number.isFinite(x + y + z) ||
      x < min[0] - tol ||
      y < min[1] - tol ||
      z < min[2] - tol ||
      x > max[0] + tol ||
      y > max[1] + tol ||
      z > max[2] + tol
    )
      throw new Error('Added geometry lies outside the model bounds.');
    vertices++;
  }
  if (vertices === 0) throw new Error('The correction must produce visible geometry.');
}

export async function createModelCorrection(
  model: ProcModel,
  input: ModelCorrectionInput,
  now: string,
): Promise<ModelCorrection> {
  const m = ProcModel.parse(model);
  const parsed = ModelCorrectionInput.parse(input);
  validateTarget(m, parsed.target);
  return ModelCorrection.parse({
    ...parsed,
    modelId: m.id,
    baseFingerprint: await modelCorrectionFingerprint(m),
    createdAt: now,
    updatedAt: now,
    status: 'open',
    replies: [],
    history: [],
  });
}

async function checkBase(model: ProcModel, request: ModelCorrection): Promise<void> {
  if (
    model.id !== request.modelId ||
    (await modelCorrectionFingerprint(model)) !== request.baseFingerprint
  )
    throw new Error(
      'This correction is stale: the model changed. Reopen it on the current model before proposing again.',
    );
  validateTarget(model, request.target);
}

function geometricReference(a: Assembly): string | undefined {
  if (a.kind === 'band' || a.kind === 'ringPlatform') return a.params.shaft;
  if (a.kind === 'guardrail' && !Array.isArray(a.params.path)) return a.params.path.shaft;
  return undefined;
}

/** Correction text is not a new source fit: reset only the values this proposal actually changes. */
function correctionQuality(a: Assembly, before: Assembly | undefined, accepted: boolean): Assembly {
  const params = a.params as Record<string, unknown>;
  const oldParams = before?.params as Record<string, unknown> | undefined;
  const quality: Assembly['quality'] = Object.fromEntries(
    Object.entries(structuredClone(before?.quality ?? {})).filter(([key]) => key in params),
  );
  for (const key of Object.keys(params)) {
    if (before && canonical(params[key]) === canonical(oldParams?.[key])) continue;
    quality[key] = accepted
      ? { basis: 'user', note: 'Human-reviewed correction proposal' }
      : { basis: 'inferred', note: 'Proposed correction; measurement not revalidated' };
  }
  return { ...structuredClone(a), quality };
}

function proposedPatch(model: ProcModel, patch: CorrectionPatch): CorrectionPatch {
  return patch.map((edit) =>
    edit.op === 'remove'
      ? edit
      : {
          ...edit,
          assembly: correctionQuality(
            edit.assembly,
            edit.op === 'replace'
              ? model.assemblies.find((a) => a.id === edit.assembly.id)
              : undefined,
            false,
          ),
        },
  );
}

/** Verify real generated vertices, not merely a centre that could hide an oversized addition. */
function checkPinnedGeometry(
  model: ProcModel,
  a: Assembly,
  target: Extract<CorrectionTarget, { kind: 'pin' }>,
): void {
  const withinPin = (point: readonly number[]): boolean =>
    point.length === 3 &&
    Math.hypot(
      (point[0] ?? Infinity) - target.position[0],
      (point[1] ?? Infinity) - target.position[1],
      (point[2] ?? Infinity) - target.position[2],
    ) <=
      target.radiusM + 1e-6;
  const point = (value: unknown): void => {
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((v) => typeof v === 'number') &&
      !withinPin(value)
    )
      throw new Error('Added geometry lies outside the location pin radius.');
  };
  // Refuse obviously oversized lengths before builders allocate tessellation for grids/rails.
  const lengths = new Set([
    'height',
    'r',
    'rInner',
    'rOuter',
    'width',
    'span',
    'diameter',
    'widthBase',
    'widthTop',
  ]);
  for (const [key, value] of Object.entries(a.params)) {
    if (lengths.has(key) && typeof value === 'number' && value > target.radiusM * 2)
      throw new Error('Added geometry exceeds the location pin radius.');
    if (
      key === 'size' &&
      Array.isArray(value) &&
      value.some((v) => typeof v === 'number' && v > target.radiusM * 2)
    )
      throw new Error('Added geometry exceeds the location pin radius.');
    if (['base', 'centre', 'bottom', 'top', 'anchor'].includes(key)) point(value);
    if (['path', 'steps'].includes(key) && Array.isArray(value)) value.forEach(point);
    if (key === 'profile' && Array.isArray(value))
      for (const row of value as { y: number; r: number }[])
        if (Math.abs(row.y) > target.radiusM * 2 || row.r > target.radiusM * 2)
          throw new Error('Added profile geometry exceeds the location pin radius.');
  }
  if (a.kind === 'deck' || a.kind === 'base') {
    const p = a.params;
    if (Array.isArray(p.outline))
      for (const vertex of p.outline) point([vertex[0], p.y, vertex[1]]);
    else if (p.outline.r > target.radiusM)
      throw new Error('Added outline exceeds the location pin radius.');
  }
  if (a.kind === 'deck' && a.params.roofPanels)
    for (const panel of a.params.roofPanels) panel.forEach(point);
  if (a.kind === 'guardrail' && !Array.isArray(a.params.path) && a.params.path.r > target.radiusM)
    throw new Error('Added guardrail exceeds the location pin radius.');
  const sink = new MeshSink(SEGMENTS.standard);
  buildAssembly(sink, a, ctxFor(model));
  let vertices = 0;
  for (const prim of sink.out()) {
    for (let i = 0; i < prim.positions.length; i += 3) {
      const x = prim.positions[i];
      const y = prim.positions[i + 1];
      const z = prim.positions[i + 2];
      if (
        x === undefined ||
        y === undefined ||
        z === undefined ||
        !Number.isFinite(x + y + z) ||
        Math.hypot(x - target.position[0], y - target.position[1], z - target.position[2]) >
          target.radiusM + 1e-6
      )
        throw new Error('Added geometry lies outside the location pin radius.');
      vertices++;
    }
  }
  if (vertices === 0) throw new Error('The correction must produce visible geometry.');
}

function applyPatch(
  model: ProcModel,
  request: ModelCorrection,
  patch: CorrectionPatch,
): { candidate: ProcModel; before: Assembly[] } {
  const current = new Map(model.assemblies.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const before: Assembly[] = [];
  const replacement = new Map<string, Assembly>();
  const removed = new Set<string>();
  const added: Assembly[] = [];
  if (request.target.kind === 'model' && patch.length > MODEL_WIDE_PATCH_LIMIT)
    throw new Error(
      `A model-wide correction may change at most ${MODEL_WIDE_PATCH_LIMIT} components.`,
    );
  for (const edit of patch) {
    const id = edit.op === 'remove' ? edit.id : edit.assembly.id;
    if (seen.has(id)) throw new Error('A correction may change each component only once.');
    seen.add(id);
    if (request.target.kind === 'model') {
      // A model-wide request may remove, replace or add anywhere; additions are bounded below.
    } else if (request.target.kind === 'part') {
      if (edit.op === 'add' || id !== request.target.partId)
        throw new Error('The proposal is outside the selected component target scope.');
    } else if (edit.op !== 'add') {
      throw new Error(
        'A location pin permits additions only; select an existing component to change it.',
      );
    }
    if (edit.op === 'add') {
      if (current.has(id) || model.parts.some((p) => p.id === id))
        throw new Error('An added component needs a new, unique id.');
      added.push(structuredClone(edit.assembly));
      continue;
    }
    const prior = current.get(id);
    if (!prior) throw new Error('The requested component no longer exists.');
    before.push(structuredClone(prior));
    if (edit.op === 'remove') removed.add(id);
    else {
      if (canonical(prior) === canonical(edit.assembly))
        throw new Error('The proposal makes no change to the component.');
      if (
        model.assemblies.some((a) => a.id !== id && geometricReference(a) === id) &&
        canonical(prior.params) !== canonical(edit.assembly.params)
      )
        throw new Error(
          'This change would move dependent, unrelated geometry. Review those components together in a future grouped correction.',
        );
      replacement.set(id, structuredClone(edit.assembly));
    }
  }
  // Schema validation refuses dangling parents, cycles, missing shafts and unknown materials.
  const candidate = ProcModel.parse({
    ...structuredClone(model),
    assemblies: [
      ...model.assemblies
        .filter((a) => !removed.has(a.id))
        .map((a) => structuredClone(replacement.get(a.id) ?? a)),
      ...added,
    ],
  });
  if (request.target.kind === 'pin')
    for (const a of added) checkPinnedGeometry(candidate, a, request.target);
  if (request.target.kind === 'model' && added.length > 0) {
    const bounds = modelCorrectionBounds(model);
    if (!bounds) throw new Error('A model-wide addition needs a model with visible geometry.');
    for (const a of added) checkWithinBounds(candidate, a, bounds);
  }
  return { candidate, before };
}

export async function proposeModelCorrection(
  model: ProcModel,
  request: ModelCorrection,
  input: CorrectionProposalInput,
  now: string,
): Promise<{ request: ModelCorrection; candidate: ProcModel }> {
  const checked = ModelCorrection.parse(request);
  if (checked.status !== 'open')
    throw new Error('Reopen the correction before replacing a reviewed proposal.');
  await checkBase(model, checked);
  const inputProposal = CorrectionProposalInput.parse(input);
  const proposal = { ...inputProposal, patch: proposedPatch(model, inputProposal.patch) };
  const { candidate, before } = applyPatch(model, checked, proposal.patch);
  return {
    request: ModelCorrection.parse({
      ...checked,
      status: 'proposed',
      updatedAt: now,
      proposal: {
        ...proposal,
        before,
        createdAt: now,
        candidateFingerprint: await modelCorrectionFingerprint(candidate),
      },
    }),
    candidate,
  };
}

/** Reconstruct the exact reviewed candidate from the current model, refusing stale or altered records. */
export async function buildCorrectionCandidate(
  model: ProcModel,
  request: ModelCorrection,
): Promise<ProcModel> {
  const checked = ModelCorrection.parse(request);
  if (checked.status !== 'proposed' || !checked.proposal)
    throw new Error('Only a proposed correction has a review candidate.');
  await checkBase(model, checked);
  const { candidate, before } = applyPatch(model, checked, checked.proposal.patch);
  if (canonical(before) !== canonical(checked.proposal.before))
    throw new Error('The saved before snapshots do not match the current model.');
  if ((await modelCorrectionFingerprint(candidate)) !== checked.proposal.candidateFingerprint)
    throw new Error('The saved candidate fingerprint does not match the proposed changes.');
  return candidate;
}

export async function acceptModelCorrection(
  model: ProcModel,
  request: ModelCorrection,
  now: string,
): Promise<{ request: ModelCorrection; model: ProcModel }> {
  const checked = ModelCorrection.parse(request);
  const candidate = await buildCorrectionCandidate(model, checked);
  const affected = new Set(
    checked.proposal?.patch.filter((e) => e.op !== 'remove').map((e) => e.assembly.id),
  );
  const before = new Map(checked.proposal?.before.map((a) => [a.id, a]));
  return {
    request: ModelCorrection.parse({ ...checked, status: 'accepted', updatedAt: now }),
    model: ProcModel.parse({
      ...candidate,
      updatedAt: now,
      assemblies: candidate.assemblies.map((a) =>
        affected.has(a.id)
          ? { ...correctionQuality(a, before.get(a.id), true), status: 'accepted' }
          : a,
      ),
    }),
  };
}

export function rejectModelCorrection(request: ModelCorrection, now: string): ModelCorrection {
  const checked = ModelCorrection.parse(request);
  if (checked.status === 'accepted' || checked.status === 'rejected')
    throw new Error('This correction already has a review decision.');
  return ModelCorrection.parse({ ...checked, status: 'rejected', updatedAt: now });
}

export function replyToModelCorrection(
  request: ModelCorrection,
  comment: string,
  now: string,
): ModelCorrection {
  const checked = ModelCorrection.parse(request);
  return ModelCorrection.parse({
    ...checked,
    updatedAt: now,
    replies: [...checked.replies, { comment, createdAt: now }],
  });
}

/** Explicit human reopen: preserve old proposals, then bind the next attempt to today's model. */
export async function rebaseModelCorrection(
  model: ProcModel,
  request: ModelCorrection,
  now: string,
): Promise<ModelCorrection> {
  return ModelCorrection.parse(await rebasedRecord(model, ModelCorrection.parse(request), now));
}

const HISTORY_LIMIT = 8;
const REPLY_LIMIT = 32;
const RECORD_LIMIT = 256_000;

/**
 * Reopen in one step: add the reply (when given), then rebase as `rebaseModelCorrection`. Never
 * refused for the caps: the oldest round and the oldest reply make room, and if the record
 * would still exceed its size limit the oldest rounds, then the oldest replies, are dropped.
 */
export async function resendModelCorrection(
  model: ProcModel,
  request: ModelCorrection,
  reply: string | undefined,
  now: string,
): Promise<ModelCorrection> {
  const checked = ModelCorrection.parse(request);
  if (checked.status === 'accepted')
    throw new Error('Create a new request to change an accepted correction.');
  const trimmed: ModelCorrection = {
    ...checked,
    history:
      checked.proposal && checked.history.length >= HISTORY_LIMIT
        ? checked.history.slice(checked.history.length - HISTORY_LIMIT + 1)
        : checked.history,
    replies:
      reply !== undefined
        ? [
            ...checked.replies.slice(Math.max(0, checked.replies.length - REPLY_LIMIT + 1)),
            { comment: reply, createdAt: now },
          ]
        : checked.replies,
  };
  const record = await rebasedRecord(model, trimmed, now);
  while (JSON.stringify(record).length > RECORD_LIMIT) {
    if (record.history.length > 0) record.history = record.history.slice(1);
    else if (record.replies.length > 0) record.replies = record.replies.slice(1);
    else break;
  }
  return ModelCorrection.parse(record);
}

/** The rebased record, not yet parsed, so a caller can trim it to fit before validation. */
async function rebasedRecord(
  model: ProcModel,
  checked: ModelCorrection,
  now: string,
): Promise<ModelCorrection> {
  if (checked.status === 'accepted')
    throw new Error('Create a new request to change an accepted correction.');
  if (model.id !== checked.modelId) throw new Error('The correction belongs to another model.');
  validateTarget(ProcModel.parse(model), checked.target);
  const { proposal, ...rest } = checked;
  return {
    ...rest,
    updatedAt: now,
    status: 'open',
    baseFingerprint: await modelCorrectionFingerprint(model),
    history: proposal
      ? [
          ...checked.history,
          {
            proposal,
            disposition: checked.status === 'rejected' ? 'rejected' : 'superseded',
            at: now,
          },
        ]
      : checked.history,
  };
}
