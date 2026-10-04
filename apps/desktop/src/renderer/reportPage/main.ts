// The issue register report page. Main loads it in an offscreen window, waits for
// `window.__report.state === 'ready'`, then prints it with printToPDF.
import '@aio/ui/fonts.css';
import './report.css';
import { brand } from '@aio/brand';
import { reportModel, type ReportRow } from '@aio/project/export';
import { Issue, parseManifest, type ProjectManifest } from '@aio/schema';
import { assetUrl } from '@aio/workspace';
import { z } from 'zod';
import { cropRect, reportHtml, type IssueImages } from './layout';
import { createSnapshotter, type Snapshotter } from './snapshots';

interface PageState {
  state: 'loading' | 'ready' | 'error';
  phase: string;
  done: number;
  total: number;
  error?: string;
  count?: number;
  /** Footer line main prints under every page. */
  footer?: string;
}

const w = window as unknown as { __report: PageState };
w.__report = { state: 'loading', phase: 'Reading the project', done: 0, total: 0 };
const set = (patch: Partial<PageState>) => {
  w.__report = { ...w.__report, ...patch };
};

const PHOTO_W = 960;
const PHOTO_H = 720;

async function json(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${String(r.status)}`);
  return (await r.json()) as unknown;
}

/** Decode a project image from its bytes, so drawing it never taints the canvas. */
async function loadImage(url: string): Promise<ImageBitmap> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${String(r.status)}`);
  return createImageBitmap(await r.blob());
}

const blobUrl = (b: Blob | null) => (b ? URL.createObjectURL(b) : undefined);

/** Crop of the issue's best photo with the marked region outlined. */
async function photoCrop(projectId: string, row: ReportRow): Promise<string | undefined> {
  const pick = row.photo;
  if (!pick?.src) return undefined;
  const img = await loadImage(assetUrl(projectId, { path: pick.src }));
  const crop = cropRect(pick.box, img.width, img.height);
  const c = document.createElement('canvas');
  c.width = PHOTO_W;
  c.height = Math.round((PHOTO_W * crop.h) / crop.w);
  if (c.height > PHOTO_H * 1.5) c.height = PHOTO_H;
  const g = c.getContext('2d');
  if (!g) return undefined;
  g.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  img.close();
  if (pick.box) {
    const k = c.width / crop.w;
    const [bx, by, bw, bh] = pick.box;
    g.strokeStyle = row.severityColor;
    g.lineWidth = 3;
    if (bw > 0 && bh > 0) g.strokeRect((bx - crop.x) * k, (by - crop.y) * k, bw * k, bh * k);
    else {
      g.beginPath();
      g.arc((bx - crop.x) * k, (by - crop.y) * k, 18, 0, Math.PI * 2);
      g.stroke();
    }
  }
  return blobUrl(
    await new Promise<Blob | null>((r) => {
      c.toBlob(r, 'image/jpeg', 0.82);
    }),
  );
}

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const projectId = params.get('project');
  if (!projectId) throw new Error('No project given to the report.');
  const ids = params.get('ids');
  const parsed = parseManifest(await json(assetUrl(projectId, { path: 'manifest.json' })));
  if (!parsed.ok) throw new Error(parsed.error);
  const manifest: ProjectManifest = parsed.value;
  const file = z
    .object({ issues: z.array(Issue) })
    .parse(await json(assetUrl(projectId, { path: 'issues.json' })));
  const wanted = ids ? new Set(ids.split(',')) : null;
  const issues = wanted ? file.issues.filter((i) => wanted.has(i.id)) : file.issues;
  const brandName = manifest.brand ?? brand.productName;
  const model = reportModel({ manifest, issues }, { brandName });
  document.title = `${model.title} issue register`;

  set({ phase: 'Loading the 3D model', total: model.rows.length });
  let snap: Snapshotter | null = null;
  try {
    snap = await createSnapshotter(projectId, manifest);
  } catch (e) {
    console.warn('Report: no 3D views', e);
  }

  const images = new Map<string, IssueImages>();
  let done = 0;
  for (const row of model.rows) {
    const entry: IssueImages = {};
    try {
      const photo = await photoCrop(projectId, row);
      if (photo) entry.photo = photo;
    } catch (e) {
      console.warn(`Report: photo of ${row.code}`, e);
    }
    if (snap && row.position) {
      const view = blobUrl(await snap.shoot(row.position, row.normal, row.severityColor));
      if (view) entry.view = view;
    }
    images.set(row.id, entry);
    done++;
    if (done % 5 === 0 || done === model.rows.length)
      set({ phase: 'Drawing issue pages', done, total: model.rows.length });
  }
  snap?.dispose();

  set({ phase: 'Laying out pages' });
  const root = document.getElementById('report');
  if (!root) throw new Error('Missing #report');
  root.innerHTML = reportHtml(model, images);
  await document.fonts.ready;
  await Promise.all(
    [...root.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)),
  );
  set({
    state: 'ready',
    phase: 'Ready to print',
    count: model.rows.length,
    footer: `${model.brandName}  |  ${model.title}  |  Issue register ${model.date}`,
  });
}

run().catch((e: unknown) => {
  set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
});
