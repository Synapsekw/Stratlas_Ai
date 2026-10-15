/**
 * The engineering model run (spec 5.2): one store drives the six stages of a run and keeps them
 * resumable. Each stage writes `engineering/<run>/run.json` (through `engineer:runWrite`) with the
 * hash of its inputs; reopening a run skips every stage whose inputs hash the same, so a finished
 * measuring job is never queued again and a paid AI reply is never asked for again (main also
 * caches each reply by its content key).
 *
 * 1. inspect: the `model.evidence` job (its id in the stage `output`, so a retry resumes it).
 * 2. estimate: `evidence.json`, read and checked.
 * 3. identify: one structured request per pass (fast 1, standard 2, detailed 3; passes 2 and 3
 *    carry generated views of the draft when the renderer can make them). Every request waits for
 *    the person at the send preview. Offline, refused or declined: skipped with the reason, the
 *    draft is measured-only. An identity conflict stops here with the flagged images.
 * 4. generate: the deterministic assembler, the model's georeference from the setup's placement,
 *    `model:write`.
 * 5. validate: the draft GLB and its layer (`model:build`, draft), the file checks in main
 *    (`engineer:validate`), and the silhouette overlap when the renderer computes it.
 * 6. review: ready.
 *
 * Cancel stops the job, the AI request or a waiting preview and leaves completed stages done.
 * Accept builds the one layer `model-<id>` (idempotent, checked in main). What crosses IPC is
 * bounded: the evidence images go as data URLs main read and scaled down (at most 1568 px each,
 * the pack's own limit on how many), the summary is compact text, and the model a bounded JSON
 * record; never a typed array or a cloud.
 */
import {
  ENGINEER_PROMPT_VERSION,
  routeFor,
  type EvidencePreviewContent,
  type ModelRoute,
} from '@aio/ai';
import { layerTransformToGeoref, localToProject } from '@aio/geo';
import { assemble, type AssembleResult, type UserOverrides } from '@aio/modelling';
import { t } from '@aio/ui';
import {
  DETAIL_BUDGETS,
  type EngineerProposal,
  type EngineerRun,
  type EngineerSetup,
  type EngineerStage,
  type EvidencePack,
  type Georef,
  type GlbBuildReport,
  type GlbCheckReport,
  type IpcRequest,
  type IpcResponse,
  type JobRecord,
  type ModelEvidenceParamsInput,
  type ModelFamily,
  type ProcModel,
  type Vec3,
} from '@aio/schema';
import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
import type { EngineerModelSession } from '../modeller/engineerTools';
import { measurementSummary } from './summary';

export const STAGES: readonly EngineerStage[] = [
  'inspect',
  'estimate',
  'identify',
  'generate',
  'validate',
  'review',
];

/** The run's messages, in the person's language (read when shown, so a locale change applies). */
export const runText = {
  offline: () => t('eng.msg.offline'),
  declined: () => t('eng.msg.declined'),
  noSources: () => t('eng.msg.noSources'),
  noRun: () => t('eng.msg.noRun'),
  jobFailed: () => t('eng.msg.jobFailed'),
  jobGone: () => t('eng.msg.jobGone'),
  noEvidence: () => t('eng.msg.noEvidence'),
  height: (m: string) => t('eng.msg.height', { m }),
  notPrepared: () => t('eng.msg.notPrepared'),
  costCap: () => t('eng.msg.costCap'),
  conflict: (ids: string) => t('eng.msg.conflict', { ids }),
  correctionDropped: (pass: number, after: string, before: string) =>
    t('eng.msg.correctionDropped', { pass, after, before }),
  noDraft: () => t('eng.msg.noDraft'),
  validatorErrors: (n: number) => t('eng.msg.validatorErrors', { count: n }),
  notFinite: () => t('eng.msg.notFinite'),
  badIndices: () => t('eng.msg.badIndices'),
  overBudget: () => t('eng.msg.overBudget'),
  notBuilt: (n: number) => t('eng.msg.notBuilt', { count: n }),
  check: (list: string) => t('eng.msg.check', { list }),
  cancelled: () => t('eng.msg.cancelled'),
  noSuchRun: (id: string) => t('eng.msg.noSuchRun', { id }),
  nothingToAccept: () => t('eng.msg.nothingToAccept'),
  busy: () => t('eng.msg.busy'),
};

/** English texts some callers compare with (tests); the store itself uses `runText`. */
export const OFFLINE_IDENTIFY = 'Needs a vision model. Offline mode is on, so nothing is sent.';
export const DECLINED_IDENTIFY =
  'Nothing was sent: the send was declined. The draft is measured only.';
export const NO_SOURCES = 'Choose a point cloud, a mesh or photos to measure first.';

type EngineerCall = IpcRequest<'ai:engineerPreview'>;
type EngineerCallImage = EngineerCall['images'][number];
type PreviewResponse = IpcResponse<'ai:engineerPreview'>;
type EngineerOutcome = IpcResponse<'ai:engineer'>;
type StageState = NonNullable<EngineerRun['stages'][EngineerStage]>;

/** A generated view of the draft for passes 2 and 3. */
export type GeneratedView = EngineerCallImage & { kind: 'generated' };

/** The IPC a run needs, as plain promises (errors thrown as `Error` with a readable message). */
export interface RunIpc {
  /** The model route the engineer step uses now (Settings), or null when none is set. */
  route(): Promise<ModelRoute | null>;
  runRead(runId: string): Promise<{
    run: EngineerRun | null;
    evidence: EvidencePack | null;
    proposal: EngineerProposal | null;
  }>;
  runWrite(run: EngineerRun, proposal?: EngineerProposal): Promise<void>;
  evidenceImage(runId: string, imageId: string): Promise<string>;
  preview(req: EngineerCall): Promise<PreviewResponse>;
  engineer(req: IpcRequest<'ai:engineer'>): Promise<EngineerOutcome>;
  cancel(aiRunId: string): Promise<void>;
  /** Start `model.evidence` (params) or resume a stopped job (`{ resume }`). */
  enqueueJob(req: { params: ModelEvidenceParamsInput } | { resume: string }): Promise<JobRecord>;
  jobStatus(jobId: string): Promise<JobRecord | null>;
  cancelJob(jobId: string): Promise<void>;
  modelRead(id: string): Promise<ProcModel | null>;
  modelWrite(model: ProcModel): Promise<void>;
  modelBuild(id: string, draft: boolean): Promise<{ layer: string; report?: GlbBuildReport }>;
  validate(id: string, draft: boolean, detail: EngineerSetup['detail']): Promise<GlbCheckReport>;
  accept(id: string): Promise<{ layer: string }>;
  setCloudEvidence(o: { photos?: boolean; scans?: boolean }): Promise<void>;
}

export interface RunDeps {
  ipc: RunIpc;
  project: { crs: { epsg: number } | { wkt: string }; origin: Vec3 };
  now(): string;
  online(): boolean;
  sleep?(ms: number): Promise<void>;
  newRunId?(): string;
  /** Generated views of the draft for passes 2 and 3 (engine offscreen snapshot). */
  renderViews?(model: ProcModel, views: { id: string; view: string }[]): Promise<GeneratedView[]>;
  /** Silhouette IoU per side view (draft renders against the pack's side renders). */
  silhouette?(model: ProcModel, evidence: EvidencePack): Promise<Record<string, number>>;
}

export interface PendingPreview {
  pass: number;
  route: ModelRoute;
  cloud: boolean;
  flags: { photos: boolean; scans: boolean };
  estimateUsd?: number;
  content: EvidencePreviewContent;
}

export interface RunState {
  run: EngineerRun | null;
  evidence: EvidencePack | null;
  proposal: EngineerProposal | null;
  model: ProcModel | null;
  build: GlbBuildReport | null;
  report: GlbCheckReport | null;
  silhouette: Record<string, number> | null;
  stage: EngineerStage | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  conflicts: { imageIds: string[]; reason: string }[];
  excludedImages: string[];
  unresolved: string[];
  flagged: { id: string; reason: string }[];
  preview: PendingPreview | null;
  layer: string | null;
  draftLayer: string | null;
  /** The person's corrections the draft was last assembled with (kept in run.json). */
  user: UserOverrides;
  start(setup: EngineerSetup, o?: { modelId?: string; runId?: string }): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  rebuild(user: UserOverrides): Promise<void>;
  accept(): Promise<void>;
  sendPreview(o: { once: { photos: boolean; scans: boolean }; costConfirmed: boolean }): void;
  declinePreview(): void;
  allowProject(kind: 'photos' | 'scans'): Promise<void>;
  dropImages(ids: string[]): Promise<void>;
  /** The draft on screen and its corrections, or null (the agent's `EngineerModelSession`). */
  current(): { model: ProcModel; user: UserOverrides } | null;
  /** Set the review status of components or parts, save the model; the saved model. */
  setStatus(
    ids: string[],
    status: 'draft' | 'accepted' | 'rejected',
  ): Promise<ProcModel | { error: string }>;
  /** This run as the agent's `EngineerModelSession` (`setEngineerSession`). */
  session(): EngineerModelSession;
}

/** No corrections. */
export const NO_OVERRIDES: UserOverrides = {
  params: {},
  counts: {},
  levels: {},
  removed: [],
  added: [],
};

class Cancelled extends Error {}
class StageFailed extends Error {}

/** The proposal format of the engineer request (`@aio/ai` engineer.ts), part of the identify hash. */
const PROPOSAL_FORMAT = 'proposal-1';

/** SHA-256 of the JSON of `v`, lower-case hex. */
export async function hashOf(v: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(v));
  const d = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `run-20261015t101500-ab12`: a run id from the time and a little randomness. */
export function newRunIdAt(iso: string): string {
  const t = iso.replace(/[-:.]/g, '').replace(/z$/i, '').toLowerCase().slice(0, 15);
  const r = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `run-${t}-${r}`;
}

/** Bytes a base64 data URL decodes to. */
function dataUrlBytes(url: string): number {
  const b64 = url.slice(url.indexOf(',') + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * The model's georeference. The model is built in the project's local frame; its statuses say how
 * far its place is known. A cloud measured in the project CRS places it from the source; photos
 * alone, or "unplaced", leave it unplaced (accepted provisionally). "At a point I pick": the
 * model's base goes to the picked anchor (a measured base is moved there; a model built without a
 * measured base already stands on it), the record's anchor is that point in project E, N, H, and
 * only then is the horizontal placement the person's (`user`).
 */
export function georefFor(
  model: ProcModel,
  setup: EngineerSetup,
  evidence: EvidencePack | null,
  project: RunDeps['project'],
): Georef {
  const metric = (evidence?.samples.kept ?? 0) > 0;
  const anchor = setup.placement === 'anchor' ? setup.anchor : undefined;
  // where the assembler stood the model: the measured base, else the anchor, else the origin
  const measuredBase = metric ? (evidence?.base ?? evidence?.axis?.point) : undefined;
  const shift: Vec3 =
    anchor && measuredBase
      ? [anchor[0] - measuredBase[0], anchor[1] - measuredBase[1], anchor[2] - measuredBase[2]]
      : [0, 0, 0];
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...shift, 1];
  const g = layerTransformToGeoref(transform, project, null, 'engineer');
  const horizontal: Georef['horizontal']['status'] = anchor
    ? 'user'
    : setup.placement === 'from-source' && metric
      ? 'from-source'
      : 'unplaced';
  if (anchor) g.anchor = localToProject([anchor[0], anchor[1], anchor[2]], project.origin);
  const scale = model.scale?.status ?? 'provisional';
  return {
    ...g,
    heading: { deg: g.heading.deg, status: metric ? 'measured' : 'assumed-grid' },
    scale: {
      factor: g.scale.factor,
      status:
        scale === 'measured' ? 'measured' : scale === 'reference' ? 'reference' : 'provisional',
    },
    horizontal: { status: horizontal },
  };
}

export function createRunStore(deps: RunDeps): StoreApi<RunState> {
  const sleep = (ms: number): Promise<void> =>
    deps.sleep ? deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  /** Bumped by cancel: a drive that sees another value stops. */
  let token = 0;
  let driving: Promise<void> | null = null;
  let jobId: string | null = null;
  let aiRun: string | null = null;
  let calls = 0;
  let answer: ((a: 'send' | 'decline' | 'cancel', o?: SendChoice) => void) | null = null;
  let user: UserOverrides = NO_OVERRIDES;
  let assembled: AssembleResult | null = null;

  interface SendChoice {
    once: { photos: boolean; scans: boolean };
    costConfirmed: boolean;
  }

  const store = createStore<RunState>()((set, get) => {
    const check = (t: number) => {
      if (t !== token) throw new Cancelled('cancelled');
    };

    const mustRun = (): EngineerRun => {
      const r = get().run;
      if (!r) throw new StageFailed(runText.noRun());
      return r;
    };

    async function saveStage(
      s: EngineerStage,
      state: StageState,
      proposal?: EngineerProposal,
    ): Promise<void> {
      const run = mustRun();
      const next: EngineerRun = { ...run, stages: { ...run.stages, [s]: state } };
      await deps.ipc.runWrite(next, proposal);
      set({ run: next });
    }

    async function saveRun(next: EngineerRun): Promise<void> {
      await deps.ipc.runWrite(next);
      set({ run: next });
    }

    const statusOf = (s: EngineerStage) => get().run?.stages[s];
    const fresh = (s: EngineerStage, hash: string) =>
      statusOf(s)?.status === 'done' && statusOf(s)?.hash === hash;

    // ---------------------------------------------------------------- stages

    async function inspect(t: number): Promise<void> {
      const setup = mustRun().setup;
      const hash = await hashOf({ s: setup.sources, r: setup.region, d: setup.detail });
      if (fresh('inspect', hash) && get().evidence) return;
      const { clouds, meshes, photos } = setup.sources;
      if (clouds.length + meshes.length + photos.length === 0)
        throw new StageFailed(runText.noSources());
      const known = statusOf('inspect')?.output;
      let rec = known ? await deps.ipc.jobStatus(known) : null;
      if (
        rec &&
        (rec.status === 'failed' || rec.status === 'cancelled' || rec.status === 'interrupted')
      )
        rec = await deps.ipc.enqueueJob({ resume: rec.id });
      rec ??= await deps.ipc.enqueueJob({
        params: {
          run: mustRun().id,
          clouds,
          meshes,
          photos,
          ...(setup.region ? { region: setup.region } : {}),
          detail: setup.detail,
        },
      });
      jobId = rec.id;
      await saveStage('inspect', { status: 'running', output: rec.id, hash });
      for (;;) {
        check(t);
        if (rec.status === 'done') break;
        if (rec.status === 'failed') throw new StageFailed(rec.error ?? runText.jobFailed());
        if (rec.status === 'cancelled' || rec.status === 'interrupted')
          throw new Cancelled('cancelled');
        await sleep(1000);
        check(t);
        const next = await deps.ipc.jobStatus(rec.id);
        if (!next) throw new StageFailed(runText.jobGone());
        rec = next;
      }
      jobId = null;
      const read = await deps.ipc.runRead(mustRun().id);
      if (!read.evidence) throw new StageFailed(runText.noEvidence());
      const r = read.evidence.reconstruction;
      set({ evidence: read.evidence });
      await saveRun({
        ...mustRun(),
        reconstruction: r === 'used' ? 'done' : r,
        stages: {
          ...mustRun().stages,
          inspect: { status: 'done', output: rec.id, hash },
        },
      });
    }

    async function estimate(): Promise<void> {
      let evidence = get().evidence;
      if (!evidence) {
        evidence = (await deps.ipc.runRead(mustRun().id)).evidence;
        set({ evidence });
      }
      if (!evidence) throw new StageFailed(runText.noEvidence());
      const hash = await hashOf(evidence);
      if (fresh('estimate', hash)) return;
      const m = evidence.height !== null ? runText.height(evidence.height.toFixed(2)) : '';
      await saveStage('estimate', { status: 'done', hash, ...(m ? { message: m } : {}) });
    }

    /** The mean silhouette overlap of `proposal`'s draft, or null when it cannot be measured. */
    async function fitOf(proposal: EngineerProposal): Promise<number | null> {
      const evidence = get().evidence;
      if (!deps.silhouette || !evidence) return null;
      const v = Object.values(await deps.silhouette(draftFor(proposal), evidence)).filter((x) =>
        Number.isFinite(x),
      );
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    }

    /**
     * A correction of pass 2 or 3 against the proposal it corrects: the new one when its draft
     * overlaps the evidence silhouettes no worse (or that cannot be measured), else the previous
     * one with a note in its unresolved list.
     */
    async function judge(
      previous: EngineerProposal,
      previousFit: number | null,
      next: EngineerProposal,
      pass: number,
    ): Promise<{ proposal: EngineerProposal; fit: number | null }> {
      const before = previousFit ?? (await fitOf(previous));
      const after = await fitOf(next);
      if (before === null || after === null || after >= before)
        return { proposal: next, fit: after };
      const note = runText
        .correctionDropped(pass, after.toFixed(2), before.toFixed(2))
        .slice(0, 200);
      return {
        proposal: { ...previous, unresolved: [...previous.unresolved, note].slice(-40) },
        fit: before,
      };
    }

    /** The draft for `proposal` (not written): what generated views are rendered from. */
    function draftFor(proposal: EngineerProposal | null): ProcModel {
      const run = mustRun();
      return assembleModel(run, proposal).model;
    }

    function familyOf(run: EngineerRun, proposal: EngineerProposal | null): ModelFamily {
      if (run.setup.family !== 'auto') return run.setup.family;
      return proposal?.family.value ?? get().evidence?.familyHints?.suggested ?? 'generic';
    }

    function assembleModel(run: EngineerRun, proposal: EngineerProposal | null) {
      const r = assemble({
        modelId: run.modelId,
        runId: run.id,
        family: familyOf(run, proposal),
        scope: run.setup.scope,
        evidence: get().evidence,
        proposal,
        setup: run.setup,
        user,
        previous: get().model,
        now: deps.now(),
      });
      const model: ProcModel = {
        ...r.model,
        georef: georefFor(r.model, run.setup, get().evidence, deps.project),
      };
      return { ...r, model };
    }

    async function identifyHash(): Promise<string> {
      const run = mustRun();
      const e = get().evidence;
      // a reply belongs to the model that gave it: another provider, model or prompt asks again
      const route = deps.online() ? await deps.ipc.route() : null;
      return hashOf({
        summary: measurementSummary(e, run.setup),
        images: (e?.images ?? []).map((i) => [i.id, i.sha1]),
        excluded: get().excludedImages,
        setup: run.setup,
        route: route
          ? {
              provider: route.provider,
              model: route.model,
              treatAsVision: route.treatAsVision === true,
            }
          : null,
        prompt: ENGINEER_PROMPT_VERSION,
        format: PROPOSAL_FORMAT,
      });
    }

    async function packImages(): Promise<EngineerCallImage[]> {
      const run = mustRun();
      const excluded = new Set(get().excludedImages);
      const out: EngineerCallImage[] = [];
      for (const img of get().evidence?.images ?? []) {
        if (excluded.has(img.id)) continue;
        const dataUrl = await deps.ipc.evidenceImage(run.id, img.id);
        out.push({
          id: img.id,
          kind: img.kind,
          dataUrl,
          bytes: dataUrlBytes(dataUrl),
          view: img.view,
        });
      }
      return out;
    }

    /** Waits for the person at the send preview: what to send, or null when declined. */
    async function consent(t: number, pass: number, req: EngineerCall) {
      const p = await deps.ipc.preview(req);
      check(t);
      if (!p.ok) return { refused: p.error };
      const choice = await new Promise<{ a: 'send' | 'decline' | 'cancel'; o?: SendChoice }>(
        (resolve) => {
          answer = (a, o) => {
            resolve(o ? { a, o } : { a });
          };
          set({
            preview: {
              pass,
              route: p.route,
              cloud: p.cloud,
              flags: p.flags,
              ...(p.estimateUsd !== undefined ? { estimateUsd: p.estimateUsd } : {}),
              content: p.content,
            },
          });
        },
      );
      answer = null;
      set({ preview: null });
      if (choice.a === 'cancel') throw new Cancelled('cancelled');
      check(t);
      if (choice.a === 'decline' || !choice.o) return { declined: true as const };
      return { token: p.consent, choice: choice.o };
    }

    async function identify(t: number): Promise<void> {
      const run = mustRun();
      const hash = await identifyHash();
      if (fresh('identify', hash)) {
        if (!get().proposal) set({ proposal: (await deps.ipc.runRead(run.id)).proposal });
        return;
      }
      // photos the measuring job flagged as another asset (colours, far cameras) stop here, as an
      // AI-reported conflict does, until the person drops them
      const local = get().evidence?.identity;
      if (local && !local.sameAsset) {
        const excluded = new Set(get().excludedImages);
        const open = local.conflicts.filter((c) => c.imageIds.some((id) => !excluded.has(id)));
        if (open.length) {
          const ids = [...new Set(open.flatMap((x) => x.imageIds))].filter(
            (id) => !excluded.has(id),
          );
          set({ conflicts: open });
          throw new StageFailed(runText.conflict(ids.join(', ')));
        }
      }
      if (!deps.online()) {
        set({ notice: runText.offline(), proposal: null });
        await saveStage('identify', { status: 'skipped', hash, message: runText.offline() });
        return;
      }
      await saveStage('identify', { status: 'running', hash });
      const passes = DETAIL_BUDGETS[run.setup.detail].passes;
      const summary = measurementSummary(get().evidence, run.setup);
      const evidenceImages = await packImages();
      check(t);
      let proposal: EngineerProposal | null = null;
      /** The mean silhouette overlap of `proposal`'s draft, once computed. */
      let proposalFit: number | null = null;
      let skipped: string | null = null;
      for (let pass = 1; pass <= passes; pass++) {
        let images = evidenceImages;
        if (pass > 1) {
          if (!deps.renderViews || !proposal) break;
          const views = (get().evidence?.images ?? [])
            .filter((i) => i.kind === 'side' || i.kind === 'top')
            .map((i) => ({ id: `gen-${i.view}`.slice(0, 40), view: i.view }));
          if (views.length === 0) break;
          images = [...evidenceImages, ...(await deps.renderViews(draftFor(proposal), views))];
          check(t);
        }
        const req: EngineerCall = {
          projectId: '',
          engineerRun: run.id,
          pass,
          images,
          summary,
          setup: run.setup,
          ...(proposal ? { previous: proposal } : {}),
        };
        const c = await consent(t, pass, req);
        if ('refused' in c) {
          skipped = c.refused ?? runText.notPrepared();
          break;
        }
        if ('declined' in c) {
          skipped = runText.declined();
          break;
        }
        aiRun = `${run.id}-p${String(pass)}-${String(++calls)}`;
        const out = await deps.ipc.engineer({
          ...req,
          runId: aiRun,
          consent: { token: c.token, photos: c.choice.once.photos, scans: c.choice.once.scans },
          ...(c.choice.costConfirmed ? { costConfirmed: true } : {}),
        });
        aiRun = null;
        check(t);
        if (out.kind === 'failed') {
          if (out.code === 'cancelled') throw new Cancelled('cancelled');
          skipped = out.error;
          break;
        }
        if (out.kind === 'refused') {
          skipped = out.code === 'offline' ? runText.offline() : out.reason;
          break;
        }
        const r = mustRun();
        set({
          run: {
            ...r,
            usage: {
              costUsd: r.usage.costUsd + out.costUsd,
              inputTokens: r.usage.inputTokens + (out.usage?.inputTokens ?? 0),
              outputTokens: r.usage.outputTokens + (out.usage?.outputTokens ?? 0),
            },
          },
        });
        const conflicts = out.proposal.identity.conflicts;
        if (out.identityConflict || (!out.proposal.identity.sameAsset && conflicts.length)) {
          const ids = [...new Set(conflicts.flatMap((x) => x.imageIds))];
          set({ conflicts });
          throw new StageFailed(runText.conflict(ids.join(', ')));
        }
        // passes 2 and 3: the local silhouette overlap decides whether a correction is kept
        const kept: { proposal: EngineerProposal; fit: number | null } | null =
          pass > 1 && proposal ? await judge(proposal, proposalFit, out.proposal, pass) : null;
        check(t);
        if (kept) {
          proposal = kept.proposal;
          proposalFit = kept.fit;
        } else proposal = out.proposal;
        if (out.stopped === 'budget') {
          skipped = null;
          set({ notice: runText.costCap() });
          break;
        }
      }
      set({ proposal, ...(skipped ? { notice: skipped } : {}) });
      if (proposal)
        await saveStage(
          'identify',
          { status: 'done', hash, ...(skipped ? { message: skipped } : {}) },
          proposal,
        );
      else await saveStage('identify', { status: 'skipped', hash, message: skipped ?? '' });
    }

    async function generate(): Promise<void> {
      const run = mustRun();
      if (!get().model) set({ model: await deps.ipc.modelRead(run.modelId) });
      const hash = await hashOf({
        e: statusOf('estimate')?.hash,
        p: get().proposal,
        u: user,
        s: run.setup,
      });
      if (fresh('generate', hash) && get().model) return;
      await saveStage('generate', { status: 'running', hash });
      const r = assembleModel(run, get().proposal);
      await deps.ipc.modelWrite(r.model);
      assembled = r;
      set({ model: r.model, unresolved: r.unresolved, flagged: r.flagged });
      await saveStage('generate', { status: 'done', hash });
    }

    async function validate(t: number): Promise<void> {
      const run = mustRun();
      const model = get().model;
      if (!model) throw new StageFailed(runText.noDraft());
      const hash = await hashOf({ m: model.assemblies, g: model.georef, d: run.setup.detail });
      if (fresh('validate', hash) && get().report) return;
      await saveStage('validate', { status: 'running', hash });
      const built = await deps.ipc.modelBuild(run.modelId, true);
      check(t);
      const report = await deps.ipc.validate(run.modelId, true, run.setup.detail);
      check(t);
      const evidence = get().evidence;
      const silhouette =
        deps.silhouette && evidence ? await deps.silhouette(model, evidence) : null;
      set({ build: built.report ?? null, report, silhouette, draftLayer: built.layer });
      const problems = [
        report.validatorErrors ? runText.validatorErrors(report.validatorErrors) : '',
        !report.finite ? runText.notFinite() : '',
        !report.indicesValid ? runText.badIndices() : '',
        !report.withinBudget ? runText.overBudget() : '',
        built.report?.failed.length ? runText.notBuilt(built.report.failed.length) : '',
      ].filter(Boolean);
      await saveStage('validate', {
        status: 'done',
        hash,
        ...(problems.length ? { message: runText.check(problems.join(', ')) } : {}),
      });
    }

    // ---------------------------------------------------------------- the drive

    async function drive(): Promise<void> {
      const t = token;
      set({ busy: true, error: null });
      let at: EngineerStage | null = null;
      try {
        for (const s of STAGES) {
          at = s;
          set({ stage: s });
          if (s === 'inspect') await inspect(t);
          else if (s === 'estimate') await estimate();
          else if (s === 'identify') {
            const src = mustRun().setup.sources;
            // photos alone and offline: nothing more can be done (spec 5.2)
            if (!deps.online() && src.clouds.length + src.meshes.length === 0) {
              set({ notice: runText.offline() });
              await saveStage('identify', {
                status: 'skipped',
                hash: await identifyHash(),
                message: runText.offline(),
              });
              set({ error: runText.offline() });
              return;
            }
            await identify(t);
          } else if (s === 'generate') await generate();
          else if (s === 'validate') await validate(t);
          else if (statusOf('review')?.status !== 'done')
            await saveStage('review', { status: 'done' });
          check(t);
        }
        at = null;
      } catch (e) {
        if (at) {
          const prev = statusOf(at);
          if (e instanceof Cancelled) {
            await saveStage(at, { ...(prev ?? {}), status: 'cancelled' }).catch(() => undefined);
            set({ notice: runText.cancelled() });
          } else {
            const message = e instanceof Error ? e.message : String(e);
            await saveStage(at, {
              ...(prev ?? {}),
              status: 'failed',
              message: message.slice(0, 500),
            }).catch(() => undefined);
            set({ error: message });
          }
        }
      } finally {
        set({ busy: false, stage: null, preview: null });
      }
    }

    function go(): Promise<void> {
      const p = drive().finally(() => {
        if (driving === p) driving = null;
      });
      driving = p;
      return p;
    }

    return {
      run: null,
      evidence: null,
      proposal: null,
      model: null,
      build: null,
      report: null,
      silhouette: null,
      stage: null,
      busy: false,
      error: null,
      notice: null,
      conflicts: [],
      excludedImages: [],
      unresolved: [],
      flagged: [],
      preview: null,
      layer: null,
      draftLayer: null,
      user: NO_OVERRIDES,

      async start(setup, o = {}) {
        if (driving) await get().cancel();
        const now = deps.now();
        const id = o.runId ?? (deps.newRunId ?? (() => newRunIdAt(now)))();
        const run: EngineerRun = {
          schema: 'aio.engineer-run/1',
          id,
          modelId: o.modelId ?? `eng-${id.slice(4)}`.slice(0, 80),
          createdAt: now,
          setup,
          stages: {},
          usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
        };
        user = NO_OVERRIDES;
        assembled = null;
        set({
          user,
          run,
          evidence: null,
          proposal: null,
          model: null,
          build: null,
          report: null,
          silhouette: null,
          conflicts: [],
          excludedImages: [],
          notice: null,
          layer: null,
          draftLayer: null,
        });
        await deps.ipc.runWrite(run);
        await go();
      },

      async resume(runId) {
        if (driving) await get().cancel();
        const r = await deps.ipc.runRead(runId);
        if (!r.run) {
          set({ error: runText.noSuchRun(runId) });
          return;
        }
        // the corrections come back with the run, so nothing reassembles without them
        user = r.run.user ?? NO_OVERRIDES;
        assembled = null;
        set({
          user,
          run: r.run,
          evidence: r.evidence,
          proposal: r.proposal,
          model: await deps.ipc.modelRead(r.run.modelId),
          excludedImages: r.run.excludedImages ?? [],
          conflicts: [],
          notice: null,
        });
        await go();
      },

      async cancel() {
        token++;
        answer?.('cancel');
        const running = driving;
        if (aiRun) await deps.ipc.cancel(aiRun).catch(() => undefined);
        if (jobId) await deps.ipc.cancelJob(jobId).catch(() => undefined);
        jobId = null;
        if (running) await running;
      },

      async retry() {
        if (driving) return;
        set({ conflicts: [], notice: null });
        await go();
      },

      async rebuild(next) {
        if (driving) await get().cancel();
        user = next;
        set({ user });
        const run = get().run;
        if (run) await saveRun({ ...run, user: next });
        await go();
      },

      async accept() {
        if (get().busy) {
          set({ error: runText.busy() });
          return;
        }
        const run = get().run;
        if (!run || !get().model) {
          set({ error: runText.nothingToAccept() });
          return;
        }
        const r = await deps.ipc.accept(run.modelId);
        set({ layer: r.layer, draftLayer: null });
      },

      current() {
        const model = get().model;
        return model ? { model, user } : null;
      },

      async setStatus(ids, status) {
        const model = get().model;
        if (!model) return { error: runText.nothingToAccept() };
        const want = new Set(ids);
        const next: ProcModel = {
          ...model,
          updatedAt: deps.now(),
          assemblies: model.assemblies.map((a) => (want.has(a.id) ? { ...a, status } : a)),
          parts: model.parts.map((p) => (want.has(p.id) ? { ...p, status } : p)),
        };
        try {
          await deps.ipc.modelWrite(next);
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        set({ model: next });
        return next;
      },

      session() {
        return {
          current: () => get().current(),
          setStatus: (ids, status) => get().setStatus(ids, status),
          rebuild: async (next) => {
            await get().rebuild(next);
            const err = get().error;
            if (err) return { error: err };
            return assembled ?? { error: runText.noDraft() };
          },
        };
      },

      sendPreview(o) {
        answer?.('send', o);
      },

      declinePreview() {
        answer?.('decline');
      },

      async allowProject(kind) {
        await deps.ipc.setCloudEvidence(kind === 'photos' ? { photos: true } : { scans: true });
        const p = get().preview;
        if (p) set({ preview: { ...p, flags: { ...p.flags, [kind]: true } } });
      },

      async dropImages(ids) {
        if (driving) await get().cancel();
        const excluded = [...new Set([...get().excludedImages, ...ids])].slice(0, 64);
        set({ excludedImages: excluded, conflicts: [], error: null });
        // kept in run.json, so the dropped images stay dropped after a reopen
        const run = get().run;
        if (run) await saveRun({ ...run, excludedImages: excluded });
        await go();
      },
    };
  });
  return store;
}

/** The real IPC of a run for an open folder project (`root` is where jobs run). */
export function ipcRunIpc(bridge: Bridge, projectId: string, root: string): RunIpc {
  const must = async <T>(p: Promise<{ ok: true; value: T } | { ok: false; error: string }>) => {
    const r = await p;
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const ok = <T extends { ok: boolean }>(v: T): Extract<T, { ok: true }> => {
    if (!v.ok) throw new Error((v as { error?: string }).error ?? 'The request failed.');
    return v as Extract<T, { ok: true }>;
  };
  return {
    route: async () => {
      const settings = await must(bridge.call('settings:get', {}));
      try {
        return routeFor(settings.routes, 'engineer');
      } catch {
        return null;
      }
    },
    runRead: async (runId) => {
      const r = ok(await must(bridge.call('engineer:runRead', { projectId, runId })));
      return { run: r.run, evidence: r.evidence, proposal: r.proposal };
    },
    runWrite: async (run, proposal) => {
      ok(
        await must(
          bridge.call('engineer:runWrite', { projectId, run, ...(proposal ? { proposal } : {}) }),
        ),
      );
    },
    evidenceImage: async (runId, imageId) =>
      ok(await must(bridge.call('engineer:evidenceImage', { projectId, runId, imageId }))).dataUrl,
    preview: (req) => must(bridge.call('ai:engineerPreview', { ...req, projectId })),
    engineer: (req) => must(bridge.call('ai:engineer', { ...req, projectId })),
    cancel: async (runId) => {
      await must(bridge.call('ai:cancel', { runId }));
    },
    enqueueJob: async (req) => {
      const r = await must(
        bridge.call(
          'jobs:start',
          'resume' in req
            ? { resume: req.resume }
            : { pipeline: 'model.evidence', project: root, params: req.params },
        ),
      );
      if (!r.ok) throw new Error(r.error);
      return r.job;
    },
    jobStatus: async (jobId) =>
      (await must(bridge.call('jobs:list', {}))).jobs.find((j) => j.id === jobId) ?? null,
    cancelJob: async (jobId) => {
      await must(bridge.call('jobs:cancel', { jobId }));
    },
    modelRead: async (id) => {
      const r = await must(bridge.call('model:read', { projectId, id }));
      return r.ok ? r.model : null;
    },
    modelWrite: async (model) => {
      ok(await must(bridge.call('model:write', { projectId, model })));
    },
    modelBuild: async (id, draft) => {
      const r = ok(await must(bridge.call('model:build', { projectId, id, draft })));
      return { layer: r.layer, ...(r.report ? { report: r.report } : {}) };
    },
    validate: async (modelId, draft, detail) =>
      ok(await must(bridge.call('engineer:validate', { projectId, modelId, draft, detail })))
        .report,
    accept: async (modelId) => {
      const r = ok(await must(bridge.call('engineer:accept', { projectId, modelId })));
      return { layer: r.layer };
    },
    setCloudEvidence: async (o) => {
      ok(await must(bridge.call('ai:setCloudEvidence', { projectId, ...o })));
    },
  };
}
