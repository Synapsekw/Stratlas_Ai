import { TilesetsFile, emptyTilesets, type TilesetEntry } from '@aio/schema';

/**
 * Read a project's `tilesets.json` content (`aio.tilesets/1`); a project without the file has no
 * tilesets. A file that does not parse is reported, never half-read.
 */
export function readTilesets(
  raw: unknown,
): { ok: true; file: TilesetsFile } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, file: emptyTilesets() };
  const r = TilesetsFile.safeParse(raw);
  if (r.success) return { ok: true, file: r.data };
  const first = r.error.issues[0];
  const at = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return {
    ok: false,
    error: `tilesets.json is invalid${at}: ${first?.message ?? 'unknown error'}`,
  };
}

/** The tilesets the site view loads: visible ones, optionally of one survey date, in file order. */
export function tilesetsToLoad(file: TilesetsFile, capture?: string): TilesetEntry[] {
  return file.entries.filter(
    (e) => e.visible && (capture === undefined || e.capture === undefined || e.capture === capture),
  );
}
