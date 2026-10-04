import type { AssetRef, Issue, ProjectManifest, Vec3, WindowKind } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type SelectionKind = 'asset' | 'issue' | 'clip' | 'photo' | 'layer' | 'pano';

export interface Selection {
  kind: SelectionKind;
  id: string;
  /** Optional layer the selection belongs to (mesh node, photo set, video layer). */
  layer?: string;
}

export interface OpenProject {
  /** Stable id used in aio://project/<id>/ URLs. */
  id: string;
  root: string;
  manifest: ProjectManifest;
}

/** A request for the 3D camera; the scene consumes it and clears it. */
export interface CameraRequest {
  seq: number;
  target:
    | { kind: 'point'; p: Vec3; distance?: number }
    | { kind: 'selection'; selection: Selection }
    | { kind: 'home' };
}

export interface WorkspaceState {
  project: OpenProject | null;
  issues: Issue[];
  /** Project clock, UTC milliseconds. */
  nowMs: number;
  playing: boolean;
  rate: number;
  /** Video layer id whose clip drives the clock while playing. */
  activeClip: string | null;
  selection: Selection | null;
  hidden: Record<string, true>;
  focusedWindow: WindowKind | null;
  camera: CameraRequest | null;
}

export interface WorkspaceActions {
  openProject(project: OpenProject, issues?: Issue[]): void;
  closeProject(): void;
  /**
   * Replace the open project's manifest after an edit (import, alignment). Clock, selection and
   * visibility stay; new layers saved as hidden start hidden.
   */
  replaceManifest(manifest: ProjectManifest): void;
  setTime(nowMs: number): void;
  play(): void;
  pause(): void;
  setRate(rate: number): void;
  setActiveClip(layerId: string | null): void;
  select(selection: Selection | null): void;
  setLayerVisible(layerId: string, visible: boolean): void;
  isLayerVisible(layerId: string): boolean;
  upsertIssue(issue: Issue): void;
  removeIssue(issueId: string): void;
  focus(window: WindowKind | null): void;
  flyTo(target: CameraRequest['target']): void;
  consumeCamera(seq: number): void;
}

export type Workspace = WorkspaceState & WorkspaceActions;

const initial: WorkspaceState = {
  project: null,
  issues: [],
  nowMs: 0,
  playing: false,
  rate: 1,
  activeClip: null,
  selection: null,
  hidden: {},
  focusedWindow: null,
  camera: null,
};

export function createWorkspace(): StoreApi<Workspace> {
  let seq = 0;
  return createStore<Workspace>()((set, get) => ({
    ...initial,
    openProject: (project, issues = []) => {
      const firstClip = project.manifest.layers.find((l) => l.kind === 'video');
      set({
        ...initial,
        project,
        issues,
        activeClip: firstClip?.id ?? null,
        nowMs: firstClip?.kind === 'video' ? firstClip.flight.startUtcMs + firstClip.offsetMs : 0,
        hidden: Object.fromEntries(
          project.manifest.layers.filter((l) => !l.visible).map((l) => [l.id, true as const]),
        ),
      });
    },
    replaceManifest: (manifest) => {
      const { project, hidden, activeClip } = get();
      if (!project) return;
      const known = new Set(project.manifest.layers.map((l) => l.id));
      const added = manifest.layers.filter((l) => !known.has(l.id) && !l.visible);
      const clip = activeClip ? null : manifest.layers.find((l) => l.kind === 'video');
      set({
        project: { ...project, manifest },
        ...(clip?.kind === 'video'
          ? { activeClip: clip.id, nowMs: clip.flight.startUtcMs + clip.offsetMs }
          : {}),
        ...(added.length
          ? {
              hidden: { ...hidden, ...Object.fromEntries(added.map((l) => [l.id, true as const])) },
            }
          : {}),
      });
    },
    closeProject: () => {
      set(initial);
    },
    setTime: (nowMs) => {
      set({ nowMs });
    },
    play: () => {
      set({ playing: true });
    },
    pause: () => {
      set({ playing: false });
    },
    setRate: (rate) => {
      if (!(rate > 0 && rate <= 16))
        throw new Error(`Playback rate must be between 0 and 16, got ${rate}`);
      set({ rate });
    },
    setActiveClip: (activeClip) => {
      set({ activeClip });
    },
    select: (selection) => {
      set({ selection });
    },
    setLayerVisible: (layerId, visible) => {
      const hidden = Object.fromEntries(
        Object.entries(get().hidden).filter(([id]) => id !== layerId),
      ) as Record<string, true>;
      if (!visible) hidden[layerId] = true;
      set({ hidden });
    },
    isLayerVisible: (layerId) => !get().hidden[layerId],
    upsertIssue: (issue) => {
      const issues = get().issues.filter((i) => i.id !== issue.id);
      set({ issues: [...issues, issue] });
    },
    removeIssue: (issueId) => {
      set({ issues: get().issues.filter((i) => i.id !== issueId) });
    },
    focus: (focusedWindow) => {
      set({ focusedWindow });
    },
    flyTo: (target) => {
      seq += 1;
      set({ camera: { seq, target } });
    },
    consumeCamera: (s) => {
      if (get().camera?.seq === s) set({ camera: null });
    },
  }));
}

/** The app-wide workspace store. Tests create their own with createWorkspace(). */
export const workspace = createWorkspace();

export function useWorkspace<T>(selector: (s: Workspace) => T): T {
  return useStore(workspace, selector);
}

/** aio:// URL for a project asset. Paths are relative to the project root. */
export function assetUrl(projectId: string, ref: AssetRef): string {
  if ('hash' in ref)
    return `aio://project/${encodeURIComponent(projectId)}/assets/sha256/${ref.hash}`;
  const clean = ref.path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').includes('..'))
    throw new Error(`Asset path "${ref.path}" may not leave the project folder`);
  return `aio://project/${encodeURIComponent(projectId)}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}
