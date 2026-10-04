import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Layer, PhotoRef, ProjectManifestInput, Vec3 } from '@aio/schema';
import { convertKitCloud, decodeKitCloud } from './cloud';
import {
  AioFlight,
  KitFlight,
  aimErrorDeg,
  clipOffsetMs,
  convertKitFlight,
  logSampleTime,
  poseAt,
} from './flight';
import { KIT_FRAME, mapPoint, meshTransform } from './frames';
import {
  HCL_CATALOGUE,
  HCL_SEVERITY_MODEL,
  KitFinding,
  KitFlightEntry,
  TankMeta,
  buildHclIssue,
  photoIdOf,
  tankTags,
} from './hcl-model';
import { imageSize } from './image';
import { extractWindowJson, parseKitDataJs } from './kitdata';
import { roundVec } from './math';
import { CHROMIUM_CODECS, extractFrame, probeVideo, resizeImage, transcodeH264 } from './media';
import { mergeImportedIssues, readSavedIssues } from './keep';
import { ISSUES_SCHEMA, validatePackage } from './package';
import { ImportReport, formatBytes } from './report';
import { PackageWriter } from './writer';

export interface ImportOptions {
  /** Source folder (read only). */
  src: string;
  /** Project package folder to create or update. */
  out: string;
  log?: (msg: string) => void;
}

export interface ImportResult {
  manifestPath: string;
  layers: number;
  issues: number;
  written: number;
  skipped: number;
  warnings: string[];
}

/**
 * Site position. The HCl package has no geographic position (indoor Elios 3 flights, model in
 * plant axes). The origin is an approximate KOC Ahmadi position in UTM 39N and is flagged in
 * the import report.
 */
const HCL_ORIGIN: Vec3 = [216108, 3220019, 0];

/** Nominal flight start: 22 Nov 2023 08:00 Kuwait time, one flight every 15 minutes. */
const HCL_DAY_START_UTC = Date.UTC(2023, 10, 22, 5, 0, 0);

const THUMB_PX = 480;
const REVIEW_PX = 2560;

export async function importHcl(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log ?? (() => undefined);
  const src = (...p: string[]) => join(opts.src, ...p);
  const w = new PackageWriter(opts.out);
  const rep = new ImportReport('HCl Tank 710-D-130335: import report');

  const htmlName = readdirSync(opts.src).find((f) => / - 3D Report\.html$/i.test(f));
  if (!htmlName) throw new Error(`No "... - 3D Report.html" in ${opts.src}`);
  const html = readFileSync(src(htmlName), 'utf8');
  const flights = z.array(KitFlightEntry).parse(extractWindowJson(html, 'TANK_FLIGHTS'));
  const findings = z.array(KitFinding).parse(extractWindowJson(html, 'TANK_FINDINGS'));
  const meta = TankMeta.parse(extractWindowJson(html, 'TANK_META'));
  const files = z
    .object({ pdf: z.object({ url: z.string() }), csv: z.object({ url: z.string() }) })
    .parse(extractWindowJson(html, 'TANK_FILES'));

  const layers: Layer[] = [];

  // Model -------------------------------------------------------------------------------------
  const glbName = readdirSync(src('app')).find((f) => f.toLowerCase().endsWith('.glb'));
  if (!glbName) throw new Error('No GLB in app/');
  await w.copy(src('app', glbName), `models/${glbName}`);
  const tags = tankTags(meta);
  layers.push({
    kind: 'mesh',
    id: 'tank',
    name: 'Tank 710-D-130335 (as built)',
    visible: true,
    src: { path: `models/${glbName}` },
    transform: meshTransform(KIT_FRAME),
    tags,
  });
  rep.count('Mesh layers');
  rep.count('Mesh tags (components)', tags.length);
  log(`model ${glbName}`);

  // Flights, clips, clouds ----------------------------------------------------------------------
  const flightDocs = new Map<string, { doc: AioFlight; t0: number; startUtcMs: number }>();
  const aimErrors: number[] = [];
  const videoLayers: Layer[] = [];
  const cloudLayers: Layer[] = [];
  let poiCount = 0;
  let onTank = 0;
  const kitFlights = new Map<string, KitFlight>();
  for (const [i, fe] of flights.entries()) {
    const jsName = fe.data.replace(/\.json$/, '.js');
    const kf = KitFlight.parse(parseKitDataJs(readFileSync(src('data', jsName), 'utf8')).value);
    kitFlights.set(fe.id, kf);
    const firstClip = kf.segments[0];
    if (!firstClip) throw new Error(`Flight ${fe.id} has no video segments`);
    const info = await probeVideo(src('video', firstClip));
    const startUtcMs = HCL_DAY_START_UTC + i * 15 * 60_000;
    const { doc, t0 } = convertKitFlight(kf, KIT_FRAME, startUtcMs, info.width / info.height);
    doc.name = `Flight ${fe.id} · ${fe.name}`;
    flightDocs.set(fe.id, { doc, t0, startUtcMs });
    const flightRel = `flights/f${fe.id}.json`;
    w.writeJson(flightRel, AioFlight.parse(doc), false);
    rep.count('Flights (aio.flight/1)');
    rep.count('Pose samples', doc.samples.length);

    // Verification: the camera at each logged POI must look at the POI target on the tank.
    for (const p of kf.pois) {
      poiCount++;
      const tLog = logSampleTime(kf.t, p.t);
      const target = mapPoint(KIT_FRAME, p.target);
      aimErrors.push(aimErrorDeg(doc, (tLog - t0) * 1000, target));
      // On the tank: within the shell radius (2.0 m + plate) and between bottom and roof crown.
      if (Math.hypot(target[0], target[2]) <= 2.05 && target[1] >= -0.05 && target[1] <= 9.3) {
        onTank++;
      }
    }

    for (const [k, seg] of kf.segments.entries()) {
      const clipSrc = src('video', seg);
      const clipInfo = k === 0 ? info : await probeVideo(clipSrc);
      let rel = `video/${seg}`;
      if (CHROMIUM_CODECS.has(clipInfo.codec)) {
        await w.copy(clipSrc, rel);
      } else {
        rel = `video/${basename(seg, '.mp4')}.h264.mp4`;
        await w.derive(rel, [clipSrc], (out) => transcodeH264(clipSrc, out));
        rep.warn(`${seg}: codec ${clipInfo.codec} transcoded to H.264`);
      }
      const posterRel = `posters/${basename(seg, '.mp4')}.jpg`;
      await w.derive(posterRel, [clipSrc], (out) =>
        extractFrame(clipSrc, Math.min(1, clipInfo.durationS / 2), out),
      );
      videoLayers.push({
        kind: 'video',
        id: `video-${fe.id}-${String(k).padStart(2, '0')}`,
        name: `Flight ${fe.id} · ${fe.name} · clip ${k + 1} of ${kf.segments.length}`,
        visible: true,
        src: { path: rel },
        flight: { src: { path: flightRel }, startUtcMs },
        lens: doc.lens,
        offsetMs: clipOffsetMs(k, kf.segment_s, t0),
        poster: { path: posterRel },
      });
      rep.count('Video clips');
    }

    const cloudJs = src('data', `cloud${fe.id}.js`);
    if (existsSync(cloudJs)) {
      const b64 = z.string().parse(parseKitDataJs(readFileSync(cloudJs, 'utf8')).value);
      const bytes = convertKitCloud(new Uint8Array(Buffer.from(b64, 'base64')), KIT_FRAME);
      const n = decodeKitCloud(bytes).count;
      const rel = `clouds/f${fe.id}.bin`;
      w.write(rel, bytes);
      cloudLayers.push({
        kind: 'pointcloud',
        id: `cloud-${fe.id}`,
        name: `LiDAR flight ${fe.id} · ${fe.name}`,
        visible: true,
        src: { path: rel },
        format: 'kit-packed',
        pointCount: n,
      });
      rep.count('Point cloud layers');
      rep.count('Points', n);
    } else {
      rep.warn(`No point cloud for flight ${fe.id}`);
    }
    log(`flight ${fe.id}: ${doc.samples.length} samples, ${kf.segments.length} clips`);
  }
  layers.push(...cloudLayers, ...videoLayers);

  // Photos ----------------------------------------------------------------------------------------
  const photoItems: PhotoRef[] = [];
  const photoSizes = new Map<string, { width: number; height: number }>();
  /** `snap`: POI photos take the pose of the log sample the kit attached them to. */
  const addPhoto = async (id: string, flightId: string, t: number, cam: Vec3, snap: boolean) => {
    if (photoSizes.has(id)) return;
    const full = src('photos', `${id}.jpg`);
    const thumb = src('thumbs', `${id}.jpg`);
    const best = existsSync(full) ? full : existsSync(thumb) ? thumb : null;
    if (!best) {
      rep.warn(`Photo ${id} listed but not in photos/ or thumbs/`);
      return;
    }
    const size = imageSize(readFileSync(best));
    if (!size) throw new Error(`Cannot read image size of ${best}`);
    const rel = `photos/${id}.jpg`;
    if (Math.max(size.width, size.height) > REVIEW_PX) {
      await w.derive(rel, [best], (out) => resizeImage(best, out, REVIEW_PX));
      const scaleF = REVIEW_PX / Math.max(size.width, size.height);
      size.width = Math.round(size.width * scaleF);
      size.height = Math.round(size.height * scaleF);
    } else {
      await w.copy(best, rel);
    }
    const thumbRel = `photos/thumbs/${id}.jpg`;
    if (existsSync(thumb)) await w.copy(thumb, thumbRel);
    else await w.derive(thumbRel, [best], (out) => resizeImage(best, out, THUMB_PX, 4));
    photoSizes.set(id, size);
    if (best === thumb) rep.count('Photos only available as 480 px thumbnails');
    const fd = flightDocs.get(flightId);
    const item: PhotoRef = { id, src: { path: rel }, pos: roundVec(mapPoint(KIT_FRAME, cam), 4) };
    if (fd) {
      const kf = kitFlights.get(flightId);
      const tPose = snap && kf ? logSampleTime(kf.t, t) : t;
      item.q = roundVec(poseAt(fd.doc, (tPose - fd.t0) * 1000).q, 6);
      item.takenAt = new Date(fd.startUtcMs + Math.round((t - fd.t0) * 1000)).toISOString();
    }
    photoItems.push(item);
  };
  for (const [fid, kf] of kitFlights) {
    for (const p of kf.pois) {
      if (!p.image) continue;
      await addPhoto(photoIdOf(p.image), fid, p.t, p.cam, true);
    }
  }
  // Video frames used as finding evidence (not POI photos).
  let frameCount = 0;
  for (const f of findings) {
    for (const ph of f.photos) {
      if (!ph.image.startsWith('frame:')) continue;
      await addPhoto(photoIdOf(ph.image), ph.flight, ph.t, ph.cam, false);
      frameCount++;
    }
  }
  layers.push({
    kind: 'photos',
    id: 'photos',
    name: 'Inspection photos (Elios 3 POIs and video frames)',
    visible: true,
    items: photoItems,
  });
  rep.count('Photos', photoItems.length);
  log(`photos ${photoItems.length}`);

  // Issues ------------------------------------------------------------------------------------------
  const issues = findings.map((f) =>
    buildHclIssue(f, {
      meshLayer: 'tank',
      photosLayer: 'photos',
      photoSize: (id) => photoSizes.get(id) ?? null,
      createdAt: '2023-11-22T12:00:00Z',
    }),
  );
  rep.count('Issues', issues.length);
  rep.count(
    'Issue sightings (mesh + image)',
    issues.reduce((a, i) => a + i.sightings.length, 0),
  );

  // Report files and thumbnail ---------------------------------------------------------------------
  await w.copy(src(files.pdf.url), `report/${basename(files.pdf.url)}`);
  await w.copy(src(files.csv.url), `report/${basename(files.csv.url)}`);
  const thumbClip = src('video', 'v108_02.mp4');
  if (existsSync(thumbClip)) {
    await w.derive('thumbnail.jpg', [thumbClip], (out) => extractFrame(thumbClip, 20, out, 960));
  }

  // Manifest -------------------------------------------------------------------------------------
  const manifestInput: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: 'hcl',
    name: 'HCl Tank 710-D-130335',
    customer: 'KOC',
    site: 'KOC acid storage, Kuwait (position approximate)',
    crs: { epsg: 32639 },
    origin: HCL_ORIGIN,
    captures: [
      { id: 'elios-2023-11-22', label: 'Elios 3 internal inspection', date: '2023-11-22' },
    ],
    layers,
    severityModels: [HCL_SEVERITY_MODEL],
    classCatalogues: [HCL_CATALOGUE],
  };
  // A re-run keeps issues people added or edited in the app (merged by id).
  const merged = mergeImportedIssues(readSavedIssues(opts.out), issues);
  const kept = merged.filter((i) => !issues.includes(i)).length;
  if (kept) rep.count('Issues kept from the app (added or edited there)', kept);
  const valid = validatePackage(manifestInput, merged);
  w.writeJson('manifest.json', valid.manifest);
  w.writeJson('issues.json', { schema: ISSUES_SCHEMA, issues: valid.issues });

  // Verification and report ----------------------------------------------------------------------------
  aimErrors.sort((a, b) => a - b);
  const pct = (q: number) =>
    aimErrors[Math.min(aimErrors.length - 1, Math.floor(q * aimErrors.length))] ?? NaN;
  const f01 = findings.find((f) => f.id === 'F01')?.photos[0];
  let f01Err = NaN;
  if (f01) {
    const fd = flightDocs.get(f01.flight);
    const kf = kitFlights.get(f01.flight);
    if (fd && kf) {
      const tLog = logSampleTime(kf.t, f01.t);
      f01Err = aimErrorDeg(fd.doc, (tLog - fd.t0) * 1000, mapPoint(KIT_FRAME, f01.target));
    }
  }
  rep.section('Frame and camera check', [
    'Kit tank frame (X plant north, Y up, Z plant east) is mapped to the local frame (X east, Y up, Z south) by a +90 deg turn about Y: `x = z_kit, y = y_kit, z = -x_kit`. The GLB is copied unchanged and the turn is baked into the mesh layer `transform`.',
    'Camera quaternions are left-multiplied by the same turn, so each camera still looks down its own -Z.',
    '',
    `Check: for all ${poiCount} logged POIs, the angle between the converted camera view direction (local -Z of the converted quaternion) at the log sample the kit attached the POI to and the direction from the camera to the converted POI target: median ${pct(0.5).toFixed(2)} deg, 95th percentile ${pct(0.95).toFixed(2)} deg, max ${pct(1).toFixed(2)} deg. ${onTank} of ${poiCount} targets lie on the tank (shell radius 2.0 m, bottom to roof crown).`,
    `F01 (crack in the bottom plate, photo 109_0256, flight 109 at ${f01?.t ?? '?'} s): camera aim error ${f01Err.toFixed(2)} deg.`,
  ]);
  rep.section('What was converted', [
    `- Model: \`models/${glbName}\` (GLB as delivered, ${formatBytes(readFileSync(src('app', glbName)).length)}), tags from the kit model metadata.`,
    `- Flights: ${flights.length} kit flight logs to \`flights/fNNN.json\` (aio.flight/1, f-theta 114 deg). Sample time 0 is the first log sample (about 15.6 s before the video starts); each 60 s clip is its own video layer with \`offsetMs = k * 60000 - t0\`.`,
    '- Video: MP4 clips copied as is (H.264 High, 960x540, 25 fps, plays in Chromium); a JPEG poster per clip at 1 s.',
    '- Point clouds: per-flight Elios 3 LiDAR (base64 in `data/cloudNNN.js`) rotated into the local frame, `kit-packed` layout: N x int16 xyz (mm, LE) then N x uint8 intensity.',
    '- Photos: every POI photo with an image (full 1280x960 copy where the package has one, else the 480x360 POI thumbnail) plus the 4 video frames used as finding evidence; pose = camera position and quaternion of the flight log at the POI time.',
    '- Issues: F01 to F11 from the 3D report findings register, severity model "HCl lining" (1 to 5), a mesh sighting at each photo target and an image sighting at the centre of each finding photo.',
    `- Report: \`report/${basename(files.pdf.url)}\` and the findings CSV.`,
  ]);
  rep.warn(
    'Geographic position: the source has none. Origin is an approximate KOC Ahmadi position (UTM 39N 216108 E, 3220019 N) and plant north is taken as grid north; the drawing gives true north 23 deg off plant north without a sign.',
  );
  rep.warn(
    'Flight start times are nominal (22 Nov 2023 08:00 Kuwait time plus 15 min per flight); the delivered package has no absolute log time. Relative timing between pose, video and photos is exact.',
  );
  rep.note(
    `${poiCount} POIs logged; ${photoItems.length - frameCount} have photos. POIs without an image are not imported as photos.`,
  );
  rep.note(
    'No legacy viewer layer: the kit 3D report HTML is not copied (all its data is converted).',
  );
  w.write('IMPORT-REPORT.md', rep.toMarkdown(opts.out));

  return {
    manifestPath: w.abs('manifest.json'),
    layers: valid.manifest.layers.length,
    issues: valid.issues.length,
    written: w.stats.written,
    skipped: w.stats.skipped,
    warnings: rep.warnings,
  };
}
