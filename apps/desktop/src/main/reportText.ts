/**
 * A customer report's saved edits (volumetric report, spec 2026-10-25 section 6):
 * `<root>/report/<report>.json` (`aio.report-text/1`). Read and written like the narrative
 * (`narrative.ts`): compare-before-write, a `.bak` of the previous file, the newer-version guard;
 * a package's file is read in place and never written.
 */
import { ReportTextFile, reportTextPath, type IpcResponse, type ReportTypeId } from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk, newerThanThisBuild } from './newer';

const FAMILY = 'aio.report-text';

function invalid(rel: string, e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const first = e.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return `${rel} is invalid${where}: ${first?.message ?? 'unknown error'}`;
}

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

function parse(raw: unknown, rel: string, readOnly: boolean): IpcResponse<'report:readText'> {
  const newer = newerThanThisBuild(raw, FAMILY, rel);
  if (newer) return { ok: false, error: newer };
  const parsed = ReportTextFile.safeParse(raw);
  return parsed.success
    ? { ok: true, file: parsed.data, readOnly }
    : { ok: false, error: invalid(rel, parsed.error) };
}

export async function readReportText(
  root: string,
  report: ReportTypeId,
): Promise<IpcResponse<'report:readText'>> {
  const rel = reportTextPath(report);
  let raw: unknown;
  try {
    // remembered, so a save compares with what the person saw first (shared folders)
    raw = await readJsonSeen(join(root, rel));
  } catch (e) {
    return { ok: false, error: `Could not read the report edits: ${why(e)}` };
  }
  if (raw === undefined) return { ok: true, file: null, readOnly: false };
  return parse(raw, rel, false);
}

/** A package's report edits, read from the archive in place. */
export async function readPackageReportText(
  archive: { entries: ReadonlyMap<string, unknown>; read(name: string): Promise<Buffer> },
  report: ReportTypeId,
): Promise<IpcResponse<'report:readText'>> {
  const rel = reportTextPath(report);
  if (!archive.entries.has(rel)) return { ok: true, file: null, readOnly: true };
  try {
    const raw: unknown = JSON.parse((await archive.read(rel)).toString('utf8'));
    return parse(raw, rel, true);
  } catch (e) {
    return { ok: false, error: `Could not read the report edits from the package: ${why(e)}` };
  }
}

export async function writeReportText(
  root: string,
  report: ReportTypeId,
  file: ReportTextFile,
): Promise<IpcResponse<'report:writeText'>> {
  const rel = reportTextPath(report);
  if (file.report !== report)
    return {
      ok: false,
      error: `The edits are for another report (${file.report}), not ${report}.`,
    };
  const newer = await newerOnDisk(join(root, rel), FAMILY, rel);
  if (newer) return { ok: false, error: newer };
  try {
    await mkdir(join(root, 'report'), { recursive: true });
    await writeJsonSeen(join(root, rel), file, { backup: true, name: rel });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The report edits were not saved: ${why(e)}` };
  }
}
