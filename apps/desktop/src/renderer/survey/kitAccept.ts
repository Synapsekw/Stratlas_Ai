/**
 * Converted old-kit piles take the standard-base figure once their surfaces exist (volumetrics
 * redesign, founder 24 Oct 2026; ADR 0013 point 4 as amended). When a project opens and after each
 * `survey.prepare` job ends, the piles still lying at Z 0 are given their heights again
 * (`repairKitHeightsNow`, which can now ask the prepared surfaces), then each converted pile whose
 * carried figure's dates all have a ready surface is accepted with the standard base
 * (`acceptCarriedQuietly`, computed as the person's "Recompute with the standard base"): the kit
 * figure stays in `previousResults` and shows as was in the pile's History. A migration, not an
 * edit: written on the saved baseline, never shown as unsaved, no undo step.
 *
 * Once per pile per open, and only in a writable project: a read-only project or package keeps its
 * carried figures (its height repair stays in memory).
 */
import type { MeasurementsFile } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { sameFolder } from '../jobs';
import { bridge, jobs } from '../shell';
import { acceptCarriedQuietly, compareStore } from './compareStore';
import { captureOfEpoch as epochCapture } from './kitHeights';
import { measureStore, repairKitHeightsNow } from './measureStore';
import { surfaceStates, type SurfaceState } from './surfaceStates';

/**
 * The converted piles to accept now: those with a carried headline figure whose every carried
 * date (headline and over time) is known and has a ready surface.
 */
export function kitPilesToAccept(
  file: MeasurementsFile,
  states: ReadonlyMap<string, SurfaceState>,
  captureOfEpoch: (epoch: string) => string | null,
): string[] {
  const out: string[] = [];
  for (const m of file.measurements) {
    if (!m.results.some((r) => r.carried)) continue;
    const rows = [...m.results, ...(m.series ?? [])];
    let ok = true;
    for (const r of rows) {
      if (!r.carried) continue;
      const date = captureOfEpoch(r.carried.epoch) ?? r.toCapture ?? null;
      if (date === null || states.get(date)?.kind !== 'ready') {
        ok = false;
        break;
      }
    }
    if (ok) out.push(m.id);
  }
  return out;
}

/** What acceptance looks at: the file as it is now, each date's surface, the kit's dates. */
export interface KitLook {
  file: MeasurementsFile;
  states: ReadonlyMap<string, SurfaceState>;
  captureOfEpoch: (epoch: string) => string | null;
}

export interface KitReadyDeps {
  /** Call `cb` when a project's measurements and the survey engine are ready; returns the stop. */
  onProjectOpen(cb: (projectId: string) => void): () => void;
  /** Call `cb` after a `survey.prepare` job ended and its surfaces were read again. */
  onJobEnded(cb: (projectId: string) => void): () => void;
  /** The open project may be written (not a package, not read-only). */
  writable(): boolean;
  /** `repairKitHeightsNow` (tests pass their own). */
  repair?: (projectId: string) => Promise<string[]>;
  /** What to accept from, or null while the project or engine is not ready. */
  look?: (projectId: string) => Promise<KitLook | null>;
  /** `acceptCarriedQuietly`: the ids accepted. */
  accept?: (ids: readonly string[]) => Promise<string[]>;
}

/** The open project's file, surface states and kit dates, read now. */
async function lookNow(projectId: string): Promise<KitLook | null> {
  const ms = measureStore.getState();
  const cs = compareStore.getState();
  const project = workspace.getState().project;
  if (ms.projectId !== projectId || ms.status !== 'ready') return null;
  if (cs.projectId !== projectId || cs.status !== 'ready') return null;
  if (project?.id !== projectId) return null;
  if (!ms.file.measurements.some((m) => m.results.some((r) => r.carried))) return null;
  const running = jobs.getState().jobs.filter((j) => sameFolder(j.project, project.root));
  const r = await bridge.call('project:readVolumes', { projectId });
  const volumes = r.ok && r.value.ok ? r.value.volumes : null;
  return {
    file: measureStore.getState().file,
    states: surfaceStates(project.manifest, cs.surfaces, running),
    captureOfEpoch: epochCapture(volumes),
  };
}

/** Repair and accept on open and after each prepare job; returns the stop. Called once at start. */
export function connectKitReady(deps: KitReadyDeps): () => void {
  const repair = deps.repair ?? repairKitHeightsNow;
  const look = deps.look ?? lookNow;
  const accept = deps.accept ?? acceptCarriedQuietly;
  let stopped = false;
  /** The project last opened and the piles already tried in it. */
  let open: { id: string; tried: Set<string> } | null = null;
  let chain: Promise<void> = Promise.resolve();

  const step = async (projectId: string): Promise<void> => {
    if (stopped || open?.id !== projectId) return;
    const mine = open;
    // still the same open, and allowed to write (read again after each wait)
    const still = () => !stopped && open === mine && deps.writable();
    await repair(projectId);
    if (!still()) return;
    const seen = await look(projectId);
    if (!seen || !still()) return;
    const ids = kitPilesToAccept(seen.file, seen.states, seen.captureOfEpoch).filter(
      (id) => !mine.tried.has(id),
    );
    if (ids.length === 0) return;
    for (const id of ids) mine.tried.add(id);
    await accept(ids);
  };

  // one look at a time, in the order asked
  const run = (projectId: string) => {
    chain = chain.then(() => step(projectId)).catch(() => undefined);
  };

  const offOpen = deps.onProjectOpen((projectId) => {
    if (stopped) return;
    open = { id: projectId, tried: new Set() };
    run(projectId);
  });
  const offEnded = deps.onJobEnded((projectId) => {
    if (stopped) return;
    run(projectId);
  });
  return () => {
    stopped = true;
    offOpen();
    offEnded();
  };
}
