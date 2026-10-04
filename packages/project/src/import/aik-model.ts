import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  Issue,
  type ClassCatalogue,
  type ImageGeom,
  type LensModel,
  type Quat,
  type SeverityModel,
  type Sighting,
  type Vec3,
} from '@aio/schema';
import { fromWgs84 } from '@aio/geo';
import { fitSimilarity2D } from './fit';
import { composeFrame, mapDir, mapPoint, mapQuat, rotateY, type FrameMap } from './frames';
import { cameraQuatLookAlong, roundVec, sub } from './math';

/**
 * Asset Inspection Kit offline builds (EBSM, DAMAC and later jobs): the `window.KIT` document of
 * the viewer HTML, the `data/*.js` chunk scripts and the profile, turned into Stratlas parts.
 * Kit frame: Y up, metres, origin at the asset base centre on the ground, X north, Z east.
 */

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const V3 = z.tuple([z.number(), z.number(), z.number()]);

export const KitProfile = z.object({
  id: z.string(),
  name: z.string(),
  classes: z.array(
    z.object({
      id: z.number(),
      key: z.string(),
      label: z.string(),
      severity: z.number().optional(),
      uncertain: z.boolean().optional(),
      color: Hex,
    }),
  ),
  severity: z.array(
    z.object({ level: z.number().int(), label: z.string(), long: z.string(), color: Hex }),
  ),
  uncertain: z.object({ label: z.string(), long: z.string(), color: Hex }).optional(),
});

export const KitPhoto = z.object({
  id: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  altitude: z.number(),
  position: V3,
  target: V3,
  up: V3.optional(),
  hfov: z.number(),
  vfov: z.number(),
  width: z.number(),
  height: z.number(),
  previewWidth: z.number(),
  previewHeight: z.number(),
  time: z.string().optional(),
  status: z.string(),
  note: z.string().default(''),
  findings: z.array(z.string()).default([]),
  sequence: z.string().optional(),
  zone: z.string().optional(),
});

export const KitFinding = z.object({
  fid: z.string(),
  photo: z.string(),
  severity: z.number().int(),
  class: z.string().nullable(),
  classLabel: z.string().default(''),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  note: z.string().default(''),
  component: z.string().nullable().default(null),
  placement: z.string(),
  center: V3.nullable(),
  normal: V3.nullable(),
  height: z.number().nullable().optional(),
  side: z.string().nullable().optional(),
  zoneLabel: z.string().nullable().optional(),
  coverage: z.number().nullable().optional(),
  defect: z.string().nullable().default(null),
});

export const KitFileEntry = z.object({ chunks: z.array(z.string()).min(1), gz: z.boolean() });

export const KitDoc = z.object({
  job: z
    .object({ title: z.string(), customer: z.string().optional(), location: z.string().optional() })
    .optional(),
  profile: KitProfile,
  photos: z.array(KitPhoto),
  findings: z.array(KitFinding),
  stats: z.record(z.string(), z.unknown()).optional(),
  masks: z.record(z.string(), z.tuple([z.string(), z.number(), z.number()])).optional(),
  files: z.record(z.string(), KitFileEntry).optional(),
  report: z.object({ url: z.string(), name: z.string(), pages: z.number().optional() }).optional(),
  defaultPhoto: z.string().optional(),
  generated: z.string().optional(),
  basemap: z
    .object({
      layers: z.array(
        z.object({
          data: z.string(),
          mime: z.string(),
          y: z.number(),
          tl: z.tuple([z.number(), z.number()]),
          tr: z.tuple([z.number(), z.number()]),
          bl: z.tuple([z.number(), z.number()]),
        }),
      ),
      label: z.string().optional(),
      attribution: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type KitDoc = z.infer<typeof KitDoc>;
export type KitPhoto = z.infer<typeof KitPhoto>;
export type KitFinding = z.infer<typeof KitFinding>;

// ---- data scripts ------------------------------------------------------------------------------

/** A kit offline data script: `__kitData("<key>","<base64>")`. */
export function parseKitDataCall(text: string): { key: string; b64: string } {
  const m = /__kitData\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)/.exec(text);
  if (!m?.[1] || m[2] === undefined)
    throw new Error('Not a kit data script (__kitData call missing)');
  return { key: m[1], b64: m[2] };
}

/** Join a kit file's chunks (base64 each) and gunzip when the kit marked it `gz`. */
export function decodeKitFile(
  entry: z.infer<typeof KitFileEntry>,
  readChunk: (chunk: string) => string,
): Uint8Array {
  const bytes = Buffer.concat(entry.chunks.map((c) => Buffer.from(readChunk(c), 'base64')));
  return new Uint8Array(entry.gz ? gunzipSync(bytes) : bytes);
}

// ---- profile -----------------------------------------------------------------------------------

export function severityModelFromProfile(p: KitDoc['profile'], id: string): SeverityModel {
  const levels = [...p.severity]
    .sort((a, b) => a.level - b.level)
    .map((s) => ({
      value: s.level,
      label: s.label,
      color: s.color.toLowerCase(),
      criteria: s.long,
    }));
  const model: SeverityModel = { id, name: `${p.name} (kit scale)`, levels };
  if (p.uncertain)
    model.uncertain = { label: p.uncertain.long, color: p.uncertain.color.toLowerCase() };
  return model;
}

export function catalogueFromProfile(
  p: KitDoc['profile'],
  severityModelId: string,
  id: string,
): ClassCatalogue {
  return {
    id,
    name: `${p.name} classes`,
    assetType: p.id,
    classes: p.classes.map((c) => {
      const hotkey = String(c.id);
      return {
        id: c.key,
        label: c.label,
        color: c.color.toLowerCase(),
        severityModel: severityModelId,
        ...(hotkey.length === 1 ? { hotkey } : {}),
      };
    }),
  };
}

// ---- frame -------------------------------------------------------------------------------------

export interface KitFrameFit {
  /** Kit frame to the local frame (rotation only; the origin carries the position). */
  frame: FrameMap;
  /** Asset base (kit origin) in the project CRS: E, N, H. */
  origin: Vec3;
  /** Turn of kit north against grid north, degrees counter-clockwise seen from above. */
  thetaDeg: number;
  /** Scale of the best similarity (1 when kit metres match the CRS). */
  scale: number;
  rms: number;
  maxResidual: number;
  /** Spread (max - min) of `altitude - y` over the photos, metres. */
  heightSpread: number;
  n: number;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? NaN) : ((s[m - 1] ?? NaN) + (s[m] ?? NaN)) / 2;
};

/**
 * Fit the kit frame to the project CRS from photo GPS: each photo's kit position (east = z,
 * north = x) against its GPS position in `epsg`. A rigid turn plus translation; the asset base
 * is where the kit origin lands. Height: the median of `altitude - y`.
 */
export function fitKitFrame(
  photos: readonly Pick<KitPhoto, 'latitude' | 'longitude' | 'altitude' | 'position'>[],
  epsg: number,
): KitFrameFit {
  const pairs = photos
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    .map((p) => {
      const [e, n] = fromWgs84([p.longitude, p.latitude, 0], epsg);
      return { src: [p.position[2], p.position[0]] as const, dst: [e, n] as const };
    });
  const sim = fitSimilarity2D(pairs);
  const t = (sim.thetaDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // Rigid fit (unit scale): same turn, translation through the centroids.
  const mean = (f: (p: (typeof pairs)[number]) => number) =>
    pairs.reduce((a, p) => a + f(p), 0) / pairs.length;
  const sx = mean((p) => p.src[0]);
  const sy = mean((p) => p.src[1]);
  const tx = mean((p) => p.dst[0]) - (c * sx - s * sy);
  const ty = mean((p) => p.dst[1]) - (s * sx + c * sy);
  let sum = 0;
  let max = 0;
  for (const p of pairs) {
    const r = Math.hypot(
      c * p.src[0] - s * p.src[1] + tx - p.dst[0],
      s * p.src[0] + c * p.src[1] + ty - p.dst[1],
    );
    sum += r * r;
    max = Math.max(max, r);
  }
  const dh = photos.map((p) => p.altitude - p.position[1]);
  const h0 = median(dh);
  return {
    frame: composeFrame(rotateY(90 + sim.thetaDeg)),
    origin: [
      Math.round(tx * 1000) / 1000,
      Math.round(ty * 1000) / 1000,
      Math.round(h0 * 1000) / 1000,
    ],
    thetaDeg: sim.thetaDeg,
    scale: sim.scale,
    rms: Math.sqrt(sum / pairs.length),
    maxResidual: max,
    heightSpread: Math.max(...dh) - Math.min(...dh),
    n: pairs.length,
  };
}

// ---- photos ------------------------------------------------------------------------------------

export function kitPhotoPose(
  frame: FrameMap,
  p: Pick<KitPhoto, 'position' | 'target' | 'up' | 'hfov' | 'previewWidth' | 'previewHeight'>,
): { pos: Vec3; q: Quat; lens: LensModel } {
  const q = cameraQuatLookAlong(sub(p.target, p.position), p.up ?? [0, 1, 0]);
  return {
    pos: roundVec(mapPoint(frame, p.position), 4),
    q: roundVec(mapQuat(frame, q), 6),
    lens: { model: 'pinhole', hfovDeg: p.hfov, aspect: p.previewWidth / p.previewHeight },
  };
}

/** EXIF `YYYY:MM:DD HH:MM:SS` (site local time) to ISO 8601 with the site's UTC offset. */
export function exifToIso(time: string | undefined, offset: string): string | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(time ?? '');
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset}`;
}

// ---- issues ------------------------------------------------------------------------------------

export interface KitIssueContext {
  severityModelId: string;
  meshLayer: string;
  frame: FrameMap;
  createdAt: string;
  author?: string;
  /** Photo layer that holds a photo id, or null when the photo was not imported. */
  layerOf(photoId: string): string | null;
  /** Project paths of the photo's class mask and uncertain mask (when the kit has them). */
  masksOf(photoId: string): { label?: string; uncertain?: string };
  /** Project path of the patch file written for a finding, or null. */
  patchOf(f: KitFinding): string | null;
}

const AUTHOR = 'Asset Inspection Kit';

function meshSighting(
  f: KitFinding,
  ctx: KitIssueContext,
): Extract<Sighting, { on: 'mesh' }> | null {
  if (!f.center) return null;
  const p = roundVec(mapPoint(ctx.frame, f.center), 4);
  const patch = f.placement === 'patch' ? ctx.patchOf(f) : null;
  if (patch)
    return {
      on: 'mesh',
      layer: ctx.meshLayer,
      geom: { type: 'spatch', src: { path: patch }, center: p },
    };
  const n = roundVec(mapDir(ctx.frame, f.normal ?? [0, 1, 0]), 4);
  return { on: 'mesh', layer: ctx.meshLayer, geom: { type: 'spoint', p, n } };
}

function imageSightings(f: KitFinding, ctx: KitIssueContext, maskDone: Set<string>): Sighting[] {
  const layer = ctx.layerOf(f.photo);
  if (!layer) return [];
  const out: Sighting[] = [];
  const mask = ctx.masksOf(f.photo).label;
  if (mask && !maskDone.has(f.photo)) {
    maskDone.add(f.photo);
    out.push({ on: 'image', layer, photo: f.photo, geom: { type: 'mask', src: { path: mask } } });
  }
  if (f.bbox) {
    const [x0, y0, x1, y1] = f.bbox;
    const geom: ImageGeom = { type: 'box', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (geom.w > 0 && geom.h > 0) out.push({ on: 'image', layer, photo: f.photo, geom });
  }
  return out;
}

function classOf(f: KitFinding, profile: KitDoc['profile']): { id: string; label: string } {
  const byKey = f.class ? profile.classes.find((c) => c.key === f.class) : undefined;
  if (byKey) return { id: byKey.key, label: byKey.label };
  if (f.class) return { id: f.class, label: f.classLabel || f.class };
  // Photo-unit profiles (EBSM) grade without a class: the class whose severity matches the grade.
  const bySev = profile.classes.find((c) => !c.uncertain && c.severity === f.severity);
  return bySev
    ? { id: bySev.key, label: bySev.label }
    : { id: 'unclassified', label: 'Unclassified' };
}

function where(f: KitFinding): string {
  const bits = [
    f.height != null && `${f.height.toFixed(1)} m above datum`,
    f.side && f.side !== 'Not placed' && `${f.side} side`,
    f.zoneLabel,
  ].filter(Boolean);
  return bits.length ? `Location: ${bits.join(', ')}.` : '';
}

const codeOk = (c: string) => /^[A-Z]{1,3}\d{2,4}$/.test(c);
const codeNum = (c: string) => Number(c.replace(/^[A-Z]+/, ''));

/**
 * Kit findings to issues. Region profiles (findings carry a `defect`) give one issue per defect
 * with every sighting; photo profiles give one issue per finding.
 */
export function buildKitIssues(
  kit: Pick<KitDoc, 'profile' | 'findings'>,
  ctx: KitIssueContext,
): Issue[] {
  const groups = new Map<string, KitFinding[]>();
  for (const f of kit.findings) {
    const key = f.defect ?? f.fid;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  const issues: Issue[] = [];
  for (const [key, fs] of groups) {
    fs.sort((a, b) => codeNum(a.fid) - codeNum(b.fid));
    const worst = fs.reduce((a, b) => (b.severity > a.severity ? b : a));
    const cls = classOf(worst, kit.profile);
    const sightings: Sighting[] = [];
    const meshSeen = new Set<string>();
    for (const f of fs) {
      const m = meshSighting(f, ctx);
      if (!m) continue;
      const k = JSON.stringify(m.geom);
      if (meshSeen.has(k)) continue;
      meshSeen.add(k);
      sightings.push(m);
    }
    const maskDone = new Set<string>();
    for (const f of fs) sightings.push(...imageSightings(f, ctx, maskDone));
    if (!sightings.length) continue;
    const notes = [...new Set(fs.map((f) => f.note.trim()).filter(Boolean))];
    const seen =
      fs.length > 1
        ? `Seen in ${fs.length} photos: ${fs.map((f) => `${f.fid} (${f.photo})`).join(', ')}.`
        : `Kit finding ${worst.fid}, photo ${worst.photo}.`;
    const cover =
      fs.length === 1 && worst.coverage != null
        ? `Marked area ${worst.coverage.toFixed(2)} % of the photo.`
        : '';
    const code = codeOk(key) ? key : worst.fid;
    issues.push(
      Issue.parse({
        id: code,
        code,
        classId: cls.id,
        severityModelId: ctx.severityModelId,
        severity: worst.severity,
        status: 'draft',
        title: worst.component ? `${cls.label}, ${worst.component}` : cls.label,
        note: [...notes, where(worst), seen, cover].filter(Boolean).join('\n'),
        author: ctx.author ?? AUTHOR,
        createdAt: ctx.createdAt,
        updatedAt: ctx.createdAt,
        sightings,
        source: 'import',
      }),
    );
  }
  return issues.sort((a, b) => codeNum(a.code) - codeNum(b.code));
}

/** One `uncertain` issue per photo the kit left uncertain (no graded finding). */
export function buildUncertainIssues(
  kit: Pick<KitDoc, 'profile' | 'photos'>,
  ctx: KitIssueContext,
): Issue[] {
  const photos = kit.photos.filter((p) => p.status === 'uncertain' && ctx.layerOf(p.id));
  const pad = photos.length > 99 ? 3 : 2;
  const uncertainClass = kit.profile.classes.find((c) => c.uncertain)?.key ?? 'uncertain';
  const label = kit.profile.uncertain?.long ?? 'Uncertain';
  return photos.map((p, i) => {
    const layer = ctx.layerOf(p.id) ?? '';
    const mask = ctx.masksOf(p.id).uncertain;
    const geom: ImageGeom = mask
      ? { type: 'mask', src: { path: mask } }
      : { type: 'box', x: 0, y: 0, w: p.previewWidth, h: p.previewHeight };
    const code = `U${String(i + 1).padStart(pad, '0')}`;
    return Issue.parse({
      id: code,
      code,
      classId: uncertainClass,
      severityModelId: ctx.severityModelId,
      severity: 'uncertain',
      status: 'draft',
      title: `${label}, photo ${p.id}`,
      note: [
        p.note.trim(),
        mask ? '' : 'No uncertain-area mask in the kit: the whole photo is marked.',
        p.zone ? `Zone ${p.zone}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      author: ctx.author ?? AUTHOR,
      createdAt: ctx.createdAt,
      updatedAt: ctx.createdAt,
      sightings: [{ on: 'image', layer, photo: p.id, geom }],
      source: 'import',
    });
  });
}
