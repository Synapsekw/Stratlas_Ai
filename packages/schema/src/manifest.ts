import { z } from 'zod';
import { Id, IsoDate, Vec3, err, ok, uniqueIds, type Result } from './common';
import { Layer } from './layers';
import { ClassCatalogue, SeverityModel } from './severity';
import { ProjectType, VerticalDatum } from './builder';

export const SCHEMA_VERSION = 'aio.project/1' as const;

export const Capture = z.object({ id: Id, label: z.string().min(1), date: IsoDate });

export const Crs = z.union([
  z.object({ epsg: z.number().int() }).strict(),
  z.object({ wkt: z.string().min(1) }).strict(),
]);

export const ProjectManifest = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    id: Id,
    name: z.string().min(1),
    customer: z.string().optional(),
    site: z.string().optional(),
    crs: Crs,
    origin: Vec3,
    captures: z.array(Capture),
    layers: z.array(Layer),
    severityModels: z.array(SeverityModel),
    classCatalogues: z.array(ClassCatalogue),
    brand: z.string().optional(),
    /** What the project is for (builder wizard); absent on imported kit projects. */
    type: ProjectType.optional(),
    /**
     * How drone absolute altitudes become project heights (`H = absolute + absAltOffsetM`); raw
     * imports use absolute altitude when it is set, else relative altitude plus a take-off height.
     */
    verticalDatum: VerticalDatum.optional(),
    /**
     * Project policy (M8): may the model builder's agent (`build` route) send plan images and
     * drawings to a cloud model, after the send preview? Absent or false (default): local only.
     */
    aiCloudDrawings: z.boolean().optional(),
  })
  .superRefine(uniqueIds('layers'))
  .superRefine(uniqueIds('severityModels'))
  .superRefine(uniqueIds('captures'));

export type Capture = z.infer<typeof Capture>;
export type ProjectManifest = z.infer<typeof ProjectManifest>;
export type ProjectManifestInput = z.input<typeof ProjectManifest>;

/** The layer kinds this build reads. */
export const LAYER_KINDS: ReadonlySet<string> = new Set(
  Layer.options.map((o) => o.shape.kind.value),
);

/**
 * A layer of a kind this build does not know (M10 G0): written by a newer 1.x build that added a
 * layer kind. Read as an opaque entry: never shown as a layer, kept as it is on save
 * (`keepUnknownLayers`), shown as "needs a newer Stratlas". 0.9 and older refuse the whole
 * manifest instead, which is why M10 itself adds no layer kind.
 */
export const OpaqueLayer = z.looseObject({
  kind: z.string().min(1).max(64),
  id: Id,
  name: z.string().min(1),
});
export type OpaqueLayer = z.infer<typeof OpaqueLayer>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Raw layers of a manifest-shaped object, unknown kinds set aside (only well-formed ones). */
function splitLayers(json: Record<string, unknown>): {
  known: Record<string, unknown>;
  unknown: OpaqueLayer[];
} {
  const layers = json.layers;
  if (!Array.isArray(layers)) return { known: json, unknown: [] };
  const kept: unknown[] = [];
  const unknown: OpaqueLayer[] = [];
  for (const l of layers) {
    const kind = isRecord(l) ? l.kind : undefined;
    const opaque = typeof kind === 'string' && !LAYER_KINDS.has(kind) && OpaqueLayer.safeParse(l);
    if (opaque && opaque.success) unknown.push(opaque.data);
    else kept.push(l);
  }
  return { known: { ...json, layers: kept }, unknown };
}

/**
 * Parse untrusted JSON into a manifest and the layers of kinds this build does not know (kept
 * aside, in file order). Messages are ones a person can act on.
 */
export function parseManifestTolerant(
  json: unknown,
): Result<{ manifest: ProjectManifest; unknownLayers: OpaqueLayer[] }> {
  if (!isRecord(json)) return err('Project manifest is not a JSON object.');
  const version = json.schema;
  if (
    typeof version === 'string' &&
    version !== SCHEMA_VERSION &&
    version.startsWith('aio.project/')
  ) {
    return err(
      `Project was saved by a newer version of Quadrion AI (schema ${version}). Update the app to open it.`,
    );
  }
  const { known, unknown } = splitLayers(json);
  const r = ProjectManifest.safeParse(known);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
    return err(`Project manifest is invalid${where}: ${first?.message ?? 'unknown error'}`);
  }
  const ids = new Set(r.data.layers.map((l) => l.id));
  for (const u of unknown) {
    if (ids.has(u.id))
      return err(`Project manifest is invalid at layers: Duplicate id "${u.id}" in layers`);
    ids.add(u.id);
  }
  return ok({ manifest: r.data, unknownLayers: unknown });
}

/**
 * Parse untrusted JSON into a manifest, with messages a person can act on. Layers of a kind this
 * build does not know are left out of the result (see `parseManifestTolerant`) instead of refusing
 * the project; writers keep them on disk with `keepUnknownLayers`.
 */
export function parseManifest(json: unknown): Result<ProjectManifest> {
  const r = parseManifestTolerant(json);
  return r.ok ? ok(r.value.manifest) : r;
}

/** The layers of unknown kinds in a manifest file's JSON (none when it is not one). */
export function unknownLayersOf(json: unknown): OpaqueLayer[] {
  return isRecord(json) ? splitLayers(json).unknown : [];
}

/**
 * What to write when saving `next` over a file that held `previous` (its raw JSON, or undefined
 * for a new file): `next` with the previous file's layers of unknown kinds appended unchanged, so
 * a save by this build never drops what a newer build added. Refuses when a new layer took the id
 * of one of them.
 */
export function keepUnknownLayers(
  previous: unknown,
  next: ProjectManifest,
): Result<ProjectManifest | (Omit<ProjectManifest, 'layers'> & { layers: unknown[] })> {
  const unknown = unknownLayersOf(previous);
  if (unknown.length === 0) return ok(next);
  const ids = new Set(next.layers.map((l) => l.id));
  const taken = unknown.find((u) => ids.has(u.id));
  if (taken) {
    return err(
      `Layer id "${taken.id}" is used by a layer from a newer Stratlas (${taken.kind}). Choose another id.`,
    );
  }
  return ok({ ...next, layers: [...next.layers, ...unknown] });
}
