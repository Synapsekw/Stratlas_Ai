import {
  allClasses,
  boundsOf,
  photoSrc,
  polygonArea,
  rotboxCorners,
  severityInfo,
  sortByCode,
  type ExportContext,
} from './facts';

export interface CocoImage {
  id: number;
  file_name: string;
  width: number;
  height: number;
  /** Photo layer and photo id in the project. */
  aio_layer: string;
  aio_photo: string;
}

export interface CocoCategory {
  id: number;
  name: string;
  supercategory: string;
  aio_label: string;
  aio_color: string;
}

export interface CocoAnnotation {
  id: number;
  image_id: number;
  category_id: number;
  bbox: [number, number, number, number];
  area: number;
  iscrowd: 0;
  segmentation: number[][];
  attributes: {
    issue_id: string;
    issue_code: string;
    severity: number | 'uncertain';
    severity_label: string;
    status: string;
    geometry: 'box' | 'rotbox' | 'polygon' | 'point';
  };
}

export interface CocoDataset {
  info: { description: string; version: string; year: number; date_created: string };
  licenses: [];
  images: CocoImage[];
  categories: CocoCategory[];
  annotations: CocoAnnotation[];
}

/** Pixel size of a photo's review copy, or null when it cannot be read. */
export type PhotoSize = (layer: string, photo: string) => { width: number; height: number } | null;

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * COCO detection dataset of the image sightings: categories are the class catalogue (ids from
 * 1 in catalogue order), images the review copies the boxes are drawn on. Masks are left to the
 * masks ZIP (kit masks are per photo, not per issue); points become 1 px boxes.
 */
export function issuesCoco(ctx: ExportContext, sizeOf: PhotoSize, now = new Date()): CocoDataset {
  const m = ctx.manifest;
  const categories: CocoCategory[] = allClasses(m).map((c, i) => ({
    id: i + 1,
    name: c.id,
    supercategory: m.classCatalogues.find((k) => k.classes.includes(c))?.assetType ?? 'issue',
    aio_label: c.label,
    aio_color: c.color,
  }));
  const catId = new Map(categories.map((c) => [c.name, c.id]));
  const images: CocoImage[] = [];
  const imageId = new Map<string, number | null>();
  const annotations: CocoAnnotation[] = [];

  const imageFor = (layer: string, photo: string): number | null => {
    const key = `${layer}\u0000${photo}`;
    const known = imageId.get(key);
    if (known !== undefined) return known;
    const src = photoSrc(m, layer, photo);
    const size = src ? sizeOf(layer, photo) : null;
    if (!src || !size) {
      imageId.set(key, null);
      return null;
    }
    const id = images.length + 1;
    images.push({
      id,
      file_name: src,
      width: size.width,
      height: size.height,
      aio_layer: layer,
      aio_photo: photo,
    });
    imageId.set(key, id);
    return id;
  };

  for (const issue of sortByCode(ctx.issues)) {
    const category = catId.get(issue.classId);
    if (category === undefined) continue;
    const sev = severityInfo(m, issue);
    for (const s of issue.sightings) {
      if (s.on !== 'image' || s.geom.type === 'mask') continue;
      const image = imageFor(s.layer, s.photo);
      if (image === null) continue;
      const g = s.geom;
      let bbox: [number, number, number, number];
      let segmentation: number[][];
      let area: number;
      if (g.type === 'box') {
        bbox = [g.x, g.y, g.w, g.h];
        segmentation = [[g.x, g.y, g.x + g.w, g.y, g.x + g.w, g.y + g.h, g.x, g.y + g.h]];
        area = g.w * g.h;
      } else if (g.type === 'rotbox') {
        const pts = rotboxCorners(g.x, g.y, g.w, g.h, g.angleDeg);
        bbox = boundsOf(pts);
        segmentation = [pts.flat()];
        area = g.w * g.h;
      } else if (g.type === 'polygon') {
        bbox = boundsOf(g.points);
        segmentation = [g.points.flat()];
        area = polygonArea(g.points);
      } else {
        bbox = [g.x - 0.5, g.y - 0.5, 1, 1];
        segmentation = [];
        area = 1;
      }
      annotations.push({
        id: annotations.length + 1,
        image_id: image,
        category_id: category,
        bbox: bbox.map(r2) as [number, number, number, number],
        area: r2(area),
        iscrowd: 0,
        segmentation: segmentation.map((poly) => poly.map(r2)),
        attributes: {
          issue_id: issue.id,
          issue_code: issue.code,
          severity: issue.severity,
          severity_label: sev.label,
          status: issue.status,
          geometry: g.type,
        },
      });
    }
  }
  return {
    info: {
      description: `${m.name} issues`,
      version: '1.0',
      year: now.getUTCFullYear(),
      date_created: now.toISOString(),
    },
    licenses: [],
    images,
    categories,
    annotations,
  };
}
