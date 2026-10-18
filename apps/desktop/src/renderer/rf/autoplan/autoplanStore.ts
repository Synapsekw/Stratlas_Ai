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
import * as antennas from '../../telecom/antennaStore';
import { workbench, type WorkbenchState } from '../../workspace/workbench/workbenchStore';
import { startRfRun } from '../rfTab';
import { applyPlan, rfStore, type RfState, type RfView, type StartResult } from '../rfStore';
import { entryCoversBand } from './bandFit';
import { matchCellExport } from './exportMatch';
import { buildProposal, validateAiPick, type AiPickRaw, type Proposal } from './proposal';
import { rulesPick } from './rules';
import { planSectors } from './sectors';
import type { PlanPick } from './types';

export type AutoplanSource = 'ai' | 'rules' | { csvText: string };
export type AutoplanPhase = 'idle' | 'blocked-review' | 'preview' | 'thinking' | 'review' | 'error';

export interface AutoplanState {
  phase: AutoplanPhase;
  source: AutoplanSource;
  preview: IpcResponse<'ai:rfPlanPreview'> | null;
  proposal: Proposal | null;
  warnings: string[];
  error: string | null;
  /** A provider is set up and the project policy allows it (`ai:status`, chat route). */
  aiAvailable: boolean;
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
  aiAvailable: false,
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
  pendingRunId = null;
  previewFor = null;
  autoplanStore.setState(initial());
}

// ---------------------------------------------------------------- inputs

/** The detected units: the inventory store's when it holds this project, else the RF store's. */
function currentUnits(): readonly AntennaUnit[] {
  const rf = rfStore.getState();
  const a = antennas.antennaStore.getState();
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

const finite = (v: number | undefined): number | undefined =>
  v !== undefined && Number.isFinite(v) ? v : undefined;
const size = (v: number | undefined): number | undefined => {
  const f = finite(v);
  return f !== undefined && f >= 0 ? f : undefined;
};

/** What the model is told about one unit: its measured face, tilt, height and the typed fields. */
function unitInput(u: AntennaUnit): RfPlanUnitInput {
  // a unit read from an older file may lack a size
  const m: Partial<Pick<AntennaUnit, 'widthM' | 'heightM' | 'depthM' | 'downtiltDeg'>> = u;
  const agl = rfStore.getState().rows.find((r) => r.id === u.id)?.height.heightM ?? undefined;
  const fields: Record<string, number | string | undefined> = {
    widthM: size(m.widthM?.value),
    heightM: size(m.heightM?.value),
    depthM: size(m.depthM?.value),
    downtiltDeg: finite(m.downtiltDeg?.value),
    heightAboveGroundM: finite(agl ?? undefined),
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
  const plan = planSectors(units, rfStore.getState().sectors.sectors);
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

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Unwrap a bridge answer to its value, or the text of why not (as `antennaStore` does). */
function unwrap<T extends { ok: boolean }>(
  r: { ok: true; value: T } | { ok: false; error: string },
): { ok: true; value: Extract<T, { ok: true }> } | { ok: false; error: string } {
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.ok) return { ok: false, error: (r.value as { error?: string }).error ?? '' };
  return { ok: true, value: r.value as Extract<T, { ok: true }> };
}

async function aiReady(projectId: string | null): Promise<boolean> {
  if (!projectId) return false;
  try {
    const r = await bridge.call('ai:status', { projectId, task: 'chat' });
    return r.ok && r.value.ready;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the flow

/**
 * Start (or restart) Auto-plan. With no accepted antenna it stops at `blocked-review` (F6). The
 * default source is the AI when a provider is set up and the project policy allows it, else the
 * rules.
 */
export async function startAutoplan(source?: AutoplanSource): Promise<void> {
  const my = ++seq;
  stopPending();
  previewFor = null;
  const projectId = rfStore.getState().projectId;
  const aiAvailable = await aiReady(projectId);
  if (my !== seq) return;
  const chosen: AutoplanSource = source ?? (aiAvailable ? 'ai' : 'rules');
  set({ ...initial(), source: chosen, aiAvailable });

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
  const sectors = planSectors(units, rfStore.getState().sectors.sectors).sectors;
  const m = matchCellExport(text, units, sectors, catalogueOf());
  if ('error' in m) {
    set({
      phase: 'error',
      error:
        m.error === 'empty'
          ? 'The cell export is empty.'
          : 'The cell export has no antenna column.',
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
    warnings: m.unmatchedUnits.map((id) => `No export row for ${nameOf(id)}`),
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
    set({ phase: 'error', error: 'No project is open.' });
    return;
  }
  set({ phase: 'preview' });
  let r: Awaited<ReturnType<typeof bridge.call<'ai:rfPlanPreview'>>>;
  try {
    r = await bridge.call('ai:rfPlanPreview', { projectId, unitIds });
  } catch (e) {
    if (my === seq) set({ phase: 'error', error: messageOf(e) });
    return;
  }
  if (my !== seq) return;
  const v = unwrap(r);
  if (!v.ok) {
    set({ phase: 'error', error: v.error || 'The AI is not available.' });
    return;
  }
  previewFor = { projectId, unitIds };
  set({ preview: v.value });
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
  const my = ++seq;
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
    if (my === seq) {
      pendingRunId = null;
      set({ phase: 'error', error: messageOf(e) });
    }
    return;
  }
  if (my !== seq) return;
  pendingRunId = null;
  const v = unwrap(r);
  if (!v.ok) {
    set({ phase: 'error', error: v.error || 'The AI did not answer.' });
    return;
  }
  if (rfStore.getState().projectId !== target.projectId) {
    set({ phase: 'idle' });
    return;
  }
  try {
    set({
      phase: 'review',
      proposal: proposalFrom(units, aiPicks(sent, v.value.picks)),
      warnings: [...v.value.warnings],
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
      { ...rules, confidence: 'low', reason: `The AI gave no pick. ${rules.reason}` },
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
  set({ ...initial(), aiAvailable: get().aiAvailable, source: get().source });
}

/**
 * Write the reviewed proposal into the working copy (Apply only: left unsaved, C6), then with
 * `run` start a coverage run, which saves first. Null when nothing was in review or no run was
 * asked for.
 */
export async function applyAutoplan(run: boolean): Promise<StartResult | null> {
  const { phase, proposal } = get();
  if (phase !== 'review' || !proposal) return null;
  applyPlan(proposal);
  cancelAutoplan();
  if (!run) return null;
  const root = workspace.getState().project?.root;
  if (!root) return null;
  return startRfRun(root);
}

/**
 * "Review antennas first": the inventory's review when it offers one (and is loaded), else the
 * first draft revealed in the Measure bench's inventory, else the Measure bench.
 */
export function openAntennaReviewOrFallback(bench: StoreApi<WorkbenchState> = workbench): void {
  const review = (antennas as Record<string, unknown>).openAntennaReview;
  const a = antennas.antennaStore.getState();
  if (typeof review === 'function' && a.status === 'ready') {
    (review as () => void)();
    return;
  }
  const firstDraft = a.file?.units.find((u) => u.status === 'draft');
  if (firstDraft) antennas.revealAntenna(firstDraft.id);
  bench.getState().open('measure');
}

// ---------------------------------------------------------------- the chip

const FAIR_OR_BETTER = new Set(['excellent', 'good', 'fair']);

/** The Coverage chip's state from the RF store, the detected units and Auto-plan. */
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
  if (run && !rf.dirty) {
    const pct = rf.classStats
      ? Math.round(
          rf.classStats.filter((c) => FAIR_OR_BETTER.has(c.cls)).reduce((t, c) => t + c.share, 0) *
            100,
        )
      : null;
    return { kind: 'result', view: rf.view, fairOrBetterPct: pct, at: run.createdAt };
  }

  const known = new Set(antennaUnits.map((u) => u.id));
  const planned = rf.sectors.sectors.flatMap((s) => s.antennaIds).filter((id) => known.has(id));
  const setUp = (id: string) => {
    const s = rf.sectors.antennas.find((a) => a.antennaId === id);
    return s?.equipment !== undefined && s.carriers.length > 0;
  };
  if (planned.length > 0 && planned.every(setUp))
    return { kind: 'ready', sectors: rf.sectors.sectors.length };
  return { kind: 'not-planned', accepted };
}
