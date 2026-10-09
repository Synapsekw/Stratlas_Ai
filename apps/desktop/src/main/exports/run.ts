// Writes issue exports to disk. Runs in the export utility process (worker.ts), never on the
// UI thread; also called directly by unit tests.
import { imageSize } from '@aio/project/image';
import {
  issuesCoco,
  issuesCsv,
  issuesGeoJson,
  issuesKitAssessment,
  photoSrc,
  type ExportContext,
} from '@aio/project/export';
import {
  encodeGrayPng,
  kitMaskSiblings,
  maskPlan,
  overlayPng,
  rasterizeMask,
  ZipWriter,
} from '@aio/project/export/node';
import type { ExportFormat } from '@aio/schema';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readIssues, readManifest } from '../project';

export interface ExportJob {
  root: string;
  format: ExportFormat;
  outPath: string;
  issueIds?: string[] | undefined;
}

export interface ExportProgress {
  phase: string;
  done: number;
  total: number;
}

export interface ExportResult {
  count: number;
  bytes: number;
}

const SUFFIX: Record<ExportFormat, string> = {
  csv: '-issues.csv',
  geojson: '-issues.geojson',
  coco: '-issues-coco.json',
  'kit-json': '-assessment.json',
  'masks-zip': '-masks.zip',
  'report-pdf': '-issue-register.pdf',
  'house-pdf': '-report.pdf',
  'audit-csv': '-audit.csv',
  'audit-json': '-audit.json',
  'photo-report-pdf': '-accuracy-report.pdf',
  'measurements-csv': '-measurements.csv',
  'stockpile-csv': '-stockpile-inventory.csv',
  'survey-report-pdf': '-survey-report.pdf',
};

/** Save dialog filter per format. */
export const EXPORT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV', extensions: ['csv'] },
  geojson: { name: 'GeoJSON', extensions: ['geojson', 'json'] },
  coco: { name: 'COCO JSON', extensions: ['json'] },
  'kit-json': { name: 'Kit assessment JSON', extensions: ['json'] },
  'masks-zip': { name: 'ZIP', extensions: ['zip'] },
  'report-pdf': { name: 'PDF', extensions: ['pdf'] },
  'house-pdf': { name: 'PDF', extensions: ['pdf'] },
  'audit-csv': { name: 'CSV', extensions: ['csv'] },
  'audit-json': { name: 'Signed audit JSON', extensions: ['json'] },
  'photo-report-pdf': { name: 'PDF', extensions: ['pdf'] },
  'measurements-csv': { name: 'CSV', extensions: ['csv'] },
  'stockpile-csv': { name: 'CSV', extensions: ['csv'] },
  'survey-report-pdf': { name: 'PDF', extensions: ['pdf'] },
};

/** File name offered in the save dialog: the project name made file safe, plus the format. */
export function defaultExportName(projectName: string, format: ExportFormat): string {
  const base =
    projectName
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  return `${base}${SUFFIX[format]}`;
}

class Cancelled extends Error {
  constructor() {
    super('Export cancelled.');
  }
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Cancelled();
}

/** Read up to 1 MB of a file's head, enough for any JPEG SOF after EXIF. */
async function headerSize(path: string): Promise<{ width: number; height: number } | null> {
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return null;
  try {
    for (const n of [65536, 1 << 20]) {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      const size = imageSize(buf.subarray(0, bytesRead));
      if (size || bytesRead < n) return size;
    }
    return null;
  } finally {
    await fh.close();
  }
}

async function load(job: ExportJob): Promise<ExportContext> {
  const manifest = await readManifest(job.root);
  if (!manifest.ok) throw new Error(manifest.error);
  const issues = await readIssues(job.root);
  if (!issues.ok) throw new Error(issues.error);
  const wanted = job.issueIds ? new Set(job.issueIds) : null;
  return {
    manifest: manifest.value,
    issues: wanted ? issues.value.filter((i) => wanted.has(i.id)) : issues.value,
  };
}

type Progress = (p: ExportProgress) => void;

async function photoSizes(
  ctx: ExportContext,
  root: string,
  progress: Progress,
  signal?: AbortSignal,
): Promise<Map<string, { width: number; height: number } | null>> {
  const wanted = new Map<string, string | null>();
  for (const i of ctx.issues)
    for (const s of i.sightings)
      if (s.on === 'image')
        wanted.set(`${s.layer}\u0000${s.photo}`, photoSrc(ctx.manifest, s.layer, s.photo));
  const sizes = new Map<string, { width: number; height: number } | null>();
  let done = 0;
  for (const [key, src] of wanted) {
    check(signal);
    sizes.set(key, src ? await headerSize(join(root, src)) : null);
    done++;
    if (done % 25 === 0 || done === wanted.size)
      progress({ phase: 'Reading photo sizes', done, total: wanted.size });
  }
  return sizes;
}

async function writeMasks(
  ctx: ExportContext,
  root: string,
  out: string,
  progress: Progress,
  signal?: AbortSignal,
): Promise<number> {
  const plan = maskPlan(ctx);
  const zip = await ZipWriter.create(out);
  let files = 0;
  try {
    const index: unknown[] = [];
    let done = 0;
    for (const p of plan.photos) {
      check(signal);
      const folder = `masks/${p.layer}`;
      const written: string[] = [];
      if (p.kind === 'kit') {
        for (const rel of kitMaskSiblings(p.mask)) {
          const data = await readFile(join(root, rel)).catch(() => null);
          if (!data) continue;
          const name = `${folder}/${basename(rel)}`;
          await zip.add(name, data);
          written.push(name);
        }
      } else {
        const size = p.src ? await headerSize(join(root, p.src)) : null;
        if (size) {
          const mask = rasterizeMask(p.shapes, size.width, size.height);
          const maskName = `${folder}/${p.photo}_mask.png`;
          const overlayName = `${folder}/${p.photo}_overlay.png`;
          await zip.add(maskName, encodeGrayPng(mask, size.width, size.height));
          await zip.add(
            overlayName,
            overlayPng(
              mask,
              size.width,
              size.height,
              plan.classes.map((c) => c.color),
            ),
          );
          written.push(maskName, overlayName);
        }
      }
      files += written.length;
      if (written.length > 0)
        index.push({
          layer: p.layer,
          photo: p.photo,
          image: p.src,
          source: p.kind,
          files: written,
          issues: p.issues,
        });
      done++;
      progress({ phase: 'Adding masks', done, total: plan.photos.length });
    }
    await zip.add(
      'masks.json',
      Buffer.from(
        JSON.stringify(
          {
            project: ctx.manifest.id,
            note: 'Class-index masks (0 background, values below) and RGBA overlays. "kit" masks come from the inspection kit, "drawn" masks from the issue geometry.',
            classes: plan.classes,
            photos: index,
          },
          null,
          2,
        ),
      ),
    );
    await zip.finish();
  } catch (e) {
    await zip.abort();
    throw e;
  }
  return files;
}

/**
 * Write one export. The file is written next to the target as `<name>.part` and renamed when
 * complete, so a cancelled or failed export never leaves a half file under the chosen name.
 */
export async function runExport(
  job: ExportJob,
  onProgress: Progress = () => undefined,
  signal?: AbortSignal,
): Promise<ExportResult> {
  if (
    job.format === 'report-pdf' ||
    job.format === 'house-pdf' ||
    job.format === 'photo-report-pdf'
  ) {
    throw new Error('The PDF report is printed from a report window, not the export process.');
  }
  if (job.format === 'audit-csv' || job.format === 'audit-json') {
    throw new Error('The audit trail is exported by the journal service (M9 T1), not here.');
  }
  if (
    job.format === 'measurements-csv' ||
    job.format === 'stockpile-csv' ||
    job.format === 'survey-report-pdf'
  ) {
    throw new Error('Survey reports are not available yet (M11 G9).');
  }
  const part = `${job.outPath}.part`;
  try {
    check(signal);
    onProgress({ phase: 'Reading issues', done: 0, total: 1 });
    const ctx = await load(job);
    let count = ctx.issues.length;
    switch (job.format) {
      case 'csv':
        await writeFile(part, issuesCsv(ctx), 'utf8');
        break;
      case 'geojson':
        await writeFile(part, JSON.stringify(issuesGeoJson(ctx), null, 1), 'utf8');
        break;
      case 'kit-json':
        await writeFile(part, JSON.stringify(issuesKitAssessment(ctx), null, 2), 'utf8');
        break;
      case 'coco': {
        const sizes = await photoSizes(ctx, job.root, onProgress, signal);
        const coco = issuesCoco(ctx, (l, p) => sizes.get(`${l}\u0000${p}`) ?? null);
        await writeFile(part, JSON.stringify(coco), 'utf8');
        break;
      }
      case 'masks-zip':
        count = await writeMasks(ctx, job.root, part, onProgress, signal);
        break;
    }
    check(signal);
    await rename(part, job.outPath);
    onProgress({ phase: 'Done', done: 1, total: 1 });
    return { count, bytes: (await stat(job.outPath)).size };
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}
