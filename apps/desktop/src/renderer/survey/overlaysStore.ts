/**
 * Terrain overlays in the renderer (M11 G5, SRV-8): the site's `survey/overlays.json` through
 * `survey:readOverlays` and `survey:writeOverlays`, new overlays as `survey.overlay` jobs (contours,
 * gradient, elevation ramp, shaded relief), visibility and removal. `Overlays.tsx` is the panel,
 * `overlaysMap.ts` draws them on the map.
 */
import type { OverlayKind, SurfaceRef, SurveyOverlaysFile } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge } from '../shell';
import { waitForJob } from './sectionStore';

export interface OverlaysState {
  projectId: string | null;
  file: SurveyOverlaysFile | null;
  readOnly: boolean;
  error: string | null;
  open: boolean;
  /** The overlay being made (its kind), while its job runs. */
  making: OverlayKind | null;
  note: string | null;
}

export const overlays = createStore<OverlaysState>()(() => ({
  projectId: null,
  file: null,
  readOnly: false,
  error: null,
  open: false,
  making: null,
  note: null,
}));

export function useOverlays<T>(selector: (s: OverlaysState) => T): T {
  return useStore(overlays, selector);
}

const set = (p: Partial<OverlaysState>) => {
  overlays.setState(p);
};

export function setOverlaysOpen(open: boolean): void {
  set({ open });
}

export async function loadOverlays(projectId: string): Promise<void> {
  if (overlays.getState().projectId !== projectId)
    set({ projectId, file: null, error: null, note: null, making: null });
  const r = await bridge.call('survey:readOverlays', { projectId });
  if (overlays.getState().projectId !== projectId) return;
  if (!r.ok || !r.value.ok) {
    set({ error: !r.ok ? r.error : r.value.ok ? null : r.value.error });
    return;
  }
  set({ file: r.value.file, readOnly: r.value.readOnly, error: null });
}

async function save(next: SurveyOverlaysFile): Promise<string | null> {
  const { projectId } = overlays.getState();
  if (!projectId) return 'No project is open.';
  const r = await bridge.call('survey:writeOverlays', { projectId, file: next });
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  if (error) {
    await loadOverlays(projectId);
    set({ error });
    return error;
  }
  set({ file: next, error: null });
  return null;
}

export function setVisible(id: string, visible: boolean): Promise<string | null> {
  const f = overlays.getState().file;
  if (!f) return Promise.resolve('The overlays are not loaded.');
  return save({ ...f, overlays: f.overlays.map((o) => (o.id === id ? { ...o, visible } : o)) });
}

export function removeOverlay(id: string): Promise<string | null> {
  const f = overlays.getState().file;
  if (!f) return Promise.resolve('The overlays are not loaded.');
  return save({ ...f, overlays: f.overlays.filter((o) => o.id !== id) });
}

export interface NewOverlay {
  kind: OverlayKind;
  /** A prepared surface id, or the difference of a comparison. */
  surface?: string;
  comparison?: { from: SurfaceRef; to: SurfaceRef };
  options: Record<string, unknown>;
}

/** Make an overlay with `survey.overlay`; answers an error sentence or null when it is listed. */
export async function createOverlay(req: NewOverlay): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  set({ making: req.kind, note: null, error: null });
  const params = {
    kind: req.kind,
    options: req.options,
    ...(req.surface !== undefined ? { surface: req.surface } : {}),
    ...(req.comparison !== undefined ? { comparison: req.comparison } : {}),
  };
  const r = await bridge.call('jobs:start', {
    pipeline: 'survey.overlay',
    project: project.root,
    params,
  });
  const failed = (error: string) => {
    set({ making: null, error });
    return error;
  };
  if (!r.ok) return failed(r.error);
  if (!r.value.ok) return failed(r.value.error);
  const done = await waitForJob(r.value.job.id);
  if (!done.ok) return failed(done.error);
  await loadOverlays(project.id);
  set({ making: null, note: 'Overlay made.' });
  return null;
}
