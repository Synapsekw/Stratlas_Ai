import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import type { Layer, PhotoRef, ProjectManifestInput, Vec3 } from '@aio/schema';
import {
  KitDoc,
  buildKitIssues,
  buildUncertainIssues,
  catalogueFromProfile,
  decodeKitFile,
  exifToIso,
  fitKitFrame,
  kitPhotoPose,
  parseKitDataCall,
  severityModelFromProfile,
  type KitFinding,
  type KitIssueContext,
  type KitPhoto,
} from './aik-model';
import { mapPoint, meshTransform } from './frames';
import { extractWindowJson } from './kitdata';
import { roundVec } from './math';
import { resizeImage } from './media';
import { ISSUES_SCHEMA, validatePackage } from './package';
import { ImportReport, formatBytes } from './report';
import { PackageWriter } from './writer';

export interface AikImportOptions {
  /** Kit offline build folder (read only): `OPEN ... Review.html`, data/, photos/, _rebuild/. */
  src: string;
  /** Project package folder to create or update. */
  out: string;
  /** Project id (folder name under projects/). */
  id: string;
  /** Project CRS: a WGS84 UTM zone (32639 Kuwait, 32640 Dubai). */
  epsg: number;
  /** Site UTC offset for EXIF times, e.g. `+03:00`. */
  utcOffset: string;
  /** `all` kit photos, or `reviewed`: photos with a finding or an uncertain area, plus the cover. */
  photos: 'all' | 'reviewed';
  name?: string;
  log?: (msg: string) => void;
}

export interface AikImportResult {
  manifestPath: string;
  layers: number;
  issues: number;
  photos: number;
  written: number;
  skipped: number;
  warnings: string[];
}

const THUMB_PX = 480;
const REVIEW_PX = 2560;
const MESH_LAYER = 'model';

type AssetTag = NonNullable<Extract<Layer, { kind: 'mesh' }>['tags']>[number];

const Cameras = z.object({
  photos: z.array(z.looseObject({ id: z.string(), kind: z.string().optional() })),
});
const Assessment = z.object({
  findings: z
    .array(
      z.object({
        id: z.string(),
        photo: z.string(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
      }),
    )
    .default([]),
});
const SurfacePatch = z.object({
  finding: z.string().optional(),
  photo: z.string().optional(),
  component: z.string().nullable().optional(),
  textureData: z.string().optional(),
  positions: z.string(),
  uvs: z.string().optional(),
  vertexCount: z.number().optional(),
});
const Surface = z.object({ patches: z.array(SurfacePatch).default([]) });

const f32 = (b64: string) => {
  const b = Buffer.from(b64, 'base64');
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
};
const r = (v: number, d: number) => {
  const f = 10 ** d;
  const x = Math.round(v * f) / f;
  return Object.is(x, -0) ? 0 : x;
};

/** JSON chunk of a GLB, or null when the bytes are not a GLB. */
function glbJsonOf(
  b: Uint8Array,
): { nodes?: { name?: string }[]; extensionsUsed?: string[] } | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') return null;
  const len = buf.readUInt32LE(12);
  return JSON.parse(buf.toString('utf8', 20, 20 + len)) as {
    nodes?: { name?: string }[];
    extensionsUsed?: string[];
  };
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: readonly T[], n: number, fn: (t: T) => Promise<unknown>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function walkFiles(dir: string, skip: (rel: string) => boolean, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = relative(base, abs).replace(/\\/g, '/');
    if (skip(rel)) continue;
    if (e.isDirectory()) out.push(...walkFiles(abs, skip, base));
    else out.push(rel);
  }
  return out;
}

/** Import an Asset Inspection Kit offline build (EBSM, DAMAC, ...) as a native project. */
export async function importAik(opts: AikImportOptions): Promise<AikImportResult> {
  const log = opts.log ?? (() => undefined);
  const src = (...p: string[]) => join(opts.src, ...p);
  const job = (...p: string[]) => src('_rebuild', 'job', ...p);
  const w = new PackageWriter(opts.out);

  const htmlName = readdirSync(opts.src).find(
    (f) =>
      f.toLowerCase().endsWith('.html') && readFileSync(src(f), 'utf8').includes('window.KIT='),
  );
  if (!htmlName) throw new Error(`No kit viewer HTML (window.KIT) in ${opts.src}`);
  const kit = KitDoc.parse(extractWindowJson(readFileSync(src(htmlName), 'utf8'), 'KIT'));
  const title = opts.name ?? kit.job?.title ?? opts.id;
  const rep = new ImportReport(`${title}: import report`);
  const fileCache = new Map<string, Uint8Array>();
  const kitFile = (key: string): Uint8Array | null => {
    const entry = kit.files?.[key];
    if (!entry) return null;
    let b = fileCache.get(key);
    if (!b) {
      b = decodeKitFile(
        entry,
        (c) => parseKitDataCall(readFileSync(src('data', `${c}.js`), 'utf8')).b64,
      );
      fileCache.set(key, b);
    }
    return b;
  };
  const readJob = <T>(name: string, schema: z.ZodType<T>): T | null =>
    existsSync(job(name)) ? schema.parse(JSON.parse(readFileSync(job(name), 'utf8'))) : null;
  const cameras = readJob('cameras.json', Cameras);
  const assessment = readJob('assessment.json', Assessment);
  const jobYaml = existsSync(job('job.yaml')) ? readFileSync(job('job.yaml'), 'utf8') : '';

  // Frame ----------------------------------------------------------------------------------------
  const fit = fitKitFrame(kit.photos, opts.epsg);
  const frame = fit.frame;
  log(
    `frame: turn ${fit.thetaDeg.toFixed(2)} deg, rms ${fit.rms.toFixed(2)} m over ${fit.n} photos`,
  );
  const layers: Layer[] = [];

  // Model ----------------------------------------------------------------------------------------
  const kitModel = kitFile('model');
  const dlGlb = existsSync(src('downloads'))
    ? readdirSync(src('downloads')).find((f) => f.toLowerCase().endsWith('.glb'))
    : undefined;
  const dlBytes = dlGlb ? new Uint8Array(readFileSync(src('downloads', dlGlb))) : null;
  const modelBytes = dlBytes ?? kitModel;
  if (!modelBytes) throw new Error('No model: neither downloads/*.glb nor a kit "model" data file');
  const gltf = glbJsonOf(modelBytes);
  if (!gltf) throw new Error('The kit model is not a GLB after unwrapping');
  const modelRel = `models/${dlGlb ?? `${opts.id}-model.glb`}`;
  if (dlGlb) await w.copy(src('downloads', dlGlb), modelRel);
  else w.write(modelRel, modelBytes);
  if (dlBytes && kitModel && !Buffer.from(dlBytes).equals(Buffer.from(kitModel))) {
    rep.warn(`downloads/${dlGlb} differs from the viewer's data/model.js; the download was used.`);
  }
  const tags: AssetTag[] = (gltf.nodes ?? [])
    .map((n) => n.name)
    .filter((n): n is string => Boolean(n))
    .map((n) => ({ node: n, tag: (n.split('|').pop() ?? n).trim() }));
  layers.push({
    kind: 'mesh',
    id: MESH_LAYER,
    name: `${title} (kit model)`,
    visible: true,
    src: { path: modelRel },
    transform: meshTransform(frame),
    ...(tags.length ? { tags } : {}),
  });
  rep.count('Mesh layers');
  log(`model ${modelRel}`);

  // Photos ---------------------------------------------------------------------------------------
  const cover = /^cover:\s*\n\s+photo:\s*(\S+)/m.exec(jobYaml)?.[1] ?? kit.defaultPhoto;
  const kindOf = new Map((cameras?.photos ?? []).map((c) => [c.id, c.kind ?? '']));
  const chosen = kit.photos.filter(
    (p) => opts.photos === 'all' || p.status !== 'none' || p.id === cover,
  );
  const isThermal = (p: KitPhoto) => kindOf.get(p.id) === 'T';
  const layerOfPhoto = new Map<string, string>();
  const items: { photos: PhotoRef[]; thermal: PhotoRef[] } = { photos: [], thermal: [] };
  const present: KitPhoto[] = [];
  for (const p of chosen) {
    const preview = src('photos', `${p.id}.jpg`);
    if (!existsSync(preview)) {
      rep.warn(`Photo ${p.id} is in the kit but not in photos/`);
      continue;
    }
    present.push(p);
    const pose = kitPhotoPose(frame, p);
    const item: PhotoRef = {
      id: p.id,
      src: { path: `photos/${p.id}.jpg` },
      pos: pose.pos,
      q: pose.q,
      lens: pose.lens,
    };
    const takenAt = exifToIso(p.time, opts.utcOffset);
    if (takenAt) item.takenAt = takenAt;
    const layer = isThermal(p) ? 'thermal' : 'photos';
    items[layer].push(item);
    layerOfPhoto.set(p.id, layer);
  }
  await pool(present, 6, async (p) => {
    const preview = src('photos', `${p.id}.jpg`);
    const rel = `photos/${p.id}.jpg`;
    if (Math.max(p.previewWidth, p.previewHeight) > REVIEW_PX) {
      await w.derive(rel, [preview], (o) => resizeImage(preview, o, REVIEW_PX));
    } else await w.copy(preview, rel);
    await w.derive(`photos/thumbs/${p.id}.jpg`, [preview], (o) =>
      resizeImage(preview, o, THUMB_PX, 4),
    );
  });
  const thermalName = 'Thermal photos';
  layers.push({
    kind: 'photos',
    id: 'photos',
    name: items.thermal.length ? 'RGB photos' : 'Inspection photos',
    visible: true,
    items: items.photos,
  });
  if (items.thermal.length) {
    layers.push({
      kind: 'photos',
      id: 'thermal',
      name: thermalName,
      visible: true,
      items: items.thermal,
    });
  }
  rep.count('Photos (RGB layer)', items.photos.length);
  if (items.thermal.length) rep.count('Photos (thermal layer)', items.thermal.length);
  log(`photos ${present.length}`);

  // Masks ----------------------------------------------------------------------------------------
  const masks = new Map<string, { label?: string; uncertain?: string }>();
  const slice = (key: string): Uint8Array | null => {
    const ref = kit.masks?.[key];
    if (!ref) return null;
    const file = kitFile(ref[0]);
    return file ? file.subarray(ref[1], ref[1] + ref[2]) : null;
  };
  for (const p of present) {
    const m: { label?: string; uncertain?: string } = {};
    const lbl = slice(`lbl/${p.id}`);
    const ov = slice(`ov/${p.id}`);
    const unc = slice(`unc/${p.id}`);
    if (lbl) {
      m.label = `photos/masks/${p.id}_mask.png`;
      w.write(m.label, lbl);
      w.write(`photos/masks/${p.id}_overlay.png`, ov ?? lbl);
      rep.count('Class masks (with overlay)');
    }
    if (unc) {
      m.uncertain = `photos/masks/${p.id}_uncertain_mask.png`;
      w.write(m.uncertain, unc);
      w.write(`photos/masks/${p.id}_uncertain_overlay.png`, unc);
      rep.count('Uncertain-area masks');
    }
    masks.set(p.id, m);
  }

  // Surface patches ------------------------------------------------------------------------------
  const surfaceJson = existsSync(job('surface.json'))
    ? (JSON.parse(readFileSync(job('surface.json'), 'utf8')) as unknown)
    : (() => {
        const b = kitFile('surface');
        return b ? (JSON.parse(Buffer.from(b).toString('utf8')) as unknown) : { patches: [] };
      })();
  const surface = Surface.parse(surfaceJson);
  const byPhoto = new Map<string, KitFinding[]>();
  for (const f of kit.findings) byPhoto.set(f.photo, [...(byPhoto.get(f.photo) ?? []), f]);
  const assessed = new Map((assessment?.findings ?? []).map((a) => [a.id, a]));
  const sameBox = (a: readonly number[] | null, b: readonly number[] | null) =>
    !!a && !!b && a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < 0.6);
  const patchFiles = new Map<string, string>();
  for (const sp of surface.patches) {
    let f: KitFinding | undefined;
    const a = sp.finding ? assessed.get(sp.finding) : undefined;
    if (a) f = byPhoto.get(a.photo)?.find((k) => sameBox(k.bbox, a.bbox));
    else if (sp.photo)
      f = byPhoto.get(sp.photo)?.find((k) => k.placement === 'patch' && !patchFiles.has(k.fid));
    if (!f) {
      rep.count('Surface patches without a kit finding (skipped)');
      continue;
    }
    const pos = f32(sp.positions);
    const local: number[] = [];
    for (let i = 0; i + 2 < pos.length; i += 3) {
      local.push(
        ...mapPoint(frame, [pos[i] ?? 0, pos[i + 1] ?? 0, pos[i + 2] ?? 0]).map((v) => r(v, 4)),
      );
    }
    const rel = `models/patches/${f.fid}.json`;
    const tex = /^data:image\/png;base64,(.*)$/.exec(sp.textureData ?? '')?.[1];
    if (tex) w.write(`models/patches/${f.fid}.png`, Buffer.from(tex, 'base64'));
    w.writeJson(
      rel,
      {
        schema: 'aio.patch/1',
        finding: f.fid,
        photo: f.photo,
        component: f.component,
        center: f.center ? roundVec(mapPoint(frame, f.center), 4) : null,
        vertexCount: local.length / 3,
        positions: local,
        uvs: sp.uvs ? Array.from(f32(sp.uvs), (v) => r(v, 5)) : [],
        texture: tex ? `models/patches/${f.fid}.png` : null,
      },
      false,
    );
    patchFiles.set(f.fid, rel);
    rep.count('Surface patches (decals, local frame)');
  }

  // Street map (DAMAC) ---------------------------------------------------------------------------
  const rasterLayers: Layer[] = [];
  for (const [i, b] of (kit.basemap?.layers ?? []).entries()) {
    const bytes = kitFile(b.data);
    if (!bytes) continue;
    const ext = b.mime.split('/')[1] ?? 'webp';
    const rel = `rasters/${b.data}.${ext}`;
    w.write(rel, bytes);
    const c = (p: readonly [number, number]): Vec3 =>
      roundVec(mapPoint(frame, [p[0], b.y, p[1]]), 3);
    rasterLayers.push({
      kind: 'raster',
      id: `streetmap-${i}`,
      name: `${kit.basemap?.label ?? 'Street map'} ${i === 0 ? 'wide' : 'close'} (${kit.basemap?.attribution ?? ''})`.trim(),
      visible: i > 0,
      src: { path: rel },
      role: 'plan',
      format: 'image',
      corners: { tl: c(b.tl), tr: c(b.tr), bl: c(b.bl) },
    });
    rep.count('Street map rasters');
  }
  layers.push(...rasterLayers);

  // Issues ---------------------------------------------------------------------------------------
  const modelId = `aik-${kit.profile.id}`;
  const severity = severityModelFromProfile(kit.profile, modelId);
  const catalogue = catalogueFromProfile(kit.profile, modelId, `${modelId}-classes`);
  const createdAt = new Date(kit.generated ?? Date.now()).toISOString();
  const ctx: KitIssueContext = {
    severityModelId: modelId,
    meshLayer: MESH_LAYER,
    frame,
    createdAt,
    layerOf: (id) => layerOfPhoto.get(id) ?? null,
    masksOf: (id) => masks.get(id) ?? {},
    patchOf: (f) => patchFiles.get(f.fid) ?? null,
  };
  const graded = buildKitIssues(kit, ctx);
  const uncertain = buildUncertainIssues(kit, ctx);
  const issues = [...graded, ...uncertain];
  rep.count('Issues (graded)', graded.length);
  rep.count('Issues (uncertain)', uncertain.length);
  rep.count(
    'Issue sightings',
    issues.reduce((a, i) => a + i.sightings.length, 0),
  );
  rep.count(
    'Mesh sightings',
    issues.reduce((a, i) => a + i.sightings.filter((s) => s.on === 'mesh').length, 0),
  );

  // Report files, thumbnail ----------------------------------------------------------------------
  if (kit.report && existsSync(src(kit.report.url))) {
    await w.copy(src(kit.report.url), `report/${basename(kit.report.url)}`);
  } else rep.warn('No PDF report in the build');
  for (const f of existsSync(src('downloads')) ? readdirSync(src('downloads')) : []) {
    if (f.toLowerCase().endsWith('.csv')) await w.copy(src('downloads', f), `report/${f}`);
  }
  const thumbSrc =
    cover && existsSync(src('photos', `${cover}.jpg`)) ? src('photos', `${cover}.jpg`) : null;
  if (thumbSrc)
    await w.derive('thumbnail.jpg', [thumbSrc], (o) => resizeImage(thumbSrc, o, 960, 3));

  // Legacy viewer --------------------------------------------------------------------------------
  const legacyFiles = walkFiles(opts.src, (rel) => rel === '_rebuild' || rel.endsWith('.partial'));
  await pool(legacyFiles, 16, (rel) => w.link(src(rel), `legacy/${rel}`));
  layers.push({
    kind: 'legacy',
    id: 'legacy',
    name: 'Original kit viewer (offline build)',
    visible: false,
    viewer: 'aik',
    entry: { path: `legacy/${htmlName}` },
  });
  rep.count('Legacy viewer files (hard links)', legacyFiles.length);
  rep.note(
    'The `legacy` size in the table counts hard links to the source build; on the same volume they take no extra disk space.',
  );

  // Manifest -------------------------------------------------------------------------------------
  const times = present
    .map((p) => exifToIso(p.time, opts.utcOffset))
    .filter((t): t is string => !!t)
    .sort();
  const date = (times[0] ?? createdAt).slice(0, 10);
  const manifestInput: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: opts.id,
    name: title,
    ...(kit.job?.customer ? { customer: kit.job.customer } : {}),
    ...(kit.job?.location ? { site: kit.job.location } : {}),
    crs: { epsg: opts.epsg },
    origin: fit.origin,
    captures: [{ id: `drone-${date}`, label: 'Drone inspection', date }],
    layers,
    severityModels: [severity],
    classCatalogues: [catalogue],
  };
  const valid = validatePackage(manifestInput, issues);
  w.writeJson('manifest.json', valid.manifest);
  w.writeJson('issues.json', { schema: ISSUES_SCHEMA, issues: valid.issues });
  for (const d of ['photos', 'models/patches', 'rasters', 'legacy']) w.prune(d);

  // Report ---------------------------------------------------------------------------------------
  const stats = z
    .object({
      photos: z.number().optional(),
      findings: z.number().optional(),
      defects: z.number().nullable().optional(),
      uncertain_only: z.number().optional(),
      severity: z.record(z.string(), z.number()).optional(),
      defect_severity: z.record(z.string(), z.number()).optional(),
    })
    .parse(kit.stats ?? {});
  const defects = new Set(kit.findings.map((f) => f.defect).filter(Boolean)).size;
  const row = (what: string, want: number | null | undefined, got: number) => {
    if (want != null && want !== got) rep.warn(`${what}: kit stats ${want}, imported ${got}`);
    return `| ${what} | ${want ?? 'n/a'} | ${got} |`;
  };
  const sevWant = (defects ? stats.defect_severity : stats.severity) ?? {};
  const sevRows = Object.entries(sevWant).map(([level, n]) =>
    row(
      `Graded issues at severity ${level}`,
      n,
      graded.filter((i) => String(i.severity) === level).length,
    ),
  );
  if (fit.heightSpread > 2) {
    rep.warn(
      `Height datum: photo GPS altitude minus kit height spreads over ${fit.heightSpread.toFixed(1)} m, so origin H (${fit.origin[2].toFixed(2)}) is only approximate; heights stay on the kit datum (${/datum_label:\s*(.+)/.exec(jobYaml)?.[1]?.trim() ?? 'asset base'}).`,
    );
  }
  rep.section('Kit stats against the import', [
    '| Item | Kit stats | Imported |',
    '| --- | ---: | ---: |',
    row('Photos in the kit', stats.photos, kit.photos.length),
    row('Findings (sightings)', stats.findings, kit.findings.length),
    ...(defects
      ? [row('Defects (graded issues)', stats.defects, graded.length)]
      : [row('Findings (graded issues)', stats.findings, graded.length)]),
    ...sevRows,
    row('Uncertain-only photos (uncertain issues)', stats.uncertain_only, uncertain.length),
    `| Photos imported | ${opts.photos === 'all' ? 'all' : 'reviewed + cover'} | ${present.length} |`,
  ]);
  const o = fit.origin;
  rep.section('Frame', [
    'Kit frame: Y up, metres, origin at the asset base centre on the ground, X north, Z east. Local frame: X east, Y up, Z south.',
    `Fit of the kit photo positions against their GPS in EPSG:${opts.epsg} (${fit.n} photos): kit north is ${Math.abs(fit.thetaDeg).toFixed(2)} deg ${fit.thetaDeg >= 0 ? 'counter-clockwise' : 'clockwise'} from grid north (includes grid convergence), similarity scale ${fit.scale.toFixed(4)}, rigid residual rms ${fit.rms.toFixed(2)} m, max ${fit.maxResidual.toFixed(2)} m.`,
    `Mapping: \`local = Ry(${(90 + fit.thetaDeg).toFixed(3)} deg) * kit\` (90 deg kit-to-local turn plus the fitted turn); the GLB is copied unchanged and the turn is baked into the mesh layer \`transform\`. Photo poses, surface points, patches and street-map corners use the same map.`,
    `Origin (asset base): E ${o[0].toFixed(3)}, N ${o[1].toFixed(3)}, H ${o[2].toFixed(3)} (H = median of photo GPS altitude minus kit height; spread ${fit.heightSpread.toFixed(2)} m).`,
  ]);
  rep.section('What was converted', [
    `- Model: \`${modelRel}\` (${formatBytes(modelBytes.length)}${gltf.extensionsUsed?.length ? `, extensions ${gltf.extensionsUsed.join(', ')}` : ''}; the viewer's \`data/model.js\` is the same GLB gzip-wrapped in base64), ${tags.length} node tags.`,
    `- Photos: the kit's 2560 px review copies as-is with 480 px thumbnails; pose from the kit camera position, target and up (pinhole, kit hfov).${items.thermal.length ? ' H20T thermal frames (kind T in cameras.json) are a separate layer.' : ''}`,
    '- Masks: from the viewer mask sprites: `<id>_mask.png` (class index), `<id>_overlay.png` (colour), `<id>_uncertain_mask.png` / `_uncertain_overlay.png` (purple uncertain areas).',
    `- Severity model "${severity.name}" (${severity.levels.map((l) => `${l.value} ${l.label}`).join(', ')}, uncertain) and the profile classes.`,
    defects
      ? '- Issues: one per kit defect (D codes) with every sighting: a box and the photo mask per photo, a surface patch or pin on the model where the kit placed one; severity is the worst sighting.'
      : '- Issues: one per kit finding (F codes) with its box, the photo mask and the surface patch on the model.',
    '- Uncertain issues (U codes): one per photo the kit marked uncertain only, severity `uncertain`, with the uncertain-area mask (or the whole photo when the kit has none); no model position.',
    '- Report PDF and findings CSV under `report/`; `legacy/` holds the original offline viewer as hard links to the source files.',
  ]);
  w.write('IMPORT-REPORT.md', rep.toMarkdown(opts.out));

  return {
    manifestPath: w.abs('manifest.json'),
    layers: valid.manifest.layers.length,
    issues: valid.issues.length,
    photos: present.length,
    written: w.stats.written,
    skipped: w.stats.skipped,
    warnings: rep.warnings,
  };
}
