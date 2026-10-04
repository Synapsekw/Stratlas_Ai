import type { IpcRequest, IpcResponse } from '@aio/schema';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A file name safe on every platform: no folders, no reserved characters, no leading dots. */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in names.
  const reserved = /[<>:"|?*\u0000-\u001f]/g;
  const clean = base.replace(reserved, '_').trim().replace(/^\.+/, '');
  return clean === '' ? 'download' : clean;
}

export interface SaveDeps {
  /** Folder offered first, normally the OS Downloads folder. */
  downloadsDir: string;
  /** Show the save dialog at `defaultPath`; resolves to the chosen path or null on cancel. */
  choose: (defaultPath: string) => Promise<string | null>;
}

/** `dialog:saveFile`: ask where, then write the text or bytes there. */
export async function saveFile(
  req: IpcRequest<'dialog:saveFile'>,
  deps: SaveDeps,
): Promise<IpcResponse<'dialog:saveFile'>> {
  const name = safeFileName(req.defaultName);
  const path = await deps.choose(join(deps.downloadsDir, name));
  if (path === null) return { path: null };
  try {
    await writeFile(path, req.data);
    return { path };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { path: null, error: `${name} could not be saved to ${path}: ${why}` };
  }
}
