/**
 * A customer report's pictures taken from the stage (volumetric report, spec 2026-10-25 section 7):
 * JPEGs and their `frame.json` (`aio.report-views/1`) in `<root>/report/views/<report>/`.
 *
 * A save replaces the whole set: every picture is written to a part file first, the pictures of
 * the same names are set aside, the part files are renamed into place, then `frame.json` is
 * written atomically. A failure before that puts the set aside back, so the old frame still
 * matches its pictures. Last the set-aside pictures, the ones the new frame does not name and
 * part files a crash left are removed. `frame.json`
 * also lists each picture's name and size (`files`, a loose extra key): the journal records that
 * one file, never the bytes.
 */
import {
  REPORT_VIEWS_MAX,
  ReportViewFileName,
  reportViewsDir,
  type IpcResponse,
  type ReportTypeId,
  type ReportViewsFrame,
} from '@aio/schema';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { renameRetrying, writeJsonAtomic } from './fsutil';
import { newerOnDisk } from './newer';

const FAMILY = 'aio.report-views';

export interface ViewFile {
  name: string;
  data: Uint8Array;
}

/** `frame.json` as written: the frame and each picture's name and size. */
export function viewsRecord(
  frame: ReportViewsFrame,
  files: readonly ViewFile[],
): ReportViewsFrame & { files: { name: string; bytes: number }[] } {
  return { ...frame, files: files.map((f) => ({ name: f.name, bytes: f.data.byteLength })) };
}

/** `report/views/<report>/frame.json`, relative to the project folder. */
export function viewsFramePath(report: ReportTypeId): string {
  return `${reportViewsDir(report)}/frame.json`;
}

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

/** Why the set cannot be saved, or null. Checked before anything on disk is touched. */
function refusal(dir: string, frame: ReportViewsFrame, files: readonly ViewFile[]): string | null {
  if (files.length > REPORT_VIEWS_MAX)
    return `A report keeps at most ${String(REPORT_VIEWS_MAX)} pictures.`;
  const names = new Set<string>();
  for (const f of files) {
    if (!ReportViewFileName.safeParse(f.name).success)
      return `"${f.name}" is not a picture name (lower case, digits and dashes, .jpg).`;
    const rel = relative(dir, resolve(dir, f.name));
    if (rel !== f.name || rel.startsWith('..') || rel.includes(sep))
      return `"${f.name}" is outside the report's pictures folder.`;
    if (names.has(f.name)) return `"${f.name}" was sent twice.`;
    names.add(f.name);
  }
  const missing = frame.views.find((v) => !names.has(v.file));
  return missing ? `The picture "${missing.file}" was not sent.` : null;
}

let parts = 0;

export async function saveReportViews(
  root: string,
  report: ReportTypeId,
  frame: ReportViewsFrame,
  files: readonly ViewFile[],
): Promise<IpcResponse<'report:saveViews'>> {
  const dir = resolve(root, ...reportViewsDir(report).split('/'));
  const bad = refusal(dir, frame, files);
  if (bad) return { ok: false, error: `The report pictures were not saved: ${bad}` };
  const rel = viewsFramePath(report);
  const newer = await newerOnDisk(join(dir, 'frame.json'), FAMILY, rel);
  if (newer) return { ok: false, error: newer };
  const written: string[] = [];
  /** Pictures put in place, and the previous ones set aside under `.old` names. */
  const placed: string[] = [];
  const aside: { old: string; kept: string }[] = [];
  try {
    await mkdir(dir, { recursive: true });
    const staged = files.map((f) => {
      parts += 1;
      return { ...f, part: join(dir, `${f.name}.${String(process.pid)}.${String(parts)}.part`) };
    });
    for (const f of staged) {
      await writeFile(f.part, f.data);
      written.push(f.part);
    }
    // the previous pictures of the same names are kept until the new frame is written, so a
    // failure at any step puts the complete old set back
    const present = new Set(await readdir(dir));
    for (const f of staged) {
      const target = join(dir, f.name);
      if (!present.has(f.name)) continue;
      const kept = `${target}.${String(process.pid)}.${String(parts)}.old`;
      await renameRetrying(target, kept);
      aside.push({ old: target, kept });
    }
    for (const f of staged) {
      await renameRetrying(f.part, join(dir, f.name));
      placed.push(join(dir, f.name));
      written.splice(written.indexOf(f.part), 1);
    }
    await writeJsonAtomic(join(dir, 'frame.json'), viewsRecord(frame, files), { name: rel });
  } catch (e) {
    await Promise.all(written.map((p) => rm(p, { force: true })));
    await Promise.all(placed.map((p) => rm(p, { force: true })));
    for (const a of aside) {
      try {
        await renameRetrying(a.kept, a.old);
      } catch (err) {
        console.warn(`Report pictures: could not restore ${a.old} (${String(err)}).`);
      }
    }
    return { ok: false, error: `The report pictures were not saved: ${why(e)}` };
  }
  await Promise.all(aside.map((a) => rm(a.kept, { force: true })));
  // the previous set's pictures the new frame does not name, and part files a crash left
  const keep = new Set(files.map((f) => f.name));
  try {
    for (const name of await readdir(dir)) {
      if (
        (name.endsWith('.jpg') && !keep.has(name)) ||
        name.endsWith('.part') ||
        name.endsWith('.old')
      )
        await rm(join(dir, name), { force: true });
    }
  } catch (e) {
    console.warn(`Report pictures: could not clear old pictures in ${dir} (${String(e)}).`);
  }
  return { ok: true };
}
