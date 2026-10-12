/**
 * A project's `manifest.json`: reading it, and saving it one save at a time.
 *
 * The builder's saves of a manifest come through here, so two saves of one project never overlap:
 * `writeManifestFile` for a writer that has the whole manifest (a new project),
 * `updateManifestFile` for every writer that reads, changes and writes back.
 */
import { keepUnknownLayers, parseManifest, type ProjectManifest } from '@aio/schema';
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Codes Windows gives a rename onto a file that something has open at that moment. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Rename `from` over `to`. Windows refuses to replace a file while anything holds it open, even
 * only to read it: the app's own journal reading the manifest when a job ends, a pipeline, a
 * search indexer, antivirus. Such a reader is gone within milliseconds, so there a refused rename
 * is tried again for about 2.5 s before it fails (as the desktop app's `writeJsonAtomic` does).
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let wait = 10; ; wait *= 2) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !LOCKED.has(code) || wait > 1280) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export async function readManifestFile(root: string): Promise<ProjectManifest> {
  const file = join(root, 'manifest.json');
  const r = parseManifest(JSON.parse(await readFile(file, 'utf8')) as unknown);
  if (!r.ok) throw new Error(`${file}: ${r.error}`);
  return r.value;
}

/** One name for a project's manifest however its folder is spelled (case ignored on Windows). */
const keyOf = (root: string) => {
  const r = resolve(root, 'manifest.json');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/**
 * The saves of each manifest on their way, by `keyOf`: the promise that settles when the last one
 * called is done. An entry is removed when its queue has drained.
 */
const turns = new Map<string, Promise<void>>();

/**
 * Run `task` when every task for this project's `manifest.json` called before it has finished (or
 * failed), in the order of the calls. Two saves of one manifest that overlapped each read the same
 * old file, and the later write replaced the earlier one's change (a survey date added while a
 * layer was placed); a save that reads inside its turn sees what the one before it wrote.
 *
 * A task must not save the same project through `writeManifestFile` or `updateManifestFile`: it
 * would wait for itself. Keep a task short, since every other save of the project waits for it.
 *
 * The queue is this process's own. The processing tools write `manifest.json` from another
 * process (the Python pipelines) and take no turn here.
 */
export function withManifest<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = keyOf(root);
  const run = (turns.get(key) ?? Promise.resolve()).then(task);
  const done = run.then(
    () => undefined,
    () => undefined,
  );
  turns.set(key, done);
  void done.then(() => {
    if (turns.get(key) === done) turns.delete(key);
  });
  return run;
}

let saves = 0;
/**
 * A temporary name next to `file`, unique per save. It keeps the `.partial` ending that packages,
 * import reports and shared folders skip.
 */
const tempName = (file: string) => {
  saves += 1;
  return `${file}.${String(process.pid)}.${String(Date.now())}.${String(saves)}.partial`;
};

/**
 * The save itself, outside any queue (callers hold the turn): validate with `parseManifest`, keep
 * the previous file as `manifest.json.bak`, then replace `manifest.json` atomically through a
 * temporary file of this save's own, removed again when the save fails. Layers of kinds this build
 * does not know (written by a newer Stratlas) are carried over from the previous file unchanged
 * (`keepUnknownLayers`, M10). Returns the backup path ('' for a new project).
 */
async function saveManifest(root: string, manifest: ProjectManifest): Promise<string> {
  const parsed = parseManifest(manifest);
  if (!parsed.ok) throw new Error(parsed.error);
  const file = join(root, 'manifest.json');
  let backup = '';
  let previous: unknown;
  if (await exists(file)) {
    try {
      previous = JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch {
      previous = undefined;
    }
    backup = `${file}.bak`;
    await copyFile(file, backup);
  }
  const kept = keepUnknownLayers(previous, parsed.value);
  if (!kept.ok) throw new Error(kept.error);
  const tmp = tempName(file);
  try {
    await writeFile(tmp, `${JSON.stringify(kept.value, null, 2)}\n`);
    await renameOver(tmp, file);
  } catch (e) {
    // best effort: when the removal is refused too (a scanner holding the file on Windows), the
    // caller still gets the error of the save, not of the cleanup
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return backup;
}

/**
 * Save a whole manifest, in its turn among the saves of the project (`withManifest`): validated,
 * the previous file kept as `manifest.json.bak`, `manifest.json` replaced atomically. Returns the
 * backup path ('' for a new project).
 *
 * For a writer that has nothing to read first (a new project). A writer that changes the manifest
 * it read uses `updateManifestFile`, so its read is in the turn too.
 */
export function writeManifestFile(root: string, manifest: ProjectManifest): Promise<string> {
  return withManifest(root, () => saveManifest(root, manifest));
}

/**
 * What a change answers: the manifest to save, or `null` when there is nothing to save, and any
 * other keys it wants handed back to the caller (not named `backup` or `saved`).
 */
export interface ManifestChange {
  manifest: ProjectManifest | null;
  /**
   * Run in the turn once the manifest is saved (or when there was nothing to save): files that
   * must follow the manifest, never lead it (a walk's `pose.json`). Its error reaches the caller;
   * the manifest stays saved.
   */
  afterSave?: () => Promise<void>;
  /** Run in the turn when the save failed, before its error reaches the caller. */
  afterFail?: () => Promise<void>;
}

/** What an update did, next to the keys the change added. */
export interface ManifestUpdate {
  /** The manifest the change answered, or the one read when nothing was saved. */
  manifest: ProjectManifest;
  /** The backup path; '' when nothing was saved. */
  backup: string;
  saved: boolean;
}

/**
 * Read, change and save a project's manifest as one step, in its turn (`withManifest`): the
 * manifest is read when the turn comes, `change` gets that fresh copy, and what it answers is
 * saved as `writeManifestFile` saves. So a change is always made on what the save before it wrote.
 *
 * `change` may be async and may refuse: when it throws, nothing is written, the error reaches the
 * caller and the next save goes on; `manifest: null` saves nothing (no backup either). Every other
 * key it answers comes back with the result, except `afterSave` and `afterFail`, which run in the
 * turn after the save succeeded or failed.
 */
export function updateManifestFile<C extends ManifestChange>(
  root: string,
  change: (manifest: ProjectManifest) => C | Promise<C>,
): Promise<Omit<C, 'manifest' | 'afterSave' | 'afterFail'> & ManifestUpdate> {
  return withManifest(root, async () => {
    const read = await readManifestFile(root);
    const { manifest, afterSave, afterFail, ...rest } = await change(read);
    if (manifest === null) {
      await afterSave?.();
      return { ...rest, manifest: read, backup: '', saved: false };
    }
    let backup: string;
    try {
      backup = await saveManifest(root, manifest);
    } catch (e) {
      await afterFail?.().catch(() => undefined);
      throw e;
    }
    await afterSave?.();
    return { ...rest, manifest, backup, saved: true };
  });
}
