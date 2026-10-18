import {
  acceptModelCorrection,
  buildCorrectionCandidate,
  createModelCorrection,
  meshAssemblies,
  proposeModelCorrection,
  rebaseModelCorrection,
  rejectModelCorrection,
  replyToModelCorrection,
} from '@aio/modelling';
import type {
  CorrectionProposalInput,
  EngineerRun,
  ModelCorrection,
  ModelCorrectionInput,
  ProcModel,
} from '@aio/schema';

export interface CorrectionContext {
  projectId: string;
  run: EngineerRun;
  model: ProcModel;
  busy: boolean;
  save(requests: ModelCorrection[], model?: ProcModel, expected?: ProcModel): Promise<void>;
}

/** Uses the current project at each boundary. No source uploads or provider calls occur here. */
export function createCorrectionSession(
  access: () => CorrectionContext | null,
  now = () => new Date().toISOString(),
) {
  const current = (write = false) => {
    const ctx = access();
    if (!ctx) throw new Error('Open an editable engineering model first.');
    if (write && ctx.busy) throw new Error('Wait for the current modelling operation to finish.');
    return ctx;
  };
  const unchanged = (ctx: CorrectionContext) => {
    const next = current(true);
    if (next.projectId !== ctx.projectId || next.run !== ctx.run || next.model !== ctx.model)
      throw new Error('The project or model changed. Open the request again.');
  };
  const find = (ctx: CorrectionContext, id: string) => {
    const r = ctx.run.corrections?.find((r) => r.id === id);
    if (!r) throw new Error('This correction request is no longer available.');
    return r;
  };
  const save = async (ctx: CorrectionContext, request: ModelCorrection, model?: ProcModel) => {
    unchanged(ctx);
    const requests = ctx.run.corrections ?? [];
    await ctx.save(
      requests.some((r) => r.id === request.id)
        ? requests.map((r) => (r.id === request.id ? request : r))
        : [...requests, request],
      model,
      ctx.model,
    );
  };
  return {
    submission(ids: readonly string[]) {
      const { projectId, model, run } = current();
      if (!ids.length || ids.length > 10)
        throw new Error('Choose between one and ten correction requests.');
      const requests = [...new Set(ids)].map((id) => find(current(), id));
      if (requests.some((r) => r.status !== 'open' && r.status !== 'proposed'))
        throw new Error('Only open correction requests can be sent.');
      const selected = new Set(
        requests.flatMap((r) => (r.target.kind === 'part' ? [r.target.partId] : [])),
      );
      const data = {
        modelId: model.id,
        requests: requests.map(({ id, target, comment, evidence, replies, baseFingerprint }) => ({
          id,
          target,
          comment,
          evidence,
          replies,
          baseFingerprint,
        })),
        materials: model.materials,
        coordinateFrame:
          'Assembly coordinates are model-local metres. Pin projectPosition is display only.',
        components: model.assemblies.filter((a) => selected.has(a.id)),
      };
      const refs = model.assemblies.flatMap((a) => a.sources);
      return {
        projectId,
        runId: run.id,
        model,
        data,
        required: {
          drawings:
            (run.setup.sources.drawings?.length ?? 0) > 0 ||
            model.sources?.some((s) => s.kind === 'drawing' || s.kind === 'plan') === true ||
            refs.some((s) => s.kind === 'drawing') ||
            requests.some((r) => r.evidence?.some((s) => s.kind === 'drawing')),
          scans:
            run.setup.sources.clouds.length > 0 ||
            run.setup.sources.meshes.length > 0 ||
            refs.some((s) => s.kind === 'cloud' || s.kind === 'mesh') ||
            requests.some((r) => r.target.kind === 'pin'),
          photos:
            run.setup.sources.photos.length > 0 ||
            refs.some((s) => s.kind === 'photo') ||
            requests.some((r) => r.evidence?.some((s) => s.kind === 'photo')),
        },
      };
    },
    async create(input: ModelCorrectionInput) {
      const ctx = current(true);
      if (ctx.run.corrections?.some((r) => r.id === input.id))
        throw new Error('A request already uses this ID.');
      const request = await createModelCorrection(ctx.model, input, now());
      await save(ctx, request);
      return request;
    },
    async propose(id: string, input: CorrectionProposalInput) {
      const ctx = current(true);
      const result = await proposeModelCorrection(ctx.model, find(ctx, id), input, now());
      const mesh = meshAssemblies(result.candidate, {
        detail: 'standard',
        include: (a) => a.status !== 'rejected',
      });
      if (mesh.failed.length)
        throw new Error(
          `The proposed geometry could not be built: ${mesh.failed.map((x) => x.id).join(', ')}`,
        );
      await save(ctx, result.request);
      return {
        requestId: id,
        status: 'proposed',
        changed: input.patch.map((p) => (p.op === 'remove' ? p.id : p.assembly.id)),
        next: 'The person must compare Before and After and accept or reject in Corrections. The current model has not changed.',
      };
    },
    async candidate(id: string) {
      const ctx = current();
      const candidate = await buildCorrectionCandidate(ctx.model, find(ctx, id));
      unchanged(ctx);
      return candidate;
    },
    async accept(id: string) {
      const ctx = current(true);
      const result = await acceptModelCorrection(ctx.model, find(ctx, id), now());
      await save(ctx, result.request, result.model);
    },
    async reject(id: string) {
      const ctx = current(true);
      await save(ctx, rejectModelCorrection(find(ctx, id), now()));
    },
    async reply(id: string, comment: string) {
      const ctx = current(true);
      const replied = replyToModelCorrection(find(ctx, id), comment, now());
      const request = await rebaseModelCorrection(ctx.model, replied, now());
      await save(ctx, request);
    },
  };
}

export type CorrectionSession = ReturnType<typeof createCorrectionSession>;
