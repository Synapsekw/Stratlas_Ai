/**
 * The site's designs in the renderer (M11 G6): `survey/designs.json` through `survey:readDesigns`
 * and `survey:writeDesigns`, imports as `design.import` jobs, the active alignment and the station
 * and offset the cursor readout shows. Panels: `Designs.tsx`, `Alignments.tsx`, `Compliance.tsx`.
 */
import {
  Alignment,
  type AioBridge,
  type DesignEntry,
  type DesignLayer,
  type DesignsFile,
} from '@aio/schema';
import { alignmentPolyline, formatStation, stationOffset } from '@aio/survey';
import { assetUrl, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, jobs } from '../shell';

export interface ActiveAlignment {
  ref: string;
  name: string;
  alignment: Alignment;
}

export interface DesignsState {
  projectId: string | null;
  file: DesignsFile | null;
  error: string | null;
  busy: boolean;
  /** The alignment the cursor readout follows (`activeAlignment` of the file), loaded. */
  active: ActiveAlignment | null;
}

export const designs = createStore<DesignsState>()(() => ({
  projectId: null,
  file: null,
  error: null,
  busy: false,
  active: null,
}));

export function useDesigns<T>(selector: (s: DesignsState) => T): T {
  return useStore(designs, selector);
}

const designPath = (designId: string, file: string) => `survey/designs/${designId}/${file}`;

/** The URL of a file in a design's folder (download the source, the GLB, the TIN). */
export function designFileUrl(projectId: string, designId: string, file: string): string {
  return assetUrl(projectId, { path: designPath(designId, file) });
}

async function fetchJson(projectId: string, path: string): Promise<unknown> {
  const r = await fetch(assetUrl(projectId, { path }));
  if (!r.ok) throw new Error(`Could not read ${path} (${String(r.status)}).`);
  return (await r.json()) as unknown;
}

/** Load an alignment layer's `aio.alignment/1`, with the layer's station interval when set. */
export async function loadAlignment(
  projectId: string,
  design: DesignEntry,
  layer: DesignLayer,
): Promise<Alignment> {
  const al = Alignment.parse(await fetchJson(projectId, designPath(design.id, layer.file)));
  const interval = (layer as { intervalM?: unknown }).intervalM;
  return typeof interval === 'number' && interval > 0 ? { ...al, intervalM: interval } : al;
}

function layerOf(file: DesignsFile | null, ref: string | undefined) {
  if (!file || !ref) return null;
  const [designId, layerId] = ref.split('/');
  const design = file.designs.find((d) => d.id === designId);
  const layer = design?.layers.find((l) => l.id === layerId);
  return design && layer ? { design, layer } : null;
}

async function syncActive(projectId: string, file: DesignsFile): Promise<void> {
  const found = layerOf(file, file.activeAlignment);
  if (!found || found.layer.archived) {
    designs.setState({ active: null });
    return;
  }
  try {
    const alignment = await loadAlignment(projectId, found.design, found.layer);
    designs.setState({
      active: { ref: file.activeAlignment ?? '', name: found.layer.name, alignment },
    });
  } catch (e) {
    designs.setState({ active: null, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Read the open project's designs (an empty list when it has none). */
export async function loadDesigns(projectId: string): Promise<void> {
  designs.setState({ projectId, busy: true, error: null });
  const r = await bridge.call('survey:readDesigns', { projectId });
  if (designs.getState().projectId !== projectId) return;
  if (!r.ok || !r.value.ok) {
    const error = r.ok ? (r.value.ok ? null : r.value.error) : r.error;
    designs.setState({ busy: false, file: null, active: null, error });
    return;
  }
  designs.setState({ busy: false, file: r.value.file });
  await syncActive(projectId, r.value.file);
}

/** Save a new version of the file; answers an error sentence or null. */
export async function saveDesigns(next: DesignsFile): Promise<string | null> {
  const { projectId } = designs.getState();
  if (!projectId) return 'No project is open.';
  designs.setState({ busy: true, error: null });
  const r = await bridge.call('survey:writeDesigns', { projectId, file: next });
  const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
  if (error) {
    designs.setState({ busy: false, error });
    // the file may have changed on disk (an import): show what is there now
    await loadDesigns(projectId);
    designs.setState({ error });
    return error;
  }
  designs.setState({ busy: false, file: next });
  await syncActive(projectId, next);
  return null;
}

const edit = (fn: (f: DesignsFile) => DesignsFile): Promise<string | null> => {
  const f = designs.getState().file;
  return f ? saveDesigns(fn(f)) : Promise.resolve('The designs are not loaded.');
};

export type LayerPatch = Partial<
  Pick<DesignLayer, 'name' | 'visible' | 'archived' | 'verticalOffsetM' | 'clamp'>
> & { intervalM?: number };

export function patchLayer(designId: string, layerId: string, patch: LayerPatch) {
  return edit((f) => ({
    ...f,
    designs: f.designs.map((d) =>
      d.id !== designId
        ? d
        : { ...d, layers: d.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)) },
    ),
    // archiving the active alignment deactivates it
    ...(patch.archived && f.activeAlignment === `${designId}/${layerId}`
      ? { activeAlignment: undefined }
      : {}),
  }));
}

export function patchDesign(designId: string, patch: { name?: string; folder?: string }) {
  return edit((f) => ({
    ...f,
    designs: f.designs.map((d) => (d.id === designId ? { ...d, ...patch } : d)),
  }));
}

/** Activate an alignment (`<design>/<layer>`), or none. */
export function activateAlignment(ref: string | null) {
  return edit((f) => {
    const rest = { ...f };
    delete rest.activeAlignment;
    return ref ? { ...rest, activeAlignment: ref } : rest;
  });
}

/** Pick a design file and start `design.import`; answers an error sentence or null. */
export async function importDesign(): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const pick = await bridge.call('dialog:openFile', {
    title: 'Import design',
    filters: [{ name: 'Design', extensions: ['xml', 'landxml', 'dxf', '12da', 'csv', 'txt'] }],
  });
  if (!pick.ok) return pick.error;
  if (!pick.value.path) return null;
  return startDesignImport(project.root, pick.value.path);
}

export async function startDesignImport(root: string, src: string): Promise<string | null> {
  watchImports();
  const r = await jobs
    .getState()
    .start({ pipeline: 'design.import', project: root, params: { src } });
  return r;
}

let watching = false;
/** Reload the designs when an import into the open project finishes. */
export function watchImports(): void {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (watching || !aio) return;
  watching = true;
  aio.on('jobs:event', (e) => {
    if (e.type !== 'update' || e.job.pipeline !== 'design.import' || e.job.status !== 'done')
      return;
    const project = workspace.getState().project;
    if (project?.root === e.job.project) void loadDesigns(project.id);
  });
}

/** `Sta 1+234.567  Off 2.500 R` for the cursor readout, or null without an active alignment. */
export function stationReadout(e: number, n: number): string | null {
  const active = designs.getState().active;
  if (!active) return null;
  const so = stationOffset(active.alignment, e, n);
  if (!so) return `${active.name}: off the alignment`;
  const side = so.offset > 0 ? ' R' : so.offset < 0 ? ' L' : '';
  return `Sta ${formatStation(so.station)}  Off ${Math.abs(so.offset).toFixed(3)}${side}`;
}

/** Fly the 3D view to a layer: the middle of its extent, from far enough to see all of it. */
export async function flyToLayer(design: DesignEntry, layer: DesignLayer): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const bounds = await layerBounds(project.id, design, layer).catch((e: unknown) =>
    e instanceof Error ? e.message : String(e),
  );
  if (typeof bounds === 'string') return bounds;
  if (!bounds) return 'The layer has nothing to show.';
  const [e0, n0, z0, e1, n1, z1] = bounds;
  const o = project.manifest.origin;
  const p: [number, number, number] = [
    (e0 + e1) / 2 - o[0],
    (z0 + z1) / 2 - o[2],
    -((n0 + n1) / 2 - o[1]),
  ];
  const size = Math.max(e1 - e0, n1 - n0, 10);
  workspace.getState().flyTo({ kind: 'point', p, distance: size * 1.2 });
  return null;
}

type Bounds = [number, number, number, number, number, number];

function boundsOf(points: Iterable<readonly number[]>): Bounds | null {
  let b: Bounds | null = null;
  for (const [e = 0, n = 0, z = 0] of points) {
    b = b
      ? [
          Math.min(b[0], e),
          Math.min(b[1], n),
          Math.min(b[2], z),
          Math.max(b[3], e),
          Math.max(b[4], n),
          Math.max(b[5], z),
        ]
      : [e, n, z, e, n, z];
  }
  return b;
}

async function layerBounds(
  projectId: string,
  design: DesignEntry,
  layer: DesignLayer,
): Promise<Bounds | null> {
  const path = designPath(design.id, layer.file);
  if (layer.kind === 'surface') {
    // the header holds the bounds: read the head of the file only
    const r = await fetch(assetUrl(projectId, { path }), { headers: { Range: 'bytes=0-65535' } });
    const buf = new Uint8Array(await r.arrayBuffer());
    const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + n))) as {
      bounds?: Bounds;
    };
    return header.bounds ?? null;
  }
  if (layer.kind === 'alignment') {
    const al = await loadAlignment(projectId, design, layer);
    return boundsOf(alignmentPolyline(al, 5).map(([e, n]) => [e, n, 0]));
  }
  const json = (await fetchJson(projectId, path)) as {
    points?: { e: number; n: number; z: number }[];
    features?: { geometry?: { coordinates?: number[][] } }[];
  };
  if (layer.kind === 'points') return boundsOf((json.points ?? []).map((p) => [p.e, p.n, p.z]));
  return boundsOf((json.features ?? []).flatMap((f) => f.geometry?.coordinates ?? []));
}
