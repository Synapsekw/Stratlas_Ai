import type { Layer, PoseSample } from '@aio/schema';
import { assetUrl, type OpenProject } from '@aio/workspace';
import { useEffect, useSyncExternalStore } from 'react';

type VideoLayer = Extract<Layer, { kind: 'video' }>;

interface MediaState {
  projectId: string | null;
  /** Clip lengths in ms from video metadata, by video layer id. */
  durations: Record<string, number>;
  /** Pose samples from flight logs, by video layer id. */
  flights: Record<string, PoseSample[]>;
}

let state: MediaState = { projectId: null, durations: {}, flights: {} };
const listeners = new Set<() => void>();
const pendingFlights = new Set<string>();

function emit(patch: Partial<MediaState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Read each clip's length from its video metadata (a range request, no full download). */
function probeDurations(project: OpenProject) {
  for (const layer of project.manifest.layers) {
    if (layer.kind !== 'video') continue;
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = () => {
      v.removeAttribute('src');
      v.load();
    };
    v.addEventListener(
      'loadedmetadata',
      () => {
        if (state.projectId === project.id && Number.isFinite(v.duration)) {
          emit({ durations: { ...state.durations, [layer.id]: Math.round(v.duration * 1000) } });
        }
        done();
      },
      { once: true },
    );
    v.addEventListener('error', done, { once: true });
    try {
      v.src = assetUrl(project.id, layer.src);
    } catch {
      /* invalid path in the manifest: the clip keeps its estimated length */
    }
  }
}

function isSamples(x: unknown): x is PoseSample[] {
  return (
    Array.isArray(x) &&
    x.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as { t?: unknown }).t === 'number' &&
        Array.isArray((s as { pos?: unknown }).pos),
    )
  );
}

/** Fetch a clip's flight log once; poses feed the selection card and telemetry readouts. */
export function loadFlight(project: OpenProject, layer: VideoLayer): void {
  const key = `${project.id}/${layer.id}`;
  if (state.flights[layer.id] || pendingFlights.has(key)) return;
  pendingFlights.add(key);
  let url: string;
  try {
    url = assetUrl(project.id, layer.flight.src);
  } catch {
    return;
  }
  fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((json: unknown) => {
      const samples = (json as { samples?: unknown }).samples;
      if (state.projectId === project.id && isSamples(samples)) {
        emit({ flights: { ...state.flights, [layer.id]: samples } });
      }
    })
    .catch(() => {
      /* no flight log: the card shows no live position for this clip */
    });
}

function ensureProject(project: OpenProject | null) {
  const id = project?.id ?? null;
  if (state.projectId === id) return;
  pendingFlights.clear();
  emit({ projectId: id, durations: {}, flights: {} });
  if (project) probeDurations(project);
}

/** Clip durations and flight logs of the open project, loaded on first use. */
export function useMedia(project: OpenProject | null): MediaState {
  useEffect(() => {
    ensureProject(project);
  }, [project]);
  return useSyncExternalStore(subscribe, () => state);
}

export function getMedia(): MediaState {
  return state;
}
