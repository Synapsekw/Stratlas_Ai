/**
 * Auto-plan in the renderer: checks that antennas are reviewed (F6), gathers the inputs, asks the
 * AI (through `ai:rfPlanPreview` / `ai:rfPlan`), the rules or a cell export, and holds the
 * proposal for the review dialog. Nothing is written until `applyAutoplan` (F2); Apply & run then
 * starts a coverage run, which saves (C6). Also the Coverage chip's state (`selectChipState`).
 *
 * - The AI source follows the antenna AI labels: a send preview first, the preview's token with
 *   the request. A local model needs no preview. Photos go only under the project's photo consent
 *   (ruling R7), which the preview already reflects.
 * - Any failure of the AI step (refused preview, a provider error or timeout, a thrown call) ends
 *   in `error`, from where the dialog offers Rules only. Cancel goes back to `idle` and a late reply
 *   is ignored, so the chip never stays on "planning".
 * - Bound to a project (ruling R17): each step keeps the project it started for (`projectId`),
 *   and after every await an answer is dropped when `rfStore` holds another project by then.
 *   `applyAutoplan` refuses a proposal made for another project. The store also subscribes to
 *   `rfStore` itself and resets (`resetAutoplan`) whenever its project changes, so no other code
 *   has to remember to.
 * - What it shows (`error`, `warnings`, reasons) is i18n keys with values (`planText.ts`), never
 *   English; a provider's own error text is kept as it came.
 *
 * Bridge calls follow `telecom/antennaStore.ts`. Nothing here writes `antennas.json`.
 */
import { BANDS } from '@aio/rf';
import type {
  AntennaUnit,
  IpcResponse,
  RfCatalogueEntry,
  RfPlanAiPick,
  RfPlanCatalogueInput,
  RfPlanUnitInput,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand';
import { createStore, useStore } from 'zustand';
import { bridge } from '../../shell';
import { antennaStore, openAntennaReview } from '../../telecom/antennaStore';
import { workbench, type WorkbenchState } from '../../workspace/workbench/workbenchStore';
import { startRfRun } from '../rfTab';
import { applyPlan, rfStore, type RfState, type RfView, type StartResult } from '../rfStore';
import { entryCoversBand } from './bandFit';
import { matchCellExport } from './exportMatch';
import { msg, raw, type PlanText } from './planText';
import { buildProposal, validateAiPick, type AiPickRaw, type Proposal } from './proposal';
import { rulesPick } from './rules';
import { plannedUnits, planSectors } from './sectors';
import type { PlanPick } from './types';

export type AutoplanSource = 'ai' | 'rules' | { csvText: string };
export type AutoplanPhase = 'idle' | 'blocked-review' | 'preview' | 'thinking' | 'review' | 'error';

export interface AutoplanState {
  phase: AutoplanPhase;
  source: AutoplanSource;
  preview: IpcResponse<'ai:rfPlanPreview'> | null;
  proposal: Proposal | null;
  warnings: PlanText[];
  error: PlanText | null;
  /** The project this step was started for (R17); null when idle with no project. */
  projectId: string | null;
  /** A provider is set up and the project policy allows it (`ai:status`, chat route). */
  aiAvailable: boolean;
  /**
   * The provider of the chat route (`ai:status`, then the send preview), so the dialog can name
   * it even when a local model skips the preview; null when not known.
   */
  provider: string | null;
  /** Whether that provider is a cloud one; null when not known. */
  cloud: boolean | null;
}

export type ChipState =
  | { kind: 'hidden' }
  | { kind: 'review-first'; total: number }
  | { kind: 'not-planned'; accepted: number }
  | { kind: 'ready'; sectors: number }
  | { kind: 'planning' }
  | { kind: 'running' }
  /** `fairOrBetterPct` is null until the selected run's class stats are known. */
  | { kind: 'result'; view: RfView; fairOrBetterPct: number | null; at: string };

const initial = (): AutoplanState => ({
  phase: 'idle',
  source: 'rules',
  preview: null,
  proposal: null,
  warnings: [],
  error: null,
  projectId: null,
  aiAvailable: false,
  provider: null,
  cloud: null,
});

export const autoplanStore = createStore<AutoplanState>()(initial);

export function useAutoplan<T>(sel: (s: AutoplanState) => T): T {
  return useStore(autoplanStore, sel);
}

const get = () => autoplanStore.getState();
const set = (patch: Partial<AutoplanState>) => {
  autoplanStore.setState(patch);
};

/** Bumped by every start, switch and cancel: an answer for an older step is dropped. */
let seq = 0;
/** The AI request in flight, so a cancel can stop it. */
let pendingRunId: string | null = null;
/** What the preview was asked for: the project and the units, sent again with the request. */
let previewFor: { projectId: string; unitIds: string[] } | null = null;

/** Reset (project closed, or a test). */
export function resetAutoplan(): void {
  seq++;
  stopPending();
  previewFor = null;
  autoplanStore.setState(initial());
}

/** True when the step `my` for `projectId` is no longer the current one (R17). */
const stale = (my: number, projectId: string | null): boolean =>
  my !== seq || rfStore.getState().projectId !== projectId || get().projectId !== projectId;

// A project switch (or close) drops whatever Auto-plan holds: self-contained, not left to callers.
rfStore.subscribe((s, prev) => {
  if (s.projectId !== prev.projectId) resetAutoplan();
});

// ---------------------------------------------------------------- inputs

/** The detected units: the inventory store's when it holds this project, else the RF store's. */
function currentUnits(): readonly AntennaUnit[] {
  const rf = rfStore.getState();
  const a = antennaStore.getState();
  if (a.file && a.projectId === rf.projectId) return a.file.units;
  return rf.antennas?.units ?? [];
}

const catalogueOf = (): RfCatalogueEntry[] => rfStore.getState().catalogue.map((c) => c.entry);

/** Band names the entry can carry, as the AI should write them: `B3`, `n78`. */
function bandsOf(entry: RfCatalogueEntry): string[] {
  const out: string[] = [];
  for (const b of BANDS) {
    if (!entryCoversBand(entry, b.id)) continue;
    for (const n of b.lteBands) out.push(`B${String(n)}`);
    if (b.nrBand !== null) out.push(b.nrBand);
  }
  return [...new Set(out)].slice(0, 50);
}

const MAX_UNITS = 200;
const MAX_CATALOGUE = 400;

const finite = (v: number | null | undefined): number | undefined =>
  v !== undefined && v !== null && Number.isFinite(v) ? v : undefined;
const size = (v: number | undefined): number | undefined => {
  const f = finite(v);
  return f !== undefined && f >= 0 ? f : undefined;
};

/** What the model is told about one unit: its measured face, tilt, height and the typed fields. */
function unitInput(u: AntennaUnit): RfPlanUnitInput {
  // a unit read from an older file may lack a size
  const m: Partial<Pick<AntennaUnit, 'widthM' | 'heightM' | 'depthM' | 'downtiltDeg'>> = u;
  const agl = rfStore.getState().rows.find((r) => r.id === u.id)?.height.heightM;
  const fields: Record<string, number | string | undefined> = {
    widthM: size(m.widthM?.value),
    heightM: size(m.heightM?.value),
    depthM: size(m.depthM?.value),
    downtiltDeg: finite(m.downtiltDeg?.value),
    heightAboveGroundM: finite(agl),
    userModel: u.user.model?.slice(0, 200),
    userFrequencies: u.user.frequencies?.slice(0, 200),
  };
  const out: Record<string, number | string> = { unitId: u.id };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') out[k] = v;
  return out as RfPlanUnitInput;
}

function catalogueInput(): RfPlanCatalogueInput[] {
  return catalogueOf()
    .slice(0, MAX_CATALOGUE)
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      vendor: e.vendor.slice(0, 100),
      model: e.model.slice(0, 100),
      bands: bandsOf(e),
    }));
}

/** The units the plan covers: accepted panels with a bearing, in the sectors they will be in. */
function plannedUnitIds(units: readonly AntennaUnit[]): string[] {
  const file = rfStore.getState().sectors;
  const plan = planSectors(units, file.sectors, file.antennas);
  const out = new Set(plan.leftOut.map((l) => l.unitId));
  const known = new Set(units.map((u) => u.id));
  return plan.sectors.flatMap((s) => s.antennaIds).filter((id) => known.has(id) && !out.has(id));
}

function proposalFrom(
  units: readonly AntennaUnit[],
  picks: ReadonlyMap<string, PlanPick[]>,
  extra: { renames?: { sectorId: string; name: string }[]; unmatchedRows?: number[] } = {},
): Proposal {
  return buildProposal({
    units,
    file: rfStore.getState().sectors,
    catalogue: catalogueOf(),
    picks,
    ...extra,
  });
}

/** A thrown error's own text (from the bridge or a provider), shown as it came. */
const messageOf = (e: unknown): PlanText => raw(e instanceof Error ? e.message : String(e));
/** A failure's text as it came, or the store's own message when it gave none. */
const failure = (error: string, fallback: PlanText): PlanText => (error ? raw(error) : fallback);

/** Unwrap a bridge answer to its value, or the text of why not (as `antennaStore` does). */
function unwrap<T extends { ok: boolean }>(
  r: { ok: true; value: T } | { ok: false; error: string },
): { ok: true; value: Extract<T, { ok: true }> } | { ok: false; error: string } {
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.ok) return { ok: false, error: (r.value as { error?: string }).error ?? '' };
  return { ok: true, value: r.value as Extract<T, { ok: true }> };
}

type AiStatus = Pick<AutoplanState, 'aiAvailable' | 'provider' | 'cloud'>;

const NO_AI: AiStatus = { aiAvailable: false, provider: null, cloud: null };

/** Whether the chat route is ready for this project, and its provider. */
async function aiStatus(projectId: string | null): Promise<AiStatus> {
  if (!projectId) return NO_AI;
  try {
    const r = await bridge.call('ai:status', { projectId, task: 'chat' });
    if (!r.ok) return NO_AI;
    const provider = r.value.route?.provider ?? null;
    return {
      aiAvailable: r.value.ready,
      provider,
      cloud: provider === null ? null : provider !== 'local',
    };
  } catch {
    return NO_AI;
  }
}

/** What the last status call said, kept across steps of the same project. */
const statusOf = (s: AutoplanState): AiStatus => ({
  aiAvailable: s.aiAvailable,
  provider: s.provider,
  cloud: s.cloud,
});

// ---------------------------------------------------------------- the flow

/**
 * Start (or restart) Auto-plan. With no accepted antenna it stops at `blocked-review` (F6). The
 * default source is the AI when a provider is set up and the project policy allows it, else the
 * rules. A read-only project could not take the plan, so nothing starts there (the chip, the
 * panel and Ctrl+K do not offer it, `canAutoplan`).
 */
export async function startAutoplan(source?: AutoplanSource): Promise<void> {
  const my = ++seq;
  stopPending();
  previewFor = null;
  const projectId = rfStore.getState().projectId;
  if (rfStore.getState().readOnly) {
    const kept = get().projectId === projectId ? statusOf(get()) : NO_AI;
    set({ ...initial(), projectId, ...kept });
    return;
  }
  // the step belongs to this project from the start, so a switch during the status call drops it
  const before = get().projectId === projectId ? statusOf(get()) : NO_AI;
  set({ ...initial(), projectId, ...before });
  const status = await aiStatus(projectId);
  if (stale(my, projectId)) return;
  const chosen: AutoplanSource = source ?? (status.aiAvailable ? 'ai' : 'rules');
  set({ ...initial(), projectId, source: chosen, ...status });

  const units = currentUnits();
  if (!units.some((u) => u.status === 'accepted')) {
    set({ phase: 'blocked-review' });
    return;
  }
  if (chosen === 'rules') {
    set({ phase: 'review', proposal: proposalFrom(units, new Map()) });
    return;
  }
  if (typeof chosen === 'object') {
    planFromExport(units, chosen.csvText);
    return;
  }
  await askPreview(my, projectId, units);
}

function planFromExport(units: readonly AntennaUnit[], text: string): void {
  const file = rfStore.getState().sectors;
  const sectors = planSectors(units, file.sectors, file.antennas).sectors;
  const m = matchCellExport(text, units, sectors, catalogueOf(), file.antennas);
  if ('error' in m) {
    set({
      phase: 'error',
      error:
        m.error === 'empty'
          ? msg('rf.autoplan.error.exportEmpty')
          : msg('rf.autoplan.error.exportNoAntennaColumn'),
    });
    return;
  }
  const nameOf = (id: string) => units.find((u) => u.id === id)?.name ?? id;
  set({
    phase: 'review',
    proposal: proposalFrom(units, m.picks, {
      renames: m.renames,
      unmatchedRows: m.unmatchedRows,
    }),
    warnings: m.unmatchedUnits.map((id) => msg('rf.autoplan.noExportRow', { name: nameOf(id) })),
  });
}

async function askPreview(
  my: number,
  projectId: string | null,
  units: readonly AntennaUnit[],
): Promise<void> {
  const unitIds = plannedUnitIds(units).slice(0, MAX_UNITS);
  // nothing for the AI to plan: the proposal only lists what is left out
  if (unitIds.length === 0) {
    set({ phase: 'review', proposal: proposalFrom(units, new Map()) });
    return;
  }
  if (!projectId) {
    set({ phase: 'error', error: msg('rf.autoplan.error.noProject') });
    return;
  }
  set({ phase: 'preview' });
  let r: Awaited<ReturnType<typeof bridge.call<'ai:rfPlanPreview'>>>;
  try {
    r = await bridge.call('ai:rfPlanPreview', { projectId, unitIds });
  } catch (e) {
    if (!stale(my, projectId)) set({ phase: 'error', error: messageOf(e) });
    return;
  }
  if (stale(my, projectId)) return;
  const v = unwrap(r);
  if (!v.ok) {
    set({ phase: 'error', error: failure(v.error, msg('rf.autoplan.error.aiUnavailable')) });
    return;
  }
  previewFor = { projectId, unitIds };
  set({ preview: v.value, provider: v.value.provider, cloud: v.value.cloud });
  // a local model sends nothing off this machine: no send preview to confirm
  if (!v.value.cloud) await confirmSend(false);
}

/**
 * The person's yes to the send preview: send the request and build the proposal from the reply.
 * `photos` adds no consent of its own (R7): photos go only when the project allows them.
 */
export async function confirmSend(photos: boolean): Promise<void> {
  const preview = get().preview;
  const target = previewFor;
  if (get().phase !== 'preview' || !preview?.ok || !target) return;
  if (target.projectId !== get().projectId || target.projectId !== rfStore.getState().projectId)
    return;
  const my = ++seq;
  const projectId = target.projectId;
  const runId = `rfplan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  pendingRunId = runId;
  previewFor = null;
  set({ phase: 'thinking', preview: null });

  const units = currentUnits();
  const sent = target.unitIds.flatMap((id) => units.find((u) => u.id === id) ?? []);
  let r: Awaited<ReturnType<typeof bridge.call<'ai:rfPlan'>>>;
  try {
    r = await bridge.call('ai:rfPlan', {
      runId,
      projectId: target.projectId,
      units: sent.map(unitInput),
      catalogue: catalogueInput(),
      token: preview.token,
      ...(photos && preview.photosAllowed ? { photos: true } : {}),
    });
  } catch (e) {
    if (!stale(my, projectId)) {
      pendingRunId = null;
      set({ phase: 'error', error: messageOf(e) });
    }
    return;
  }
  if (stale(my, projectId)) return;
  pendingRunId = null;
  const v = unwrap(r);
  if (!v.ok) {
    set({ phase: 'error', error: failure(v.error, msg('rf.autoplan.error.aiNoAnswer')) });
    return;
  }
  try {
    set({
      phase: 'review',
      proposal: proposalFrom(units, aiPicks(sent, v.value.picks)),
      // main's own words about the reply (a dropped key), shown as they came
      warnings: v.value.warnings.map(raw),
    });
  } catch (e) {
    set({ phase: 'error', error: messageOf(e) });
  }
}

/** The AI's pick per unit, validated; a unit it gave no pick for gets the rules at low confidence. */
function aiPicks(
  sent: readonly AntennaUnit[],
  raws: readonly RfPlanAiPick[],
): Map<string, PlanPick[]> {
  const catalogue = catalogueOf();
  const picks = new Map<string, PlanPick[]>();
  for (const u of sent) {
    const found = raws.find((p) => p.unitId === u.id);
    if (found) {
      const { radioId, ...rest } = found;
      const raw: AiPickRaw = { ...rest, ...(radioId !== undefined ? { radioId } : {}) };
      picks.set(u.id, [validateAiPick(raw, u, catalogue)]);
      continue;
    }
    const rules = rulesPick(u, catalogue);
    picks.set(u.id, [
      {
        ...rules,
        confidence: 'low',
        reason: [msg('rf.autoplan.reason.aiNoPick'), ...rules.reason],
      },
    ]);
  }
  return picks;
}

/** Plan again from another source (the dialog's `<provider> | Rules only` switch). */
export function switchSource(source: AutoplanSource): Promise<void> {
  return startAutoplan(source);
}

/** Stop the AI request in flight, if any; its reply is then ignored. */
function stopPending(): void {
  if (pendingRunId === null) return;
  const runId = pendingRunId;
  pendingRunId = null;
  void bridge.call('ai:cancel', { runId }).catch(() => undefined);
}

/** Close Auto-plan without writing anything. */
export function cancelAutoplan(): void {
  seq++;
  stopPending();
  previewFor = null;
  const { source, projectId } = get();
  set({ ...initial(), ...statusOf(get()), source, projectId });
}

/**
 * Apply refused: the project is read only, so nothing was written (`read-only`); or the plan is
 * applied but the project folder is not known, so no run started (`no-root`). The dialog says so.
 */
export interface ApplyRefusal {
  ok: false;
  code: 'read-only' | 'no-root';
}

/**
 * Write the reviewed proposal into the working copy (Apply only: left unsaved, C6), then with
 * `run` start a coverage run, which saves first. Null when nothing was applied (nothing in review,
 * or the proposal is for another project, R17) or no run was asked for; a `failed` result with
 * `no-root` when it applied but the project folder is not known; `read-only` when the project
 * cannot take it (nothing written, Auto-plan closed).
 */
export async function applyAutoplan(run: boolean): Promise<StartResult | ApplyRefusal | null> {
  const { phase, proposal, projectId } = get();
  if (phase !== 'review' || !proposal) return null;
  if (projectId === null || rfStore.getState().projectId !== projectId) {
    resetAutoplan();
    return null;
  }
  if (rfStore.getState().readOnly) {
    cancelAutoplan();
    return { ok: false, code: 'read-only' };
  }
  applyPlan(proposal);
  cancelAutoplan();
  if (!run) return null;
  const root = workspace.getState().project?.root;
  if (!root) return { ok: false, code: 'no-root' };
  return startRfRun(root);
}

/** The review asked for while the inventory was still loading: undone by the next ask. */
let pendingReview: (() => void) | null = null;

/**
 * "Review antennas first": the Measure bench forward (a pinned Coverage tab stays open beside it;
 * its pin is never changed here), then the inventory's review (`openAntennaReview`: the drafts, the first one revealed).
 * Before this project's inventory is read, the review opens once the read is in; a failed read, a
 * read of another project or a newer ask drops it.
 */
export function openAntennaReviewOrFallback(bench: StoreApi<WorkbenchState> = workbench): void {
  pendingReview?.();
  pendingReview = null;
  // Coverage keeps the pin it has: opened from the chip or Ctrl+K it is pinned and stays open
  // beside Measure; a person who unpinned it is not overruled
  bench.getState().open('measure');
  const projectId = rfStore.getState().projectId;
  const a = antennaStore.getState();
  if (a.status === 'ready' && a.projectId === projectId) {
    openAntennaReview();
    return;
  }
  const off = antennaStore.subscribe((next) => {
    if (next.status !== 'ready' && next.status !== 'error') return;
    if (next.status === 'ready' && next.projectId !== projectId) return;
    off();
    pendingReview = null;
    if (next.status === 'ready') openAntennaReview();
  });
  pendingReview = off;
}

// ---------------------------------------------------------------- the chip

const FAIR_OR_BETTER = new Set(['excellent', 'good', 'fair']);

/**
 * Whether Auto-plan (or Re-plan) is offered: where the chip offers it (not before a review, nor
 * while planning or running), and never on a read-only project, which could not take the plan.
 */
export function canAutoplan(chip: ChipState, readOnly: boolean): boolean {
  if (readOnly) return false;
  return chip.kind === 'not-planned' || chip.kind === 'ready' || chip.kind === 'result';
}

/**
 * The Coverage chip's state from the RF store, the detected units and Auto-plan. The selected
 * run is the result while the plan is as it ran: neither edited (`dirty`) nor saved again since
 * (`planChangedSinceRun`). Ready needs the units Auto-plan plans (`plannedUnits`) that are in a
 * sector to be set up; a draft, rejected or inactive member does not hold it back.
 */
export function selectChipState(
  rf: RfState,
  antennaUnits: readonly AntennaUnit[] | null,
  autoplan: AutoplanState,
): ChipState {
  if (!antennaUnits || antennaUnits.length === 0) return { kind: 'hidden' };
  if (rf.running) return { kind: 'running' };
  if (autoplan.phase === 'preview' || autoplan.phase === 'thinking') return { kind: 'planning' };
  const accepted = antennaUnits.filter((u) => u.status === 'accepted').length;
  if (accepted === 0) return { kind: 'review-first', total: antennaUnits.length };

  const run = rf.selectedRunId ? rf.runs.find((r) => r.runId === rf.selectedRunId) : undefined;
  if (run && !rf.dirty && !rf.planChangedSinceRun) {
    const pct = rf.classStats
      ? Math.round(
          rf.classStats.filter((c) => FAIR_OR_BETTER.has(c.cls)).reduce((t, c) => t + c.share, 0) *
            100,
        )
      : null;
    return { kind: 'result', view: rf.view, fairOrBetterPct: pct, at: run.createdAt };
  }

  const takesPart = plannedUnits(antennaUnits, rf.sectors.antennas);
  const planned = rf.sectors.sectors.flatMap((s) => s.antennaIds).filter((id) => takesPart.has(id));
  const setUp = (id: string) => {
    const s = rf.sectors.antennas.find((a) => a.antennaId === id);
    return s?.equipment !== undefined && s.carriers.length > 0;
  };
  if (planned.length > 0 && planned.every(setUp))
    return { kind: 'ready', sectors: rf.sectors.sectors.length };
  return { kind: 'not-planned', accepted };
}
