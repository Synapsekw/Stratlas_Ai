import type { IpcRequest, IpcResponse } from '@aio/schema';
import { join } from 'node:path';
import { safeFileName } from '../saveFile';

/** What the save dialog is shown with (only the keys that are set). */
export interface SaveDialogChoice {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface SavePathDeps {
  /** Folder offered first, normally the OS Downloads folder. */
  downloadsDir: string;
  /** An open package's export limits: the reason a file of this name is refused, or null. */
  refuse: (name: string) => string | null;
  /** Show the save dialog at `defaultPath`; resolves to the chosen path or null on cancel. */
  choose: (defaultPath: string, options: SaveDialogChoice) => Promise<string | null>;
}

/**
 * `dialog:savePath`: ask where to save and answer the path; nothing is written. A pipeline job
 * (`survey.export`, `survey.section`) then writes its file there itself.
 */
export async function savePath(
  req: IpcRequest<'dialog:savePath'>,
  deps: SavePathDeps,
): Promise<IpcResponse<'dialog:savePath'>> {
  const name = safeFileName(req.defaultName);
  const refused = deps.refuse(name);
  if (refused) return { path: null, error: refused };
  const path = await deps.choose(join(deps.downloadsDir, name), {
    ...(req.title ? { title: req.title } : {}),
    ...(req.filters ? { filters: req.filters } : {}),
  });
  return { path };
}
