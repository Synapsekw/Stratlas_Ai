/**
 * The report template of a project (volumetric parity W8): `<root>/report/template.json`
 * (`aio.report-template/1`), which measurement figures go into the report and in what order. One
 * per project, kept in the project folder so it travels in `.aio` exports. Written atomically with
 * a `.bak` of the previous file; a package's template is read in place and never written.
 *
 * A file this build cannot read (bad JSON, invalid, saved by a newer build) is refused, and never
 * written over: the person's template is never lost to a save made without it.
 */
import {
  REPORT_TEMPLATE_FILE,
  ReportTemplateFile,
  type ReportTemplateFile as Template,
} from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isChangedOnDisk, readJson, readJsonSeen, seenFiles, writeJsonSeen } from './fsutil';
import { newerThanThisBuild } from './newer';

const FAMILY = 'aio.report-template';

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

/** The template from raw JSON (undefined: no file); throws the sentence when it is unusable. */
function fromRaw(raw: unknown): Template | null {
  if (raw === undefined) return null;
  const newer = newerThanThisBuild(raw, FAMILY, REPORT_TEMPLATE_FILE);
  if (newer) throw new Error(newer);
  const parsed = ReportTemplateFile.safeParse(raw);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  throw new Error(
    `${REPORT_TEMPLATE_FILE} is invalid${where}: ${first?.message ?? 'unknown error'}. The file was not changed.`,
  );
}

/**
 * `<root>/report/template.json`, or null when the project has none. Throws a sentence when the
 * file cannot be read, is invalid or was saved by a newer build. The version read is remembered,
 * so a save compares with it first (shared folders).
 */
export async function readTemplate(root: string): Promise<Template | null> {
  let raw: unknown;
  try {
    raw = await readJsonSeen(join(root, REPORT_TEMPLATE_FILE));
  } catch (e) {
    throw new Error(`Could not read the report template: ${why(e)}`, { cause: e });
  }
  return fromRaw(raw);
}

/** A package's template, read from the archive in place (never written). */
export async function readPackageTemplate(archive: {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}): Promise<Template | null> {
  if (!archive.entries.has(REPORT_TEMPLATE_FILE)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse((await archive.read(REPORT_TEMPLATE_FILE)).toString('utf8'));
  } catch (e) {
    throw new Error(`Could not read the report template from the package: ${why(e)}`, {
      cause: e,
    });
  }
  return fromRaw(raw);
}

/**
 * Replace `<root>/report/template.json` atomically, keeping a `.bak`. Refused (throws, nothing
 * touched) when the file there cannot be read, is invalid, was saved by a newer build, or was
 * changed by someone else since it was read here.
 */
export async function writeTemplate(root: string, file: Template): Promise<void> {
  const path = join(root, REPORT_TEMPLATE_FILE);
  // what is there now must be ours to replace. A file read here before is checked without
  // remembering it again: the write below then refuses any change since that read. A file never
  // read here is remembered as it is checked, so a change between this check and the write (a
  // newer build saving it, say) is refused the same way: the check and the write see one version.
  let raw: unknown;
  try {
    raw = await (seenFiles.has(path) ? readJson(path) : readJsonSeen(path));
  } catch (e) {
    throw new Error(
      `The report template there could not be read (${why(e)}), so it was not replaced.`,
      { cause: e },
    );
  }
  fromRaw(raw);
  try {
    await mkdir(join(root, 'report'), { recursive: true });
    await writeJsonSeen(path, file, { backup: true, name: REPORT_TEMPLATE_FILE });
  } catch (e) {
    if (isChangedOnDisk(e)) throw new Error(e.message, { cause: e });
    throw new Error(`The report template was not saved: ${why(e)}`, { cause: e });
  }
}

/** An error as the IPC answer's sentence. */
export const templateError = (e: unknown): string => (e instanceof Error ? e.message : String(e));
