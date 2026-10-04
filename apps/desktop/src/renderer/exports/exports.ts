import { issueSaver } from '@aio/annotate';
import { getActiveStage, type EngineStage } from '@aio/engine';
import type { ExportFormat } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { bridge, shell } from '../shell';
import {
  actionLabel,
  createToastStore,
  doneMessage,
  legendEntries,
  snapshotName,
  type ExportActionId,
} from './exportModel';

/** Toasts of running and finished exports, shown bottom right. */
export const toasts = createToastStore();

let listening = false;
function listen(): void {
  if (listening || typeof window.aio === 'undefined') return;
  listening = true;
  window.aio.on('export:progress', (p) => {
    toasts.getState().progress(p.jobId, p.phase, p.done, p.total);
  });
}

const jobId = () => globalThis.crypto.randomUUID().slice(0, 32);

/** Export the open project's issues: native save dialog, then a job with a progress toast. */
export async function exportIssues(format: ExportFormat): Promise<void> {
  const project = workspace.getState().project;
  if (!project) return;
  listen();
  // The export reads issues.json: write any pending edit first.
  await issueSaver.flush();
  const id = jobId();
  const t = toasts.getState();
  t.start(id, actionLabel(format));
  t.progress(id, 'Choose where to save', 0, 0);
  const r = await bridge.call('export:run', { jobId: id, projectId: project.id, format });
  if (!r.ok) {
    t.finish(id, 'error', r.error);
    return;
  }
  if (!r.value.ok) {
    t.finish(id, 'error', r.value.error);
    return;
  }
  if (r.value.path === null) {
    t.dismiss(id);
    return;
  }
  t.finish(
    id,
    'done',
    doneMessage(format, {
      path: r.value.path,
      ...(r.value.count === undefined ? {} : { count: r.value.count }),
    }),
  );
}

export function cancelExport(id: string): void {
  void bridge.call('export:cancel', { jobId: id });
  toasts.getState().dismiss(id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live 3D stage, opening the Scene with a 3D view first when needed. */
async function stageForSnapshot(): Promise<EngineStage | null> {
  let stage = getActiveStage();
  if (stage) return stage;
  const s = shell.getState();
  s.go('scene');
  if (s.stageMode === 'map') s.setStageMode('3d');
  for (let i = 0; i < 80 && !stage; i++) {
    await sleep(100);
    stage = getActiveStage();
  }
  if (stage) await sleep(1500); // let the model load and frame
  return stage;
}

function drawLegend(g: CanvasRenderingContext2D, w: number, h: number): void {
  const ws = workspace.getState();
  const project = ws.project;
  if (!project) return;
  const k = Math.max(1, Math.min(w, h) / 900);
  const entries = legendEntries(project.manifest, ws.issues);
  const pad = 14 * k;
  const line = 22 * k;
  const title = project.manifest.name;
  const sub = `${new Date().toISOString().slice(0, 10)}, ${String(ws.issues.length)} issues`;
  g.font = `600 ${String(15 * k)}px "IBM Plex Sans", sans-serif`;
  const widths = [g.measureText(title).width];
  g.font = `${String(13 * k)}px "IBM Plex Sans", sans-serif`;
  widths.push(g.measureText(sub).width);
  for (const e of entries)
    widths.push(g.measureText(`${e.label}  ${String(e.count)}`).width + 22 * k);
  const bw = Math.max(...widths) + pad * 2;
  const bh = pad * 2 + line * (2 + entries.length) - 4 * k;
  const x = 16 * k;
  const y = h - bh - 16 * k;
  g.fillStyle = 'rgba(15, 19, 24, 0.82)';
  g.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  g.lineWidth = 1;
  g.beginPath();
  g.roundRect(x, y, bw, bh, 6 * k);
  g.fill();
  g.stroke();
  let cy = y + pad + 14 * k;
  g.fillStyle = '#e6ebf2';
  g.font = `600 ${String(15 * k)}px "IBM Plex Sans", sans-serif`;
  g.fillText(title, x + pad, cy);
  cy += line;
  g.fillStyle = '#9aa5b4';
  g.font = `${String(13 * k)}px "IBM Plex Sans", sans-serif`;
  g.fillText(sub, x + pad, cy);
  for (const e of entries) {
    cy += line;
    g.fillStyle = e.color;
    g.beginPath();
    g.arc(x + pad + 6 * k, cy - 5 * k, 6 * k, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#e6ebf2';
    g.fillText(`${e.label}  ${String(e.count)}`, x + pad + 22 * k, cy);
  }
}

/** PNG of the 3D view at the current camera, with an optional severity legend. */
export async function captureSnapshot(legend: boolean): Promise<Uint8Array<ArrayBuffer> | null> {
  const stage = await stageForSnapshot();
  if (!stage) return null;
  // Render and read in the same task, so the drawing buffer still holds the frame.
  stage.renderer.render(stage.scene, stage.camera);
  const src = stage.renderer.domElement;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#0f1318';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0);
  if (legend) drawLegend(g, c.width, c.height);
  const blob = await new Promise<Blob | null>((r) => {
    c.toBlob(r, 'image/png');
  });
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export async function saveSnapshot(legend: boolean): Promise<void> {
  const project = workspace.getState().project;
  if (!project) return;
  const id = jobId();
  const t = toasts.getState();
  t.start(id, actionLabel('snapshot'));
  t.progress(id, 'Rendering the 3D view', 0, 0);
  const png = await captureSnapshot(legend);
  if (!png) {
    t.finish(id, 'error', 'The 3D view is not available for this project.');
    return;
  }
  t.progress(id, 'Choose where to save', 0, 0);
  const r = await bridge.call('dialog:saveFile', {
    defaultName: snapshotName(project.manifest.name, new Date()),
    data: png,
    title: 'Save 3D view snapshot',
  });
  if (!r.ok) t.finish(id, 'error', r.error);
  else if (r.value.error) t.finish(id, 'error', r.value.error);
  else if (r.value.path === null) t.dismiss(id);
  else t.finish(id, 'done', doneMessage('snapshot', { path: r.value.path }));
}

/** Run a menu or palette export action. */
export function runExportAction(id: ExportActionId, opts: { legend?: boolean } = {}): void {
  if (id === 'snapshot') void saveSnapshot(opts.legend ?? true);
  else void exportIssues(id);
}
