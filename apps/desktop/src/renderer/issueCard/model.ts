/**
 * The issue card (right panel, Issues side panel, Media side): what an issue says about itself
 * and the evidence it is seen on. Pure, so the card, the lightbox and their tests share it.
 *
 * Evidence: one entry per photo the issue is marked on (its boxes, outlines and points in photo
 * pixels, and the kit overlay of any class mask), then one per video sighting (the frame at the
 * first keyframe, with its box). The photo with the largest marked region comes first: it shows
 * the defect closest and clearest (the house report picks the same photo).
 */
import {
  compareCodes,
  imageBox,
  issueAction,
  issueZone,
  severityInfo,
  classInfo,
} from '@aio/project/export';
import type { AssetRef, FrameGeom, ImageGeom, Issue, ProjectManifest } from '@aio/schema';
import type { PaneKind, SplitPref } from '../workspace/splitModel';

export type MarkGeom = Exclude<ImageGeom, { type: 'mask' }>;
export type Box4 = [number, number, number, number];

export interface PhotoEvidence {
  kind: 'photo';
  /** `<layer>/<photo>`. */
  key: string;
  layer: string;
  photo: string;
  src: AssetRef | null;
  /** The issue's shapes on this photo, in photo pixels. */
  shapes: MarkGeom[];
  /** Project paths of the coloured overlays of the issue's class masks on this photo. */
  masks: string[];
  /** Bounds [x, y, w, h] of the shapes (null when only a mask marks the photo). */
  box: Box4 | null;
}

export interface VideoEvidence {
  kind: 'video';
  key: string;
  layer: string;
  name: string;
  src: AssetRef | null;
  poster: AssetRef | null;
  /** Video seconds of the first keyframe. */
  tS: number;
  /** Project clock (UTC ms) of the first keyframe, for "jump to". */
  atMs: number;
  /** The box or outline at the first keyframe, in frame pixels. */
  geom: FrameGeom | null;
}

export type Evidence = PhotoEvidence | VideoEvidence;

/** Kit overlay PNG beside a class mask (`p024_mask.png` to `p024_overlay.png`), else the mask. */
export function overlayPath(mask: string): string {
  return mask.replace(/_mask\.png$/i, '_overlay.png');
}

function unionBox(boxes: readonly Box4[]): Box4 | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, w, h] of boxes) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** The photos and video frames an issue is marked on, best photo first. */
export function issueEvidence(manifest: ProjectManifest, issue: Issue): Evidence[] {
  const photos = new Map<string, PhotoEvidence & { boxes: Box4[] }>();
  const videos: VideoEvidence[] = [];
  for (const s of issue.sightings) {
    if (s.on === 'image') {
      const key = `${s.layer}/${s.photo}`;
      let e = photos.get(key);
      if (!e) {
        const layer = manifest.layers.find((l) => l.id === s.layer);
        const item = layer?.kind === 'photos' ? layer.items.find((p) => p.id === s.photo) : null;
        e = {
          kind: 'photo',
          key,
          layer: s.layer,
          photo: s.photo,
          src: item?.src ?? null,
          shapes: [],
          masks: [],
          box: null,
          boxes: [],
        };
        photos.set(key, e);
      }
      if (s.geom.type === 'mask') {
        if ('path' in s.geom.src) e.masks.push(overlayPath(s.geom.src.path));
      } else {
        e.shapes.push(s.geom);
        const b = imageBox(s.geom);
        if (b) e.boxes.push(b);
      }
    } else if (s.on === 'video') {
      const layer = manifest.layers.find((l) => l.id === s.layer);
      const k = s.track[0];
      const tS = k?.t ?? 0;
      videos.push({
        kind: 'video',
        key: `${s.layer}@${String(tS)}`,
        layer: s.layer,
        name: layer?.name ?? s.layer,
        src: layer?.kind === 'video' ? layer.src : null,
        poster: layer?.kind === 'video' ? (layer.poster ?? null) : null,
        tS,
        atMs: layer?.kind === 'video' ? layer.flight.startUtcMs + layer.offsetMs + tS * 1000 : 0,
        geom: k?.geom ?? null,
      });
    }
  }
  const list: PhotoEvidence[] = [...photos.values()].map(({ boxes, ...e }) => {
    const box = unionBox(boxes);
    return { ...e, masks: [...new Set(e.masks)], box };
  });
  // The largest marked region first (a point counts as a tiny one, a mask-only photo last).
  const area = (e: PhotoEvidence) => (e.box ? Math.max(1, e.box[2] * e.box[3]) : 0);
  const ranked = list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => area(b.e) - area(a.e) || a.i - b.i)
    .map((x) => x.e);
  return [...ranked, ...videos];
}

export const photoEvidence = (list: readonly Evidence[]): PhotoEvidence[] =>
  list.filter((e): e is PhotoEvidence => e.kind === 'photo');

/** What the card says about an issue, in display form. */
export interface IssueFacts {
  classLabel: string;
  classColor: string;
  severityLabel: string;
  severityColor: string;
  /** The zone read from the note, or null when the note names none. */
  zone: string | null;
  /** The severity level's recommended action (else what the level means), or empty. */
  action: string;
  /** Other places the issue is marked (3D model, point cloud, map, panorama), counted. */
  elsewhere: { kind: 'mesh' | 'pointcloud' | 'map' | 'pano'; count: number }[];
}

export function issueFacts(manifest: ProjectManifest, issue: Issue): IssueFacts {
  const sev = severityInfo(manifest, issue);
  const cls = classInfo(manifest, issue.classId);
  const zone = issueZone(issue);
  const counts = new Map<IssueFacts['elsewhere'][number]['kind'], number>();
  for (const s of issue.sightings) {
    if (s.on === 'image' || s.on === 'video') continue;
    counts.set(s.on, (counts.get(s.on) ?? 0) + 1);
  }
  return {
    classLabel: cls.label,
    classColor: cls.color,
    severityLabel: sev.label,
    severityColor: sev.color,
    zone: zone === 'Not zoned' ? null : zone,
    action: issueAction(manifest, issue),
    elsewhere: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}

/** Issue ids in natural code order (D2 before D10): the card's previous and next. */
export function issueOrder(issues: readonly Pick<Issue, 'id' | 'code'>[]): string[] {
  return [...issues].sort((a, b) => compareCodes(a.code, b.code)).map((i) => i.id);
}

/** The issue `dir` steps from `id` in `order`, wrapping; the first or last when `id` is not in it. */
export function stepIssue(order: readonly string[], id: string, dir: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = order.indexOf(id);
  if (at < 0) return (dir === 1 ? order[0] : order[order.length - 1]) ?? null;
  return order[(at + dir + order.length) % order.length] ?? null;
}

/**
 * Crop [x, y, w, h] of a photo around a marked box for a small preview: twice the box with
 * context, at least 30 % of the photo, at `aspect`, kept inside the photo. The whole photo
 * without a box. (The house report's close-up uses the same rule.)
 */
export function previewCrop(box: Box4 | null, imgW: number, imgH: number, aspect = 4 / 3): Box4 {
  if (!box) return [0, 0, imgW, imgH];
  const [bx, by, bw, bh] = box;
  let w = Math.max(bw * 2, bh * 2 * aspect, imgW * 0.3);
  let h = w / aspect;
  if (h > imgH) {
    h = imgH;
    w = h * aspect;
  }
  if (w > imgW) {
    w = imgW;
    h = w / aspect;
  }
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const x = Math.min(Math.max(0, cx - w / 2), imgW - w);
  const y = Math.min(Math.max(0, cy - h / 2), imgH - h);
  return [x, y, w, h];
}

// ---- evidence beside the 3D view ----

export type EvidenceKind = 'photo' | 'video';

/** What the evidence pane can show for an issue: a photo, else a video frame, else nothing. */
export function evidenceKind(manifest: ProjectManifest, issue: Issue): EvidenceKind | null {
  const list = issueEvidence(manifest, issue);
  if (photoEvidence(list).length > 0) return 'photo';
  if (list.some((e) => e.kind === 'video')) return 'video';
  return null;
}

/**
 * The split with the 3D view on one side and `kind` on the other: the 3D side stays where it is
 * (the evidence takes the non-3D side); without the 3D view in the split, 3D goes left.
 */
export function splitWithEvidence(sides: SplitPref, kind: PaneKind): SplitPref {
  if (sides.left === '3d') return { ...sides, right: kind };
  if (sides.right === '3d') return { ...sides, left: kind };
  return { ...sides, left: '3d', right: kind };
}

// ---- the full-size photo viewer over the app ----

export interface LightboxState {
  issueId: string;
  /** Index into the issue's photos. */
  index: number;
  /** Boxes, outlines and masks drawn over the photo. */
  marks: boolean;
}

export type LightboxAction =
  | { type: 'open'; issueId: string; index: number }
  | { type: 'step'; dir: 1 | -1; count: number }
  | { type: 'marks' }
  | { type: 'close' };

export function lightboxReducer(s: LightboxState | null, a: LightboxAction): LightboxState | null {
  switch (a.type) {
    case 'open':
      return { issueId: a.issueId, index: Math.max(0, a.index), marks: s?.marks ?? true };
    case 'close':
      return null;
    case 'marks':
      return s ? { ...s, marks: !s.marks } : s;
    case 'step':
      if (!s || a.count <= 1) return s;
      return { ...s, index: (s.index + a.dir + a.count) % a.count };
  }
}
