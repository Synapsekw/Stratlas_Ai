import { PANO_HIGH_MIN_TEXTURE, type PanoQuality, type PanoScan } from '@aio/schema';
import { formatBytes, t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge } from '../shell';
import { timeline } from '../workspace/timeline';
import { PANO_FLY_DISTANCE_M } from './panoModel';

export interface PanoImportState {
  open: boolean;
  scan: PanoScan | null;
  busy: { phase: 'scan' | 'copy'; done: number; total: number } | null;
  error: string | null;
  notStarted: string | null;
}

const CLOSED: PanoImportState = {
  open: false,
  scan: null,
  busy: null,
  error: null,
  notStarted: null,
};

/** The drone panorama import: the preview's scan, progress and outcome. */
export const panoImport = createStore<PanoImportState>()(() => ({ ...CLOSED }));

export function usePanoImport<T>(selector: (s: PanoImportState) => T): T {
  return useStore(panoImport, selector);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function defaultLayerName(day: string | null): string {
  const m = day === null ? null : /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return t('pano.layerNameUndated');
  return t('pano.layerName', { date: `${String(Number(m[2]))} ${MONTHS[Number(m[1]) - 1] ?? ''}` });
}

export function defaultKeys(scan: PanoScan): string[] {
  return [
    ...scan.spheres.filter((s) => s.alreadyIn === undefined).map((s) => s.key),
    ...scan.ready.map((r) => r.key),
  ];
}

export function summaryText(scan: PanoScan, keys: readonly string[]): string {
  const chosen = new Set(keys);
  const spheres = scan.spheres.filter((s) => chosen.has(s.key));
  const ready = scan.ready.filter((r) => chosen.has(r.key));
  const count = spheres.length + ready.length;
  const frames = spheres.map((s) => String(s.frames)).join(' + ') || '0';
  const bytes = spheres.reduce((n, s) => n + s.bytes, 0) + ready.reduce((n, r) => n + r.bytes, 0);
  if (count === 0) return t('pano.preview.noneSelected');
  const parts = [t('pano.preview.found', { count, frames })];
  if (scan.skipped.length) parts.push(t('pano.preview.skipped', { count: scan.skipped.length }));
  parts.push(t('pano.preview.copied', { size: formatBytes(bytes) }));
  return parts.join(' · ');
}

export function canUseHigh(maxTexture: number): boolean {
  return maxTexture >= PANO_HIGH_MIN_TEXTURE;
}

/** The GPU's largest texture edge (WebGL 2), or 0 when it cannot be asked. */
export function maxTextureSize(): number {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const n = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return n;
  } catch {
    return 0;
  }
}

let unlisten: (() => void) | null = null;
function listen(): void {
  if (unlisten || typeof window === 'undefined' || !('aio' in window)) return;
  unlisten = window.aio.on('panos:progress', (e) => {
    if (e.projectId !== workspace.getState().project?.id) return;
    panoImport.setState({ busy: { phase: e.phase, done: e.done, total: e.total } });
  });
}

export function openPanoScan(scan: PanoScan): void {
  run++;
  panoImport.setState({ ...CLOSED, open: true, scan });
}

/** Bumped by every scan, import and close: a result that finds it changed is stale. */
let run = 0;

function failure(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function scanPanoPaths(paths: readonly string[]): Promise<void> {
  const project = workspace.getState().project;
  if (!project) {
    panoImport.setState({ ...CLOSED, open: true, error: t('pano.noProject') });
    return;
  }
  listen();
  const mine = ++run;
  panoImport.setState({ ...CLOSED, open: true, busy: { phase: 'scan', done: 0, total: 0 } });
  let next: Partial<PanoImportState>;
  try {
    const r = await bridge.call('panos:scan', { projectId: project.id, paths: [...paths] });
    if (!r.ok) next = { busy: null, error: r.error };
    else if (!r.value.ok) next = { busy: null, error: r.value.error };
    else next = { busy: null, scan: r.value.scan };
  } catch (e) {
    next = { busy: null, error: failure(e) };
  }
  if (mine === run) panoImport.setState(next);
}

export async function pickAndScanPanos(): Promise<void> {
  const r = await bridge.call('dialog:openFolder', { title: t('pano.pick') });
  if (!r.ok || r.value.path === null) return;
  await scanPanoPaths([r.value.path]);
}

/**
 * Show what an import made: focus its survey date (the tree opens that date and its Panoramas
 * group) and fly to the spheres. The timeline learns the new date a render after the manifest, so
 * the focus waits for it.
 */
export function revealPanoLayer(layerId: string): void {
  const layer = workspace.getState().project?.manifest.layers.find((l) => l.id === layerId);
  if (layer?.kind !== 'panoramas') return;
  const capture = layer.capture;
  const projectId = workspace.getState().project?.id;
  const fly = () => {
    const spots = layer.items.flatMap((p) => (p.pos ? [p.pos] : []));
    if (spots.length === 0) return;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of spots)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] ?? 0, p[k] ?? 0);
        hi[k] = Math.max(hi[k] ?? 0, p[k] ?? 0);
      }
    const centre: [number, number, number] = [0, 1, 2].map(
      (k) => ((lo[k] ?? 0) + (hi[k] ?? 0)) / 2,
    ) as [number, number, number];
    const reach = Math.hypot(...[0, 1, 2].map((k) => ((hi[k] ?? 0) - (lo[k] ?? 0)) / 2));
    workspace
      .getState()
      .flyTo({ kind: 'point', p: centre, distance: Math.max(PANO_FLY_DISTANCE_M, reach * 2.5) });
  };
  if (!capture) {
    fly();
    return;
  }
  /** true: finished (flew, or the project changed or the focus was refused); false: keep waiting */
  let done = false;
  const focus = () => {
    if (done) return true;
    if (workspace.getState().project?.id !== projectId) return (done = true);
    const tl = timeline.getState();
    if (!tl.index?.captures.some((c) => c.id === capture)) return false;
    done = true; // focusing notifies this very subscriber
    tl.focusSurvey(capture);
    if (timeline.getState().focus === capture) fly();
    return true;
  };
  if (focus()) return;
  const off = timeline.subscribe(() => {
    if (focus()) {
      off();
      clearTimeout(giveUp);
    }
  });
  const giveUp = setTimeout(off, 10_000);
}

export async function importPanos(choice: {
  keys: string[];
  layerName: string;
  date?: string;
  quality: PanoQuality;
}): Promise<string | null> {
  const project = workspace.getState().project;
  const scan = panoImport.getState().scan;
  if (!project || !scan) return t('pano.noProject');
  listen();
  const mine = ++run;
  panoImport.setState({ busy: { phase: 'copy', done: 0, total: 0 }, error: null });
  let r;
  try {
    r = await bridge.call('panos:import', {
      projectId: project.id,
      scanId: scan.scanId,
      keys: choice.keys,
      layerName: choice.layerName,
      ...(choice.date ? { date: choice.date } : {}),
      quality: choice.quality,
    });
  } catch (e) {
    const error = failure(e);
    if (mine === run) panoImport.setState({ busy: null, error });
    return error;
  }
  const error = !r.ok ? r.error : !r.value.ok ? r.value.error : null;
  if (error !== null || !r.ok || !r.value.ok) {
    if (mine === run) panoImport.setState({ busy: null, error });
    return error;
  }
  // The files and the layer exist even if the dialog was cancelled meanwhile; the manifest is
  // this project's, so it is not taken when another project opened in the meantime.
  if (workspace.getState().project?.id === project.id) {
    workspace.getState().replaceManifest(r.value.manifest);
    revealPanoLayer(r.value.layerId);
  }
  if (mine !== run) return null;
  if (r.value.notStarted) panoImport.setState({ busy: null, notStarted: r.value.notStarted });
  else panoImport.setState({ ...CLOSED });
  return null;
}

export async function closePanoImport(): Promise<void> {
  const { busy } = panoImport.getState();
  const project = workspace.getState().project;
  run++;
  panoImport.setState({ ...CLOSED });
  if (busy?.phase === 'copy' && project) {
    try {
      await bridge.call('panos:cancelImport', { projectId: project.id });
    } catch {
      // the copy ends on its own; nothing to show
    }
  }
}
