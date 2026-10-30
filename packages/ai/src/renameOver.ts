/**
 * Replacing a file atomically through a temporary file, on Windows too.
 *
 * Windows refuses to rename over a file while anything holds it open, even only to read it: an
 * antivirus or search indexer scanning the file just written, or another reader of the run. Such a
 * reader is gone within milliseconds (longer on a busy computer), so there a refused rename is
 * tried again for about 2.5 s before it fails, as the project's `manifestFile` and the desktop
 * app's `writeJsonAtomic` do.
 */
import { rename } from 'node:fs/promises';

/** Codes Windows gives a rename onto a file that something has open at that moment. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Rename `from` over `to`, trying again while Windows reports the target as held open. */
export async function renameOver(from: string, to: string): Promise<void> {
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
