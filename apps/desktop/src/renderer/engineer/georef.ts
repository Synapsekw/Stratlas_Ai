/** Placement in the recorded measurement frame, including rebasing to a later project origin. */
import { layerTransformToGeoref, localToProject } from '@aio/geo';
import type { ProcModel, EngineerSetup, EvidencePack, Georef, Vec3 } from '@aio/schema';

export function georefFor(
  model: ProcModel,
  setup: EngineerSetup,
  evidence: EvidencePack | null,
  project: { crs: { epsg: number } | { wkt: string }; origin: Vec3 },
): Georef {
  const metric = (evidence?.samples.kept ?? 0) > 0;
  const anchor = setup.placement === 'anchor' ? setup.anchor : undefined;
  const sourceProject = evidence?.frame ? { ...project, origin: evidence.frame.origin } : project;
  const sourceAnchor: Vec3 | undefined = anchor
    ? [
        anchor[0] + project.origin[0] - sourceProject.origin[0],
        anchor[1] + project.origin[2] - sourceProject.origin[2],
        anchor[2] - project.origin[1] + sourceProject.origin[1],
      ]
    : undefined;
  // where the assembler stood the model: the measured base, else the anchor, else the origin
  const measuredBase = metric ? (evidence?.base ?? evidence?.axis?.point) : undefined;
  const shift: Vec3 =
    sourceAnchor && measuredBase
      ? [
          sourceAnchor[0] - measuredBase[0],
          sourceAnchor[1] - measuredBase[1],
          sourceAnchor[2] - measuredBase[2],
        ]
      : [0, 0, 0];
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...shift, 1];
  const g = layerTransformToGeoref(transform, sourceProject, null, 'engineer');
  const horizontal: Georef['horizontal']['status'] = anchor
    ? 'user'
    : setup.placement === 'from-source' && metric
      ? 'from-source'
      : 'unplaced';
  if (anchor) g.anchor = localToProject([anchor[0], anchor[1], anchor[2]], project.origin);
  const scale = model.scale?.status ?? 'provisional';
  return {
    ...g,
    heading: { deg: g.heading.deg, status: metric ? 'measured' : 'assumed-grid' },
    scale: {
      factor: g.scale.factor,
      status:
        scale === 'measured' ? 'measured' : scale === 'reference' ? 'reference' : 'provisional',
    },
    horizontal: { status: horizontal },
  };
}
