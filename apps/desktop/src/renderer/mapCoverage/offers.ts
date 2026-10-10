/**
 * The street map offer of the open project: when a project placed on the Earth opens (or a new
 * one is created and opens) and no installed pack covers its site in detail, either a small
 * notice names the areas and their size and waits for Download, or, with "Download street maps
 * for new projects automatically" on, the same areas are queued at once and the notice says so.
 * Each project is offered once per workstation. Nothing happens on an offline-only workstation.
 */
import { frameProjection } from '@aio/maps';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, shell } from '../shell';
import { handledProjects, markHandled, offerFor, prefsOf, type QueueResult } from './offer';
import { chosenRegions, coveragePlan, projectCoverage, type PlannedRegion } from './plan';
import { mapCoverage } from './store';

export interface ProjectMapOffer {
  projectId: string;
  name: string;
  regions: PlannedRegion[];
  /** `ask`: waiting for an answer; `starting`: Download pressed; `started`: in Downloads. */
  state: 'ask' | 'starting' | 'started';
  /** Queued without asking (the opt-in preference). */
  auto: boolean;
  result: QueueResult | null;
}

interface OfferState {
  offer: ProjectMapOffer | null;
}

export const projectMapOffer = createStore<OfferState>()(() => ({ offer: null }));

export function useProjectMapOffer(): ProjectMapOffer | null {
  return useStore(projectMapOffer, (s) => s.offer);
}

/** WGS84 place of a project origin, or null when it is not placed on the Earth. */
export function placeOf(
  manifest: Pick<ProjectManifest, 'crs' | 'origin'>,
): [number, number] | null {
  try {
    const proj = frameProjection(manifest.crs, manifest.origin);
    if (!proj) return null;
    const [lon, lat] = proj.toLonLat([0, 0, 0]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    return [((((lon + 180) % 360) + 360) % 360) - 180, lat];
  } catch {
    return null;
  }
}

const stillOpen = (projectId: string) => workspace.getState().project?.id === projectId;

/**
 * Where the project is: from its manifest when the maps can work it out themselves (UTM,
 * WGS84), else as the Globe places it (`globe:sites`, every coordinate system the app knows).
 */
async function placeOfProject(
  projectId: string,
  manifest: ProjectManifest,
): Promise<readonly [number, number] | null> {
  const own = placeOf(manifest);
  if (own) return own;
  const r = await bridge.call('globe:sites', {});
  const sites = r.ok && r.value.ok ? r.value.sites : [];
  return sites.find((s) => s.projectId === projectId)?.lonLat ?? null;
}

async function evaluate(projectId: string, manifest: ProjectManifest): Promise<void> {
  const offlineOnly = shell.getState().settings.offlineOnly === true;
  if (offlineOnly || handledProjects().includes(projectId)) return;
  const lonLat = await placeOfProject(projectId, manifest);
  if (!lonLat || !stillOpen(projectId)) return;
  const [packs, jobs, globe] = await Promise.all([
    bridge.call('packs:list', {}),
    bridge.call('packs:jobs', {}),
    bridge.call('globe:getSettings', {}),
  ]);
  if (!packs.ok || !stillOpen(projectId)) return;
  const me = { id: projectId, name: manifest.name, lonLat };
  const regions = chosenRegions(coveragePlan([me], packs.value, jobs.ok ? jobs.value : []));
  const action = offerFor({
    located: true,
    covered: projectCoverage([me], packs.value)[0]?.status === 'detail',
    demo: !!shell.getState().library?.find((e) => e.id === projectId)?.demo,
    // read again: another evaluation of the same project may have answered meanwhile
    handled: handledProjects().includes(projectId),
    offlineOnly: shell.getState().settings.offlineOnly === true,
    prefs: prefsOf(globe.ok && globe.value.ok ? globe.value.settings.projectMaps : undefined),
    regions: regions.length,
  });
  if (action === 'none') return;
  const offer: ProjectMapOffer = {
    projectId,
    name: manifest.name,
    regions,
    state: 'ask',
    auto: action === 'auto',
    result: null,
  };
  if (action === 'prompt') {
    projectMapOffer.setState({ offer });
    return;
  }
  // the opt-in preference: queue now, and say what was queued
  markHandled(projectId);
  projectMapOffer.setState({ offer: { ...offer, state: 'starting' } });
  const result = await mapCoverage.getState().download(regions);
  if (projectMapOffer.getState().offer?.projectId === projectId)
    projectMapOffer.setState({ offer: { ...offer, state: 'started', result } });
}

/** Download pressed on the notice: queue the areas it named. */
export async function acceptOffer(): Promise<void> {
  const offer = projectMapOffer.getState().offer;
  if (offer?.state !== 'ask') return;
  markHandled(offer.projectId);
  projectMapOffer.setState({ offer: { ...offer, state: 'starting' } });
  const result = await mapCoverage.getState().download(offer.regions);
  if (projectMapOffer.getState().offer?.projectId === offer.projectId)
    projectMapOffer.setState({ offer: { ...offer, state: 'started', result } });
}

/** Close the notice; an unanswered offer is not made again for this project. */
export function dismissOffer(): void {
  const offer = projectMapOffer.getState().offer;
  if (offer) markHandled(offer.projectId);
  projectMapOffer.setState({ offer: null });
}

/** Open the panel instead, to choose the areas there. */
export function reviewOffer(): void {
  dismissOffer();
  mapCoverage.getState().openPanel();
}

const keyOf = (p: { id: string; manifest: ProjectManifest } | null) =>
  p ? `${p.id}|${JSON.stringify(p.manifest.crs)}|${p.manifest.origin.join(',')}` : null;

let started = false;

/** Follow the open project from now on (once). */
export function startProjectMapOffers(): void {
  if (started) return;
  started = true;
  let key: string | null = null;
  const check = () => {
    const project = workspace.getState().project;
    const next = keyOf(project);
    if (next === key) return;
    key = next;
    // another project (or none): the notice of the last one goes
    if (projectMapOffer.getState().offer?.projectId !== project?.id)
      projectMapOffer.setState({ offer: null });
    if (project) void evaluate(project.id, project.manifest);
  };
  workspace.subscribe(check);
  check();
}
