import {
  TILESETS_FILE,
  TRASH_SCHEMA,
  WALKS_DIR,
  type ProjectManifest,
  type RemovalPlan,
  type RemoveTarget,
  type TrashRecord,
} from '@aio/schema';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { renameWhenFree, type RenameOptions } from '../import/rename';
import { updateManifestFile } from './manifestFile';
import { planRemoval, type PlanOptions } from './removePlan';
import { freeTrashEntry, TRASH_DIR } from './trash';

/*
 * Removing (delete and start over, spec "Removing"): plan again from disk, move every file into one
 * trash entry, rewrite `tilesets.json` (a copy goes first), save the manifest once, write
 * `removed.json`. When a move is refused, the moves made come back and nothing changed; when the
 * save fails, the side file and the files come back; when the way back is refused too, the files
 * stay in the entry with `removed.json` and the error says where.
 */

export const MANIFEST_BEFORE = 'manifest.before.json';

export interface RemoveOptions extends PlanOptions {
  rename?: RenameOptions['rename'];
  sleep?: RenameOptions['sleep'];
  platform?: NodeJS.Platform;
  /** `removeWalk`: the entry is the walk folder itself, `<stamp>-<walk id>/`, as before. */
  walkLayout?: boolean;
}

export interface RemoveResult {
  manifest: ProjectManifest;
  plan: RemovalPlan;
  /** The trash entry's name, or null when nothing moved. */
  trash: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const slugOf = (t: RemoveTarget) =>
  'layer' in t ? t.layer : 'run' in t ? `run-${t.run}` : `date-${t.capture}`;

/** Refuses when `.trash` exists and is a link, a junction or a file: nothing is moved through it. */
async function checkTrashFolder(root: string): Promise<void> {
  let info;
  try {
    info = await lstat(join(root, TRASH_DIR));
  } catch {
    return; // not there yet: made as a plain folder
  }
  if (!info.isDirectory())
    throw new Error(
      `The project trash folder ${TRASH_DIR} is a link or a file, not a folder. Nothing was removed.`,
    );
}

export async function removeItems(
  root: string,
  targets: readonly RemoveTarget[],
  now: () => Date = () => new Date(),
  o: RemoveOptions = {},
): Promise<RemoveResult> {
  const plan = await planRemoval(root, targets, o);
  if (plan.refused !== undefined) throw new Error(plan.refused);
  const first = targets[0];
  if (first === undefined) throw new Error('Nothing to remove.');
  const ro: RenameOptions = {
    ...(o.rename ? { rename: o.rename } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.platform ? { platform: o.platform } : {}),
  };
  const rewrite = plan.tilesets.length > 0;
  const only = plan.files.length === 1 ? (plan.files[0] ?? '') : '';
  // a walk alone keeps the walk entry layout (`<stamp>-<walk id>/`), whichever channel removes it
  const onlyWalk =
    plan.layers.length === 1 && plan.layers[0]?.kind === 'walk' && plan.runs.length === 0;
  const flat = (o.walkLayout === true || onlyWalk) && !rewrite && only.startsWith(`${WALKS_DIR}/`);
  const at = now();
  const needsEntry = plan.files.length > 0 || rewrite;
  if (needsEntry) await checkTrashFolder(root);
  const entry = needsEntry
    ? await freeTrashEntry(root, at, flat ? only.slice(WALKS_DIR.length + 1) : slugOf(first))
    : null;
  const before = await readFile(join(root, 'manifest.json'), 'utf8');
  const moved: { from: string; to: string }[] = [];
  const sides: { file: string; text: string }[] = [];

  const record = (): TrashRecord => ({
    schema: TRASH_SCHEMA,
    at: at.toISOString(),
    targets: [...targets],
    plan,
    manifestBefore: MANIFEST_BEFORE,
  });
  const writeRecord = async (dir: string) => {
    await writeFile(join(dir, MANIFEST_BEFORE), before);
    await writeFile(join(dir, 'removed.json'), `${JSON.stringify(record(), null, 2)}\n`);
  };
  /** Put back what was changed; answers what could not come back. */
  const undo = async (): Promise<string[]> => {
    const stuck: string[] = [];
    for (const s of [...sides].reverse())
      await writeFile(s.file, s.text).catch(() => {
        stuck.push(s.file);
      });
    for (const mv of [...moved].reverse())
      await renameWhenFree(mv.to, mv.from, ro).catch(() => {
        stuck.push(mv.from);
      });
    return stuck;
  };
  /** After a failure: the entry goes when everything came back, else it keeps a record. */
  const fail = async (e: unknown, nothing: string): Promise<never> => {
    const stuck = await undo();
    if (stuck.length > 0 && entry !== null) {
      await writeRecord(entry).catch(() => undefined);
      throw new Error(
        `${message(e)} ${String(stuck.length)} file(s) could not be moved back. They are in ${TRASH_DIR}/${basename(entry)}, listed in removed.json.`,
      );
    }
    if (entry !== null && !flat)
      await rm(entry, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`${message(e)}${nothing}`);
  };

  try {
    for (const rel of plan.files) {
      const from = join(root, ...rel.split('/'));
      const to = flat && entry !== null ? entry : join(entry ?? root, ...rel.split('/'));
      await mkdir(dirname(to), { recursive: true });
      try {
        await renameWhenFree(from, to, ro);
      } catch (e) {
        throw new Error(`${rel} could not be moved to the project trash (${message(e)}).`, {
          cause: e,
        });
      }
      moved.push({ from, to });
    }
    if (rewrite && entry !== null) {
      const file = join(root, TILESETS_FILE);
      const text = await readFile(file, 'utf8');
      // a removal may move no file at all and only rewrite tilesets.json: the entry is made here
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, TILESETS_FILE), text);
      sides.push({ file, text });
      const doc = JSON.parse(text) as { entries?: { id?: unknown }[] };
      const gone = new Set(plan.tilesets);
      const entries = (doc.entries ?? []).filter(
        (e) => typeof e.id !== 'string' || !gone.has(e.id),
      );
      await writeFile(file, `${JSON.stringify({ ...doc, entries }, null, 2)}\n`);
    }
  } catch (e) {
    return fail(e, ' Nothing was removed.');
  }

  const layerIds = new Set(plan.layers.map((l) => l.id));
  const captureIds = new Set(plan.captures);
  let manifest: ProjectManifest;
  try {
    const r = await updateManifestFile(root, (m) => ({
      manifest: {
        ...m,
        layers: m.layers.filter((l) => !layerIds.has(l.id)),
        captures: m.captures.filter((c) => !captureIds.has(c.id)),
      },
    }));
    manifest = r.manifest;
  } catch (e) {
    return fail(e, '');
  }
  if (entry !== null)
    // the removal stands once the manifest is saved: a record that cannot be written is only noted
    await writeRecord(entry).catch((e: unknown) => {
      console.warn(`removed.json could not be written in ${entry}: ${message(e)}`);
    });
  return { manifest, plan, trash: entry === null ? null : basename(entry) };
}
