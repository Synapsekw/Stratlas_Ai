import type { ProcModel, ProcPart } from '@aio/schema';

/** A built model: the GLB bytes and the node name of each meshed part, in order. */
export interface MeshedModel {
  glb: Uint8Array;
  nodes: string[];
}

/**
 * The GLB node name of a part: its plant tag, else its name, else its id. Issues, tags and part
 * matching across dates (`@aio/workspace` captures) use this name.
 */
export function partNodeName(part: ProcPart): string {
  const named = [part.tag, part.name].map((v) => v?.trim() ?? '').find((v) => v !== '');
  return named ?? part.id;
}

/**
 * Mesh the parts of a model into a GLB, one node per part (`accepted` only, or `all` for the
 * draft preview). C0 stub: stream C5 builds the mesher.
 */
export function meshProcModel(
  model: ProcModel,
  opts: { parts?: 'accepted' | 'all' } = {},
): MeshedModel {
  throw new Error(
    `The model mesher is not implemented yet (${model.id}, ${opts.parts ?? 'accepted'} parts).`,
  );
}
