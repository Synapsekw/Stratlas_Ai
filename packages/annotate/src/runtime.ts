import { getActiveScene } from '@aio/engine';
import { normaliseSamples } from '@aio/geo';
import type { Issue, Layer, PoseSample, Sighting, Vec2 } from '@aio/schema';
import { assetUrl, workspace } from '@aio/workspace';
import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createDeriver } from './crossview/derive';
import { createIssueEditor, type EditorState, type IssueEditor } from './model/editor';
import { createIssueSaver, ipcWriteIssues } from './model/persist';
import { bestAnchor } from './tools/mesh';

// ---- cross-view caches (filled by the viewers) ----

const flights = new Map<string, readonly PoseSample[]>();
const sizes = new Map<string, Vec2>();
const sizeKey = (layer: string, photo: string | null) => `${layer}\u0000${photo ?? ''}`;

/** Seam for the video stream: hand over the flight poses of a video layer once loaded. */
export function setFlightPoses(layerId: string, samples: readonly PoseSample[]): void {
  flights.set(layerId, samples);
}

export function getFlightPoses(layerId: string): readonly PoseSample[] | null {
  return flights.get(layerId) ?? null;
}

/** Fetch `aio.flight/1` poses for a video layer (once) when nobody has provided them. */
export async function loadFlightPoses(
  projectId: string,
  layer: Extract<Layer, { kind: 'video' }>,
): Promise<readonly PoseSample[] | null> {
  const known = flights.get(layer.id);
  if (known) return known;
  try {
    const res = await fetch(assetUrl(projectId, layer.flight.src));
    if (!res.ok) return null;
    const json = (await res.json()) as { samples?: PoseSample[] };
    if (!Array.isArray(json.samples)) return null;
    const samples = normaliseSamples(json.samples);
    flights.set(layer.id, samples);
    return samples;
  } catch {
    return null;
  }
}

/** Remember the pixel size of a photo (or a video frame when `photoId` is null). */
export function rememberImageSize(layerId: string, photoId: string | null, size: Vec2): void {
  sizes.set(sizeKey(layerId, photoId), size);
}

// ---- the app-wide issue editor ----

export const issueSaver = createIssueSaver({ write: ipcWriteIssues, delayMs: 600 });

/** Read-only while the open project is a customer package (player mode): no tools, no edits. */
const readOnlyStore = createStore<{ readOnly: boolean }>()(() => ({ readOnly: false }));

/** The shell switches this on when a read-only package opens and off when it closes. */
export function setAnnotateReadOnly(on: boolean): void {
  readOnlyStore.setState({ readOnly: on });
  if (on) annotateUi.setState({ pending: null, meshTool: null, attachToSelected: false });
}

export function isAnnotateReadOnly(): boolean {
  return readOnlyStore.getState().readOnly;
}

export function useAnnotateReadOnly(): boolean {
  return useStore(readOnlyStore, (s) => s.readOnly);
}

/**
 * M9 integration: who the names on issues are. Issue chips and the register show initials (the
 * team's, else derived from the name) with the name as tooltip; under a team approval policy the
 * status buttons leave approving to the Approvals panel.
 */
export interface AnnotationPeople {
  /** Display name to initials (members of the open project and this person). */
  initials: Readonly<Record<string, string>>;
  /** The open project has a team approval policy: approving goes through approvals. */
  teamPolicy: boolean;
}

const peopleStore = createStore<AnnotationPeople>()(() => ({ initials: {}, teamPolicy: false }));

export function setAnnotationPeople(people: AnnotationPeople): void {
  peopleStore.setState(people);
}

/** Initials from a name: first letters of the first and last words (any script), up to 2. */
export function initialsFromName(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/u)
    .map((w) => /\p{L}/u.exec(w)?.[0] ?? '')
    .filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  return picked.join('').toLocaleUpperCase() || '?';
}

/** The initials shown for an author name. */
export function useAuthorInitials(): (name: string) => string {
  const map = useStore(peopleStore, (s) => s.initials);
  return (name: string) => map[name] ?? initialsFromName(name);
}

export function useTeamPolicy(): boolean {
  return useStore(peopleStore, (s) => s.teamPolicy);
}

let author = 'user';
/** Name written into new issues and the audit trail (the shell sets it from Settings). */
export function setAnnotationAuthor(name: string): void {
  author = name.trim() || 'user';
}

export const issueEditor: IssueEditor = createIssueEditor({
  store: workspace,
  saver: issueSaver,
  author: () => author,
  readOnly: isAnnotateReadOnly,
  derive: createDeriver({
    layers: () => workspace.getState().project?.manifest.layers ?? [],
    scene: () => getActiveScene(),
    flight: getFlightPoses,
    imageSize: (layer, photo) => sizes.get(sizeKey(layer, photo)) ?? null,
  }),
});

export function useIssueEditorState(): EditorState {
  return useSyncExternalStore(
    (l) => issueEditor.subscribe(l),
    () => issueEditor.state,
    () => issueEditor.state,
  );
}

/** Select an issue everywhere and fly the 3D view to its best sighting. */
export function focusIssue(issue: Issue): void {
  const ws = workspace.getState();
  ws.select({ kind: 'issue', id: issue.id });
  const p = bestAnchor(issue);
  ws.flyTo(
    p
      ? { kind: 'point', p, distance: 4 }
      : { kind: 'selection', selection: { kind: 'issue', id: issue.id } },
  );
}

// ---- annotation UI state shared by the viewers ----

export type ImageTool = 'select' | 'box' | 'rotbox' | 'polygon' | 'point';
export type MeshTool = 'point' | 'polyline' | 'polygon';

export interface PendingSighting {
  sighting: Sighting;
  /** Client-pixel position for the class and severity popover. */
  at?: { x: number; y: number };
}

export interface AnnotateUiState {
  imageTool: ImageTool;
  meshTool: MeshTool | null;
  pending: PendingSighting | null;
  /** When true, new sightings join the selected issue instead of creating one. */
  attachToSelected: boolean;
  lastClassId: string | null;
  lastSeverity: Issue['severity'] | null;
}

export const annotateUi = createStore<AnnotateUiState>()(() => ({
  imageTool: 'select',
  meshTool: null,
  pending: null,
  attachToSelected: false,
  lastClassId: null,
  lastSeverity: null,
}));

export function useAnnotateUi<T>(selector: (s: AnnotateUiState) => T): T {
  return useStore(annotateUi, selector);
}

/**
 * A tool finished a shape. Attach it to the selected issue (when that mode is on) or open the
 * class and severity picker for a new issue.
 */
export function beginSighting(sighting: Sighting, at?: { x: number; y: number }): void {
  if (isAnnotateReadOnly()) return;
  const sel = workspace.getState().selection;
  if (annotateUi.getState().attachToSelected && sel?.kind === 'issue') {
    issueEditor.addSighting(sel.id, sighting);
    return;
  }
  annotateUi.setState({ pending: at ? { sighting, at } : { sighting } });
}

export function cancelSighting(): void {
  annotateUi.setState({ pending: null });
}

/** Create the issue for the pending sighting and select it. */
export function confirmSighting(classId: string, severity: Issue['severity']): string | null {
  const pending = annotateUi.getState().pending;
  if (!pending) return null;
  const r = issueEditor.create({ sighting: pending.sighting, classId, severity });
  if (!r.ok) return r.error;
  annotateUi.setState({ pending: null, lastClassId: classId, lastSeverity: severity });
  workspace.getState().select({ kind: 'issue', id: r.value.id });
  return null;
}
