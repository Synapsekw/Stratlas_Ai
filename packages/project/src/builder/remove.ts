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
import { freeTrashEntry, HELD_NOTE, HELD_PREFIX, TRASH_DIR } from './trash';

/*
 * Removing (delete and start over, spec "Removing"): plan again from disk, write `removed.json` and
 * the in-progress note into a `held-` trash entry, move every file into it, rewrite `tilesets.json`
 * (a copy goes first), save the manifest once, drop the note and give the entry its stamped name.
 * When a move is refused, the moves made come back and nothing changed; when the save fails, the
 * side file and the files come back; when the way back is refused too, the files stay in the held
 * entry with `removed.json` and the error says where.
 */

export const MANIFEST_BEFORE = 'manifest.before.json';
const NOTE_TEXT =
  'A removal is under way here, or it failed. If it failed, move these files back into the ' +
  'project by hand; removed.json lists them.\n';

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

const present = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );
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

/** `held-<final name>`, or with `-2`, `-3`... when taken. */
async function freeHeldName(final: string): Promise<string> {
  const base = join(dirname(final), `${HELD_PREFIX}${basename(final)}`);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${String(n)}`;
    if (!(await present(name))) return name;
  }
}

/** The error after a failed removal whose way back was refused for some of what it changed. */
export function stuckMessage(
  cause: string,
  files: number,
  sides: readonly string[],
  held: string,
): string {
  const parts = [cause];
  if (files > 0)
    parts.push(
      `${String(files)} file(s) could not be moved back. They are in ${held}, listed in removed.json.`,
    );
  for (const side of sides)
    parts.push(`${side} could not be restored; its earlier copy is in ${held}.`);
  return parts.join(' ');
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
  const final = needsEntry
    ? await freeTrashEntry(root, at, flat ? only.slice(WALKS_DIR.length + 1) : slugOf(first))
    : null;
  // the entry is `held-...` until the manifest is saved: files that could not come back after a
  // failure stay under that name, which the sweep and Empty project trash never touch
  const entry = final === null ? null : await freeHeldName(final);
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
    // until the manifest is saved the removal has not taken effect: the trash leaves this entry be
    await writeFile(join(dir, HELD_NOTE), NOTE_TEXT);
  };
  /** Put back what was changed; answers the moved files and the side files that could not. */
  const undo = async (): Promise<{ files: number; sides: string[] }> => {
    const stuckSides: string[] = [];
    let files = 0;
    for (const s of [...sides].reverse())
      await writeFile(s.file, s.text).catch(() => {
        stuckSides.push(basename(s.file));
      });
    for (const mv of [...moved].reverse())
      await renameWhenFree(mv.to, mv.from, ro).catch(() => {
        files += 1;
      });
    return { files, sides: stuckSides };
  };
  /** After a failure: the entry goes when everything came back, else it stays held with a record. */
  const fail = async (e: unknown): Promise<never> => {
    const stuck = await undo();
    if ((stuck.files > 0 || stuck.sides.length > 0) && entry !== null) {
      // the record and the note again, in case the first write was lost with the entry's files
      await writeRecord(entry).catch(() => undefined);
      throw new Error(
        stuckMessage(message(e), stuck.files, stuck.sides, `${TRASH_DIR}/${basename(entry)}`),
        { cause: e },
      );
    }
    if (entry !== null && !flat)
      await rm(entry, { recursive: true, force: true }).catch(() => undefined);
    // a walk's folder came back carrying the entry's own files
    if (flat)
      for (const mv of moved)
        for (const f of [MANIFEST_BEFORE, 'removed.json', HELD_NOTE])
          await rm(join(mv.from, f), { force: true }).catch(() => undefined);
    throw new Error(`${message(e)} Nothing was removed.`, { cause: e });
  };

  try {
    // the record goes in first: an entry that outlives this call (a crash, a refused rename) can
    // always be told apart, taken effect or not (`trash.ts`, held entries)
    if (entry !== null && !flat) {
      await mkdir(entry, { recursive: true });
      await writeRecord(entry);
    }
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
    // a walk's entry is its folder, moved as one: the record follows it at once
    if (flat && entry !== null && moved.length > 0) await writeRecord(entry);
    if (rewrite && entry !== null) {
      const file = join(root, TILESETS_FILE);
      const text = await readFile(file, 'utf8');
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
    return fail(e);
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
    return fail(e);
  }
  if (entry === null || final === null) return { manifest, plan, trash: null };
  // the removal stands once the manifest is saved: the entry becomes ordinary trash; when the rename
  // is refused, the trash renames it later (its record shows the removal took effect)
  try {
    await rm(join(entry, HELD_NOTE), { force: true });
    await renameWhenFree(entry, final, ro);
    return { manifest, plan, trash: basename(final) };
  } catch (e) {
    console.warn(`${basename(entry)} could not be renamed to ${basename(final)}: ${message(e)}`);
    return { manifest, plan, trash: basename(entry) };
  }
}
