import { z } from 'zod';
import {
  Issue,
  Vec3,
  type AssetTag,
  type ClassCatalogue,
  type SeverityModel,
  type Sighting,
} from '@aio/schema';
import { KIT_FRAME, mapDir, mapPoint } from './frames';
import { normalize, roundVec, scale } from './math';

/** One photo that shows a finding (3D report `TANK_FINDINGS[].photos`). */
export const KitFindingPhoto = z.object({
  image: z.string(),
  src: z.string().optional(),
  flight: z.string(),
  t: z.number(),
  target: Vec3,
  cam: Vec3,
  dir: Vec3,
  dist: z.number().optional(),
  poi: z.string().optional(),
});

export const KitFinding = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.number().int(),
  area: z.string(),
  text: z.string(),
  photos: z.array(KitFindingPhoto),
  report_page: z.number().optional(),
  loc: z
    .object({
      pos: Vec3,
      height_m: z.number(),
      bearing: z.number(),
      r: z.number(),
      span_m: z.number().optional(),
    })
    .optional(),
});
export type KitFinding = z.infer<typeof KitFinding>;
export type KitFindingPhoto = z.infer<typeof KitFindingPhoto>;

export const KitFlightEntry = z.object({
  id: z.string(),
  data: z.string(),
  name: z.string(),
  dur: z.number(),
  pois: z.number(),
});

export const TankMeta = z.object({
  components: z.array(
    z.object({ node: z.string(), group: z.string(), label: z.string(), id: z.string().optional() }),
  ),
});

/** Severity scale of the KOC observation report as used by the kit report (5 most urgent). */
export const HCL_SEVERITY_MODEL: SeverityModel = {
  id: 'hcl-lining',
  name: 'HCl lining',
  levels: [
    {
      value: 1,
      label: 'Low',
      color: '#6fc3ff',
      criteria: 'Cosmetic, no action (not used in the 2023 report).',
    },
    {
      value: 2,
      label: 'Minor',
      color: '#8fd14f',
      criteria: 'Minor defect, record only (not used in the 2023 report).',
    },
    {
      value: 3,
      label: 'Moderate',
      color: '#fad34b',
      criteria: 'Coating blisters or small corrosion that can weaken the lining over time.',
      action: 'Monitor',
    },
    {
      value: 4,
      label: 'High',
      color: '#ff7a2d',
      criteria: 'Patch damage with potential expansion of the affected area.',
      action: 'Plan repair',
    },
    {
      value: 5,
      label: 'Severe',
      color: '#ee3f4b',
      criteria: 'Through-wall defect or leak, integrity and safety of the contents at risk.',
      action: 'Act now',
    },
  ],
};

export const HCL_CATALOGUE: ClassCatalogue = {
  id: 'hcl-tank',
  name: 'Lined acid tank',
  assetType: 'tank',
  classes: [
    { id: 'crack', label: 'Crack', color: '#ee3f4b', hotkey: 'c', severityModel: 'hcl-lining' },
    {
      id: 'patch-damage',
      label: 'Patch damage',
      color: '#ff7a2d',
      hotkey: 'p',
      severityModel: 'hcl-lining',
    },
    {
      id: 'coating-blister',
      label: 'Coating blister',
      color: '#fad34b',
      hotkey: 'b',
      severityModel: 'hcl-lining',
    },
    {
      id: 'corrosion',
      label: 'Corrosion',
      color: '#c9824a',
      hotkey: 'r',
      severityModel: 'hcl-lining',
    },
  ],
};

export function classifyFinding(f: Pick<KitFinding, 'title'>): string {
  const t = f.title.toLowerCase();
  if (t.includes('crack')) return 'crack';
  if (t.includes('patch')) return 'patch-damage';
  if (t.includes('corrosion')) return 'corrosion';
  return 'coating-blister';
}

/** Tank shell inner radius and dished-head crown centre height (GA drawing, kit frame). */
const ROOF_CROWN_CENTRE_Y = 4.8131;

/** Surface normal (pointing into the tank, towards the viewer) at a kit-frame point. */
export function tankNormalKit(area: string, p: Vec3, viewDir: Vec3): Vec3 {
  const a = area.toLowerCase();
  const r = Math.hypot(p[0], p[2]);
  const inward: Vec3 = r > 1e-6 ? [-p[0] / r, 0, -p[2] / r] : [0, 0, 0];
  if (a.includes('bottom')) return [0, 1, 0];
  if (a.includes('joint')) return normalize([inward[0], -1, inward[2]]);
  if (a.includes('roof')) return normalize([-p[0], ROOF_CROWN_CENTRE_Y - p[1], -p[2]]);
  if (a.includes('shell') && r > 1e-6) return inward;
  return normalize(scale(viewDir, -1));
}

export const photoIdOf = (image: string) => image.replace(/^frame:/, '').replace(/\.jpe?g$/i, '');

export interface IssueContext {
  meshLayer: string;
  photosLayer: string;
  /** Review-copy pixel size of a photo id, or null when the photo is not in the layer. */
  photoSize(id: string): { width: number; height: number } | null;
  createdAt: string;
}

/** Turn a kit finding into an `Issue` with mesh sightings at each photo target and image sightings. */
export function buildHclIssue(f: KitFinding, ctx: IssueContext): Issue {
  const sightings: Sighting[] = [];
  const seen = new Set<string>();
  const targets = f.photos.length
    ? f.photos.map((p) => ({ p: p.target, d: p.dir }))
    : f.loc
      ? [{ p: f.loc.pos, d: [0, -1, 0] as Vec3 }]
      : [];
  for (const { p, d } of targets) {
    const key = p.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    sightings.push({
      on: 'mesh',
      layer: ctx.meshLayer,
      geom: {
        type: 'spoint',
        p: roundVec(mapPoint(KIT_FRAME, p), 4),
        n: roundVec(mapDir(KIT_FRAME, tankNormalKit(f.area, p, d)), 4),
      },
    });
  }
  for (const ph of f.photos) {
    const id = photoIdOf(ph.image);
    const size = ctx.photoSize(id);
    if (!size) continue;
    // The kit casts the camera's optical axis onto the model to place the finding, so the
    // finding sits at the image centre.
    sightings.push({
      on: 'image',
      layer: ctx.photosLayer,
      photo: id,
      geom: { type: 'point', x: size.width / 2, y: size.height / 2 },
    });
  }
  const loc = f.loc;
  const where = loc
    ? ` Area: ${f.area}. Height ${loc.height_m.toFixed(2)} m above the bottom plate, bearing ${loc.bearing.toFixed(0)} deg from plant north, ${loc.r.toFixed(2)} m from the tank axis.`
    : ` Area: ${f.area}.`;
  const page = f.report_page ? ` Observation report page ${f.report_page}.` : '';
  return Issue.parse({
    id: f.id,
    code: f.id,
    classId: classifyFinding(f),
    severityModelId: HCL_SEVERITY_MODEL.id,
    severity: f.severity,
    status: 'reviewed',
    title: f.title,
    note: `${f.text}${where}${page}`,
    author: 'KOC observation report 22 Nov 2023',
    createdAt: ctx.createdAt,
    updatedAt: ctx.createdAt,
    sightings,
    source: 'import',
  });
}

/** Mesh layer tags from the kit model metadata (node name, tag, group as area). */
export function tankTags(meta: z.infer<typeof TankMeta>): z.infer<typeof AssetTag>[] {
  return meta.components.map((c) => ({
    node: c.node,
    tag: c.id ?? c.label,
    area: c.group,
  }));
}
