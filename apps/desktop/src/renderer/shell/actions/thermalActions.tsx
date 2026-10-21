import { defineAction, registerActions, type Action, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { bridge, shell } from '../../shell';
import { loadRasterIndex } from '../../thermal/raster';
import { useThermal } from '../../thermal/thermalStore';
import { workbench } from '../../workspace/workbench/workbenchStore';

/*
 * The entry to the Thermal bench (thermal analysis M1): Analyse thermal on a photo set that holds
 * thermal photos, and on a thermal photo. A menu asks synchronously, so the photo sets of the open
 * project are probed when it opens (`thermal:probe` reads each review copy's head) and the answer
 * is kept here. A package cannot be probed (decoding is barred there): its thermal photos are the
 * ones its raster index lists, so the bench opens on the temperatures it carries.
 */

type Target = Extract<MenuTarget, { kind: 'layers' | 'photos' }>;

/** Thermal photo ids per `"<projectId>\n<layerId>"`, in the order the probe or index gave them. */
const known = new Map<string, readonly string[]>();
const keyOf = (projectId: string, layerId: string) => `${projectId}\n${layerId}`;
/** How many photos each set held when it was last probed: a set that grows is probed again. */
const probedCount = new Map<string, number>();

/** The thermal photos of a set as last probed; empty when none, or not probed yet. */
export function thermalPhotosOf(projectId: string, layerId: string): readonly string[] {
  return known.get(keyOf(projectId, layerId)) ?? [];
}

/** Forget every probe answer (another project, or a test). */
export function forgetThermal(): void {
  known.clear();
  probedCount.clear();
}

/**
 * Find a set's thermal photos and keep them: the probe in a project folder, the raster index in a
 * package. Never throws; a failed probe keeps the set as having none.
 */
export async function primeThermal(
  projectId: string,
  layerId: string,
  pkg: boolean,
): Promise<readonly string[]> {
  let ids: string[] = [];
  try {
    if (pkg) {
      const index = await loadRasterIndex(projectId, layerId);
      ids = index ? Object.keys(index.photos) : [];
    } else {
      const r = await bridge.call('thermal:probe', { projectId, layerId });
      if (r.ok && r.value.ok)
        ids = r.value.photos.filter((p) => p.family !== null).map((p) => p.photoId);
    }
  } catch {
    ids = [];
  }
  known.set(keyOf(projectId, layerId), ids);
  return ids;
}

let priming: Promise<void> = Promise.resolve();

/** Resolves once the probes started for the open project have answered. */
export function thermalPrimed(): Promise<void> {
  return priming;
}

/** Probe the photo sets of the open project not probed yet or grown since, one at a time. */
function primeProject(): void {
  const before = priming;
  priming = before.then(primeSets);
}

async function primeSets(): Promise<void> {
  const project = workspace.getState().project;
  if (!project) return;
  const pkg = shell.getState().pkg !== null;
  for (const l of project.manifest.layers) {
    if (l.kind !== 'photos') continue;
    const key = keyOf(project.id, l.id);
    if (probedCount.get(key) === l.items.length) continue;
    // noted first, so a second manifest change while this runs does not probe it again
    probedCount.set(key, l.items.length);
    if (!known.has(key)) known.set(key, []);
    await primeThermal(project.id, l.id, pkg);
  }
}

/** The set and photo the bench opens on, or null when the target holds no thermal photo. */
function openingOf(tg: Target): { projectId: string; layerId: string; photoId: string } | null {
  const projectId = workspace.getState().project?.id;
  if (!projectId) return null;
  if (tg.kind === 'photos') {
    const pick = tg.picks.find((p) => thermalPhotosOf(projectId, p.layerId).includes(p.photoId));
    return pick ? { projectId, layerId: pick.layerId, photoId: pick.photoId } : null;
  }
  for (const layerId of tg.layerIds) {
    const first = thermalPhotosOf(projectId, layerId)[0];
    if (first !== undefined) return { projectId, layerId, photoId: first };
  }
  return null;
}

const actions: readonly Action[] = [
  defineAction<'layers' | 'photos'>({
    id: 'thermal.analyse',
    label: 'actions.thermal.analyse',
    icon: 'flare',
    section: 'open',
    targets: ['layers', 'photos'],
    appliesTo: (tg) => openingOf(tg) !== null,
    run: async (tg, ctx) => {
      const at = openingOf(tg);
      if (!at) return;
      workbench.getState().open('thermal');
      // a package or a reviewer who may only look: no probe, no decode
      await useThermal
        .getState()
        .open(at.projectId, at.layerId, at.photoId, { readOnly: ctx.pkg || !ctx.canEdit });
    },
  }),
];

/** Register Analyse thermal, and probe the photo sets of each project as it opens. */
export function registerThermalActions(): () => void {
  const off = registerActions(actions);
  let projectId = workspace.getState().project?.id ?? null;
  let manifest = workspace.getState().project?.manifest ?? null;
  primeProject();
  const unsub = workspace.subscribe((s) => {
    const id = s.project?.id ?? null;
    const m = s.project?.manifest ?? null;
    if (id === projectId && m === manifest) return;
    if (id !== projectId) forgetThermal();
    projectId = id;
    manifest = m;
    primeProject();
  });
  return () => {
    unsub();
    off();
  };
}
