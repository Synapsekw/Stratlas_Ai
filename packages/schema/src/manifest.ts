import { z } from 'zod';
import { Id, IsoDate, Vec3, err, ok, uniqueIds, type Result } from './common';
import { Layer } from './layers';
import { ClassCatalogue, SeverityModel } from './severity';

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
  })
  .superRefine(uniqueIds('layers'))
  .superRefine(uniqueIds('severityModels'))
  .superRefine(uniqueIds('captures'));

export type Capture = z.infer<typeof Capture>;
export type ProjectManifest = z.infer<typeof ProjectManifest>;
export type ProjectManifestInput = z.input<typeof ProjectManifest>;

/** Parse untrusted JSON into a manifest, with messages a person can act on. */
export function parseManifest(json: unknown): Result<ProjectManifest> {
  if (typeof json !== 'object' || json === null)
    return err('Project manifest is not a JSON object.');
  const version = (json as { schema?: unknown }).schema;
  if (
    typeof version === 'string' &&
    version !== SCHEMA_VERSION &&
    version.startsWith('aio.project/')
  ) {
    return err(
      `Project was saved by a newer Stratlas (schema ${version}). Update the app to open it.`,
    );
  }
  const r = ProjectManifest.safeParse(json);
  if (r.success) return ok(r.data);
  const first = r.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
  return err(`Project manifest is invalid${where}: ${first?.message ?? 'unknown error'}`);
}
