/**
 * What a date move changed, so it can be put back: the `capture` each layer had of its own before
 * the move. Pure, so the Datasets list can offer Undo without a second source of truth.
 */

/** A layer a date move wrote, with the `capture` it had of its own before (null: none). */
export interface MovedLayer {
  id: string;
  capture: string | null;
}

/** The own `capture` of each of these layers as the manifest has it now; unknown ids are skipped. */
export function priorCaptures(
  manifest: { layers: readonly { id: string; capture?: string | undefined }[] },
  layerIds: readonly string[],
): MovedLayer[] {
  const own = new Map(manifest.layers.map((l) => [l.id, l.capture ?? null]));
  return layerIds.flatMap((id) => {
    const capture = own.get(id);
    return capture === undefined ? [] : [{ id, capture }];
  });
}

/**
 * The writes that put moved layers back: one per earlier value, in the order first met. A layer
 * is put back only while it is still where the move put it: `now` is the own `capture` (null for
 * none) of every layer the project holds, `target` is what the move filed the layers under (null:
 * no date). A layer the project no longer holds, or one that has been filed elsewhere since (by
 * another move, or the Selection panel), is left out, so Undo never reverts a later change and one
 * removed dataset does not block the rest.
 */
export function undoBatches(
  moved: readonly MovedLayer[],
  now: ReadonlyMap<string, string | null>,
  target: string | null,
): { capture: string | null; layerIds: string[] }[] {
  const by = new Map<string | null, string[]>();
  for (const m of moved) {
    if (!now.has(m.id) || now.get(m.id) !== target) continue;
    const ids = by.get(m.capture);
    if (ids) ids.push(m.id);
    else by.set(m.capture, [m.id]);
  }
  return [...by].map(([capture, layerIds]) => ({ capture, layerIds }));
}
