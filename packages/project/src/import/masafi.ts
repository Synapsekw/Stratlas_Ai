import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { Layer, ProjectManifestInput, Vec3 } from '@aio/schema';
import { encodeGlb, type GlbMesh, type GlbNode } from './glb';
import type { ImportOptions, ImportResult } from './hcl';
import { imageSize } from './image';
import {
  STOCKPILE_CATALOGUE,
  STOCKPILE_SEVERITY_MODEL,
  formatM3,
  orthoPyramidPlan,
  pileNode,
  pileTags,
  volumeCheck,
  type VolumePair,
} from './masafi-model';
import { round } from './math';
import { resizeImage } from './media';
import { ISSUES_SCHEMA, validatePackage } from './package';
import { composeImage, readRgba } from './rasterops';
import { ImportReport, formatBytes } from './report';
import {
  blockMean,
  buildTerrain,
  readNpyF32,
  sampleHeight,
  type HeightGrid,
  type TerrainPart,
} from './terrain';
import {
  VOLUME_BASES,
  VsSite,
  decodeBits,
  decodeDeltaI16,
  decodePileScript,
  parseVsDataJs,
  pileChange,
  pileVolume,
  type VsPileGrids,
} from './vsdata';
import { PackageWriter } from './writer';

export interface MasafiImportOptions extends ImportOptions {
  /** Terrain lattice spacing (m); piles are meshed at it, the ground at twice it. Default 0.5. */
  latticeM?: number;
  /** Ground within this distance (m) of a pile zone is meshed with the pile. Default 1.5. */
  regionBufferM?: number;
}

const Job = z.object({
  grid: z.object({
    x0: z.number(),
    y0: z.number(),
    x1: z.number(),
    y1: z.number(),
    dsm_res: z.number(),
    ortho_res: z.number(),
    tile: z.number().int(),
    zmax: z.number().int(),
  }),
});

/** Colour under the ortho's no-data pixels (the 3D raster adapter draws tiles opaque): the stage
 * background, so the pyramid's padding fades into it around the survey. */
const ORTHO_NODATA_RGB = '#141b24';
/** Toe line (pile outline) colour, linear RGB of #ffc400, drawn this far above the surface. */
const TOE_COLOR: [number, number, number, number] = [1, 0.552, 0, 1];
const TOE_LIFT_M = 0.15;
/** Coarsest ortho level kept: the finest level and three below it. */
const ORTHO_LEVELS = 4;
const VOLUME_TOLERANCE = 0.005;

type En = readonly [number, number];

export async function importMasafi(opts: MasafiImportOptions): Promise<ImportResult> {
  const log = opts.log ?? (() => undefined);
  const src = (...p: string[]) => join(opts.src, ...p);
  const w = new PackageWriter(opts.out);
  const lattM = opts.latticeM ?? 0.5;
  const buffer = opts.regionBufferM ?? 1.5;

  const job = Job.parse(JSON.parse(readFileSync(src('job.json'), 'utf8')));
  const G = job.grid;
  const site = VsSite.parse(
    parseVsDataJs(readFileSync(src('data/site.js'), 'utf8'), 'VS_SITE').value,
  );
  const EPS = site.meta.epoch_order;
  const epochOf = (e: string) => {
    const ep = site.epochs[e];
    if (!ep) throw new Error(`site.js has no epoch ${e}`);
    return ep;
  };
  const rep = new ImportReport(`${site.meta.title}: import report`);
  const epsg = Number(/EPSG:(\d+)/.exec(site.meta.crs)?.[1]);
  if (!Number.isFinite(epsg)) throw new Error(`Unsupported CRS ${site.meta.crs}`);

  // Height lattices -------------------------------------------------------------------------------
  const lattices = new Map<string, HeightGrid>();
  const dsmSource = new Map<string, string>();
  for (const e of EPS) {
    const npy = src('work', `dsm_${e}.npy`);
    if (existsSync(npy)) {
      const a = readNpyF32(new Uint8Array(readFileSync(npy)));
      const g: HeightGrid = { w: a.w, h: a.h, res: G.dsm_res, x0: G.x0, y1: G.y1, z: a.data };
      const f = Math.max(1, Math.round(lattM / G.dsm_res));
      lattices.set(e, blockMean(g, f, 0.5));
      dsmSource.set(
        e,
        `\`work/dsm_${e}.npy\` (${a.w} x ${a.h} at ${G.dsm_res} m), block mean ${f} x ${f}`,
      );
    } else {
      const d = decodeDsmScript(readFileSync(src('data', `dsm_${e}.js`), 'utf8'));
      lattices.set(e, d);
      dsmSource.set(e, `\`data/dsm_${e}.js\` (${d.w} x ${d.h} at ${d.res} m; no work/ grid)`);
      rep.warn(`No work/dsm_${e}.npy: terrain built from the viewer's ${d.res} m DSM.`);
    }
  }
  let minH = Infinity;
  for (const g of lattices.values()) for (const v of g.z) if (v === v && v < minH) minH = v;
  const origin: Vec3 = [(G.x0 + G.x1) / 2, (G.y0 + G.y1) / 2, Math.floor(minH)];
  const [E0, N0, H0] = origin;
  const local = (e: number, n: number, h: number): Vec3 => [
    round(e - E0, 3),
    round(h - H0, 3),
    round(-(n - N0), 3),
  ];
  const ringLocal = (ring: readonly En[]) =>
    ring.map(([e, n]) => [round(e - E0, 3), round(-(n - N0), 3)]);

  // Piles and volumes -----------------------------------------------------------------------------
  const grids = new Map<string, VsPileGrids & { x0: number; y1: number }>();
  for (const p of site.piles) {
    grids.set(p.id, decodePileScript(readFileSync(src('data/piles', `${p.id}.js`), 'utf8')));
  }
  const pairs: VolumePair[] = [];
  const changePairs: VolumePair[] = [];
  const db = site.volume.deadband_m;
  const pileDocs = site.piles.map((p) => {
    const g = grids.get(p.id);
    if (!g) throw new Error(`No grid for ${p.id}`);
    const epochs: Record<string, unknown> = {};
    for (const e of EPS) {
      const kit = p.epochs[e];
      if (!kit) continue;
      const volumes: Record<string, { fill: number; cut: number; net: number }> = {};
      let top = NaN;
      let height = NaN;
      let area = NaN;
      for (const b of VOLUME_BASES) {
        const v = pileVolume(g, e, b.id);
        if (!v) throw new Error(`${p.id} ${e}: kit lists the pile but its grid has no mask`);
        volumes[b.id] = { fill: round(v.fill, 1), cut: round(v.cut, 1), net: round(v.net, 1) };
        pairs.push({ pile: p.id, epoch: e, base: b.id, computed: v.net, kit: kit.vol[b.id].net });
        pairs.push({
          pile: p.id,
          epoch: e,
          base: `${b.id} fill`,
          computed: v.fill,
          kit: kit.vol[b.id].fill,
        });
        top = v.topM;
        area = v.areaM2;
        if (b.id === 'tin') height = v.heightM;
      }
      epochs[e] = {
        captureId: captureId(epochOf(e).date),
        areaM2: round(area, 1),
        topM: round(top, 2),
        heightM: round(height, 2),
        kitHeightM: kit.height_m,
        surveyErrM3: kit.survey_err_m3 ?? null,
        groundToeFrac: kit.ground_toe_frac ?? null,
        node: pileNode(p.id, e),
        ring: ringLocal(kit.ring),
        volumes,
      };
    }
    let change: { fill: number; cut: number; net: number } | null = null;
    const [e1, e2] = [EPS[0], EPS[EPS.length - 1]];
    if (e1 && e2 && e1 !== e2) {
      const c = pileChange(g, e1, e2, db);
      change = { fill: round(c.fill, 1), cut: round(c.cut, 1), net: round(c.net, 1) };
      if (p.change)
        changePairs.push({
          pile: p.id,
          epoch: `${e1}>${e2}`,
          base: 'net',
          computed: c.net,
          kit: p.change.net,
        });
    }
    const centre = ringCentroid(p.zone_ring);
    return {
      id: p.id,
      name: p.name,
      material: p.material ?? null,
      status: p.status ?? null,
      centreEN: [round(centre[0], 2), round(centre[1], 2)],
      zoneRing: ringLocal(p.zone_ring),
      epochs,
      change,
    };
  });
  const vCheck = volumeCheck(pairs);
  const cCheck = volumeCheck(changePairs);
  if (!vCheck.within(VOLUME_TOLERANCE)) {
    const wst = vCheck.worst;
    throw new Error(
      `Recomputed volumes differ from the kit by ${(vCheck.maxRel * 100).toFixed(2)} % (${wst?.pile} ${wst?.epoch} ${wst?.base})`,
    );
  }
  rep.count('Piles', site.piles.length);
  rep.count('Pile volumes (pile x date x base)', pairs.length / 2);

  // Terrain meshes --------------------------------------------------------------------------------
  const layers: Layer[] = [];
  const meshLayers: Layer[] = [];
  const terrainLines: string[] = [];
  const verticalLines: string[] = [];
  const latest = EPS[EPS.length - 1];
  for (const e of [...EPS].reverse()) {
    const lat = lattices.get(e);
    if (!lat) continue;
    const ep = epochOf(e);
    const tex = dataUriBytes(
      z
        .string()
        .parse(parseVsDataJs(readFileSync(src('data', `tex_${e}.js`), 'utf8'), 'VS_TEX').value),
    );
    const texSize = imageSize(tex);
    const present = site.piles.filter((p) => p.epochs[e]);
    const t = buildTerrain(lat, {
      origin,
      regions: present.map((p) => ({ name: pileNode(p.id, e), ring: p.zone_ring })),
      regionBuffer: buffer,
      uvWindow: { x0: G.x0, y0: G.y0, x1: G.x1, y1: G.y1 },
    });
    const glb = terrainGlb(e, t, tex, (pile) => {
      const ring = site.piles.find((p) => pileNode(p.id, e) === pile)?.epochs[e]?.ring;
      return ring ? toeLine(ring, lat, local) : null;
    });
    const rel = `models/terrain-${ep.date}.glb`;
    w.write(rel, glb);
    const tags = pileTags(
      present.map((p) => ({ id: p.id, net: p.epochs[e]?.vol.tin.net ?? 0 })),
      e,
    );
    meshLayers.push({
      kind: 'mesh',
      id: `terrain-${ep.date}`,
      name: `Terrain ${ep.label}`,
      visible: e === latest,
      src: { path: rel },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      tags,
    });
    const tris = (p: TerrainPart) => p.indices.length / 3;
    const pileTris = t.regions.reduce((a, p) => a + tris(p), 0);
    rep.count('Terrain meshes', 1);
    rep.count('Mesh tags (piles)', tags.length);
    terrainLines.push(
      `- ${ep.label}: \`${rel}\` (${formatBytes(glb.byteLength)}), from ${dsmSource.get(e) ?? '?'}: ground ${tris(t.ground).toLocaleString('en-US')} triangles at ${2 * lat.res} m, ${t.regions.length} pile nodes ${pileTris.toLocaleString('en-US')} triangles at ${lat.res} m; texture \`data/tex_${e}.js\` ${texSize ? `${texSize.width} x ${texSize.height} px (${(((G.x1 - G.x0) / texSize.width) * 100).toFixed(1)} x ${(((G.y1 - G.y0) / texSize.height) * 100).toFixed(1)} cm per px)` : '(size unknown)'} spanning the job grid.`,
    );

    // vertical check: lattice against the kit's 10 cm pile surfaces and the kit pile tops
    const diffs: number[] = [];
    const topDiffs: number[] = [];
    for (const p of present) {
      const g = grids.get(p.id);
      const o = g?.ep[e];
      if (!g || !o) continue;
      for (let j = 0; j < g.h; j += 3) {
        for (let i = 0; i < g.w; i += 3) {
          const k = j * g.w + i;
          if (!g.zone[k]) continue;
          const h = sampleHeight(lat, g.x0 + (i + 0.5) * g.res, g.y1 - (j + 0.5) * g.res);
          if (h !== null) diffs.push(h - ((o.z[k] ?? 0) / 100 + g.zoff));
        }
      }
      const part = t.regions.find((r) => r.name === pileNode(p.id, e));
      const kitTop = p.epochs[e]?.top_m;
      if (part && kitTop !== undefined) {
        let top = -Infinity;
        for (let k = 1; k < part.positions.length; k += 3)
          top = Math.max(top, part.positions[k] ?? -Infinity);
        topDiffs.push(top + H0 - kitTop);
      }
    }
    const absD = diffs.map(Math.abs).sort((a, b) => a - b);
    const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
    topDiffs.sort((a, b) => a - b);
    verticalLines.push(
      `- ${ep.label}: terrain lattice against the kit's 10 cm pile surfaces (\`data/piles\`, every 3rd cell in the pile zones, ${diffs.length.toLocaleString('en-US')} samples): mean ${fmtM(mean)}, median |d| ${pct(absD, 0.5).toFixed(3)} m, 95th percentile |d| ${pct(absD, 0.95).toFixed(3)} m. Mesh pile top minus kit pile top (\`site.js\` \`top_m\`, the highest 10 cm cell): ${fmtM(topDiffs[0] ?? NaN)} to ${fmtM(topDiffs[topDiffs.length - 1] ?? NaN)}, median ${fmtM(pct(topDiffs, 0.5))} (the mesh averages ${lat.res} m cells, so it sits slightly below the sharpest crest).`,
    );
    log(`terrain ${e}: ${tris(t.ground) + pileTris} triangles, ${formatBytes(glb.byteLength)}`);
  }
  layers.push(...meshLayers);

  // Orthomosaic pyramids -----------------------------------------------------------------------------
  const orthoY = round(minH - H0 - 0.3, 2);
  const tileGround = G.tile * G.ortho_res;
  const horizontalLines: string[] = [];
  let blankTiles = 0;
  for (const e of [...EPS].reverse()) {
    const ep = epochOf(e);
    const tdir = src('tiles', e);
    if (!existsSync(tdir)) {
      rep.warn(`No ortho tiles for ${ep.label}`);
      continue;
    }
    const source: { z: number; x: number; y: number }[] = [];
    for (const zd of readdirSync(tdir)) {
      if (!/^\d+$/.test(zd)) continue;
      for (const f of readdirSync(join(tdir, zd))) {
        const m = /^(\d+)_(\d+)\.webp$/.exec(f);
        if (m) source.push({ z: Number(zd), x: Number(m[1]), y: Number(m[2]) });
      }
    }
    const zTop = Math.max(...source.map((t) => t.z));
    const zMin = Math.max(Math.min(...source.map((t) => t.z)), zTop - (ORTHO_LEVELS - 1));
    const plan = orthoPyramidPlan(
      source.filter((t) => t.z >= zMin),
      zMin,
    );
    const pattern = `rasters/ortho-${e}/{z}/{x}_{y}.webp`;
    const tileRel = (zz: number, x: number, y: number) =>
      pattern.replace('{z}', String(zz)).replace('{x}', String(x)).replace('{y}', String(y));
    for (const t of plan.tiles) {
      const rel = tileRel(t.z, t.x, t.y);
      if (t.present) {
        const file = join(tdir, String(t.z), `${t.x}_${t.y}.webp`);
        const s = imageSize(new Uint8Array(readFileSync(file))) ?? {
          width: G.tile,
          height: G.tile,
        };
        await w.derive(rel, [file], (out) =>
          composeImage({
            width: G.tile,
            height: G.tile,
            transparentRgb: ORTHO_NODATA_RGB,
            layers: [{ file, x: 0, y: 0, w: s.width, h: s.height }],
            out,
            quality: 82,
          }),
        );
        rep.count('Ortho tiles');
      } else {
        blankTiles++;
        await w.derive(rel, [], (out) =>
          composeImage({
            width: 64,
            height: 64,
            layers: [],
            out,
            transparentRgb: ORTHO_NODATA_RGB,
          }),
        );
      }
    }
    const finest = plan.levels[plan.levels.length - 1];
    if (!finest) throw new Error('Empty ortho pyramid');
    const spanE = finest.cols * tileGround;
    const spanN = finest.rows * tileGround;
    const corners = {
      tl: local(G.x0, G.y1, orthoY + H0),
      tr: local(G.x0 + spanE, G.y1, orthoY + H0),
      bl: local(G.x0, G.y1 - spanN, orthoY + H0),
    };
    const tilesRel = `rasters/ortho-${e}/tiles.json`;
    w.writeJson(tilesRel, {
      schema: 'aio.tiles/1',
      levels: plan.levels.map((l) => ({
        z: l.z,
        tileSize: G.tile,
        cols: l.cols,
        rows: l.rows,
        pattern,
      })),
      corners,
    });
    layers.push({
      kind: 'raster',
      id: `ortho-${ep.date}`,
      name: `Ortho ${ep.label}`,
      visible: e === latest,
      src: { path: tilesRel },
      role: 'ortho',
      format: 'kit-pyramid',
      corners,
    });
    const coarse = plan.levels[0];
    const lat = lattices.get(e);
    if (coarse && lat) {
      const a = await orthoAlignment(
        lat,
        plan.tiles
          .filter((t) => t.z === coarse.z && t.present)
          .map((t) => ({ file: join(tdir, String(t.z), `${t.x}_${t.y}.webp`), x: t.x, y: t.y })),
        { x0: G.x0, y1: G.y1, px: G.tile, res: G.ortho_res * 2 ** (finest.z - coarse.z) },
      );
      horizontalLines.push(
        `- ${ep.label}: ortho coverage (alpha of level ${coarse.z}, ${(a.res * 100).toFixed(0)} cm per px) against DSM coverage: overlap ${(a.iou * 100).toFixed(1)} % (intersection over union) with no shift; best of shifts up to ${a.maxShift} px is ${a.best.dx}, ${a.best.dy} px (${(a.bestIou * 100).toFixed(1)} %).`,
      );
      if (a.best.dx !== 0 || a.best.dy !== 0)
        rep.warn(
          `${ep.label}: ortho and DSM coverage line up best with a shift of ${a.best.dx}, ${a.best.dy} px`,
        );
    }
    log(`ortho ${e}: ${plan.tiles.length} tiles in ${plan.levels.length} levels`);
  }
  if (blankTiles) rep.count('Ortho padding tiles (no data)', blankTiles);

  // Legacy viewer, report, register, thumbnail ---------------------------------------------------------
  const top = readdirSync(opts.src);
  const html = top.find((f) => /Stockpile Review\.html$/i.test(f));
  const pdf = top.find((f) => f.toLowerCase().endsWith('.pdf'));
  const csv = top.find((f) => /register\.csv$/i.test(f));
  if (html) {
    const files = [html, ...(pdf ? [pdf] : []), ...(csv ? [csv] : [])];
    for (const d of ['data', 'lib', 'overlays']) files.push(...walk(opts.src, d));
    for (const f of files) await w.copy(src(f), `legacy/${f}`);
    rep.count('Legacy viewer files', files.length);
    layers.push({
      kind: 'legacy',
      id: 'volumetric-review',
      name: 'Stockpile review (offline viewer)',
      visible: true,
      viewer: 'volumetric',
      entry: { path: `legacy/${html}` },
    });
  } else rep.warn('No "... Stockpile Review.html" offline viewer in the source: no legacy layer.');
  if (pdf) await w.copy(src(pdf), `report/${pdf}`);
  else rep.warn('No PDF report in the source.');
  if (csv) await w.copy(src(csv), `report/${csv}`);
  else rep.warn('No stockpile register CSV in the source.');
  const thumbSrc = latest ? src('overlays', `site_${latest}.jpg`) : '';
  if (thumbSrc && existsSync(thumbSrc))
    await w.derive('thumbnail.jpg', [thumbSrc], (out) => resizeImage(thumbSrc, out, 960));

  // Volumes document ---------------------------------------------------------------------------------
  w.writeJson('volumes.json', {
    schema: 'aio.volumes/1',
    source: 'Volumetric Survey Kit (data/site.js, data/piles/*.js), recomputed at import',
    units: { volume: 'm3', area: 'm2', length: 'm' },
    frame:
      'rings are [x, z] in the project local frame (x east, z south); centreEN in the project CRS',
    densityTPerM3: site.volume.density_t_m3,
    swell: site.volume.swell ?? 1,
    deadbandM: db,
    defaultBase: site.volume.default_base,
    bases: VOLUME_BASES,
    captures: EPS.map((e) => ({
      epoch: e,
      captureId: captureId(epochOf(e).date),
      date: epochOf(e).date,
      label: epochOf(e).label,
      layers: layers
        .filter((l) => l.id === `terrain-${epochOf(e).date}` || l.id === `ortho-${epochOf(e).date}`)
        .map((l) => l.id),
    })),
    // the kit's own 10 cm pile grids, 0.4 m DSMs and pile masks, copied unchanged with the viewer:
    // the volumetric workspace recomputes and edits volumes on them (data-conventions section 10)
    ...(html
      ? {
          grids: {
            format: 'vs-kit-js',
            piles: 'legacy/data/piles/{id}.js',
            dsm: 'legacy/data/dsm_{epoch}.js',
            coarse: 'legacy/data/vol.js',
          },
        }
      : {}),
    piles: pileDocs,
    totals: site.totals,
    pileChange: site.pile_change,
    siteChange: site.site_change,
    aoi: site.aoi ? ringLocal(site.aoi) : null,
    excluded: (site.excluded ?? []).map((x) => ({ reason: x.reason, ring: ringLocal(x.ring) })),
    check: {
      against: 'site.js precomputed pile volumes (net and fill, every pile, date and base)',
      maxRelDiff: round(vCheck.maxRel, 6),
      worst: vCheck.worst,
      changeMaxRelDiff: round(cCheck.maxRel, 6),
      tolerance: VOLUME_TOLERANCE,
    },
  });

  // Manifest -------------------------------------------------------------------------------------------
  const manifestInput: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: 'masafi',
    name: 'Masafi stockpiles',
    customer: site.meta.customer,
    site: site.meta.site,
    crs: { epsg },
    origin,
    captures: EPS.map((e) => ({
      id: captureId(epochOf(e).date),
      label: `Drone survey ${epochOf(e).label}`,
      date: epochOf(e).date,
    })),
    layers,
    severityModels: [STOCKPILE_SEVERITY_MODEL],
    classCatalogues: [STOCKPILE_CATALOGUE],
  };
  const valid = validatePackage(manifestInput, []);
  w.writeJson('manifest.json', valid.manifest);
  w.writeJson('issues.json', { schema: ISSUES_SCHEMA, issues: valid.issues });

  // Report -----------------------------------------------------------------------------------------------
  const wst = vCheck.worst;
  rep.section('Frame', [
    `Project CRS EPSG:${epsg}; origin E ${E0}, N ${N0} (centre of the kit's job grid), H ${H0} (the lowest DSM height, floored), so the yard floor sits just above local y = 0. Local \`x = E - ${E0}\`, \`y = H - ${H0}\`, \`z = -(N - ${N0})\`. The terrain GLBs are written in the local frame (identity transform).`,
    `DSM, texture, ortho tiles and pile grids all hang off the job grid's top-left corner (E ${G.x0}, N ${G.y1}), as in the kit.`,
  ]);
  rep.section('What was converted', [
    ...terrainLines,
    `- Pile nodes: one GLB node per pile and date (\`Pxx_<epoch>\`), the terrain cells within ${buffer} m of the pile's zone (the kit's envelope of both dates) meshed at the finer spacing, plus the kit's toe line for that date as a line primitive ${TOE_LIFT_M} m above the surface. Mesh tags name the node with the pile ID and the default-base (triangulated toe) volume, so every pile shows as a callout. The ground node carries \`extras.type = "terrain"\` (not selectable).`,
    `- Orthomosaic: \`kit-pyramid\` per date (\`rasters/ortho-<epoch>/tiles.json\`) from the kit's \`tiles/<epoch>/<z>\` WebP tiles, the finest ${ORTHO_LEVELS} levels (${(G.ortho_res * 100).toFixed(0)} cm per px at the finest), every level spanning the same whole-tile window from the grid corner. Tiles re-encoded (WebP 82) with the no-data colour ${ORTHO_NODATA_RGB} under alpha 0; tiles the kit does not have (outside the survey) are 64 px no-data tiles. Drawn at local y = ${orthoY} m, under the terrain mesh, so it shows in Map and around the survey in 3D.`,
    '- Volumes: `volumes.json` (`aio.volumes/1`), see below.',
    `- Legacy: the offline viewer \`legacy/${html ?? '?'}\` with its \`data/\`, \`lib/\`, \`overlays/\`, the PDF and the register CSV, as a \`legacy\` layer (\`viewer: "volumetric"\`): piles, four bases, sections, cut and fill, boundary editor. Its PDF page viewer loads pdf.js from cdnjs (needs network); everything else is offline. Boundary edits made there live in that page's localStorage.`,
    `- Report: \`report/${pdf ?? '-'}\` and \`report/${csv ?? '-'}\`; thumbnail from \`overlays/site_${latest ?? '?'}.jpg\`.`,
    `- Issues: none. Severity model "Stockpile" (1 Low, 2 Medium, 3 High) and classes Spillage, Unsafe slope, Encroachment are in the manifest for later reviews.`,
  ]);
  rep.section('volumes.json (for a future native volumetric panel)', [
    'Stockpile volumes are not a native layer kind yet, so they are kept beside the manifest:',
    '',
    '- `piles[]`: `id`, `name`, `status`, `centreEN` (project CRS), `zoneRing` (local x, z), `change` (surface to surface between the first and last date inside the zone, deadband applied: fill, cut, net m³) and `epochs.<epoch>`: `captureId`, `node` (GLB node), `ring` (toe line, local x, z), `areaM2`, `topM`, `heightM`, `surveyErrM3`, `volumes.<base>` = `{ fill, cut, net }` m³ for the bases `tin` (triangulated toe, default), `plane` (best-fit toe plane), `avg` (average toe height), `low` (lowest toe point).',
    "- Site level: `totals` and `pileChange` / `siteChange` as the kit computed them, `aoi` (yard polygon) and `excluded` zones with the reviewer's reason, `densityTPerM3` for tonnage.",
    "- Every pile volume is recomputed at import from the kit's 10 cm grids (`data/piles/Pxx.js`: surface, pile mask, base surfaces), with the same maths as the kit viewer, and checked against the kit's precomputed figures.",
  ]);
  rep.section('Checks', [
    `- Volumes: ${pairs.length / 2} pile volumes (net and fill) against \`site.js\`: largest difference ${(vCheck.maxRel * 100).toFixed(3)} % (${wst?.pile ?? '-'} ${wst?.epoch ?? ''} ${wst?.base ?? ''}: ${wst ? wst.computed.toFixed(1) : '-'} vs ${wst ? wst.kit.toFixed(1) : '-'} m³), relative to the larger of the kit figure and 10 m³; tolerance ${(VOLUME_TOLERANCE * 100).toFixed(1)} %. Change (surface to surface, ${changePairs.length} piles): largest difference ${(cCheck.maxRel * 100).toFixed(3)} %.`,
    '- Vertical:',
    ...verticalLines.map((l) => `  ${l}`),
    '- Horizontal (terrain and ortho share the grid corner; this checks the data lines up):',
    ...horizontalLines.map((l) => `  ${l}`),
  ]);
  rep.note(
    `Default base ${site.volume.default_base}; density ${site.volume.density_t_m3} t/m³; change deadband ${db} m. Kit totals (tin): ${EPS.map((e) => `${epochOf(e).label} ${formatM3(site.totals[e]?.tin ?? NaN)}`).join(', ')}.`,
  );
  rep.note(
    "The 3D terrain uses the kit's site texture (about 13.5 cm per px). The full 3 cm ortho is in the raster pyramid; the legacy viewer swaps in 6 cm pile photos.",
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

const captureId = (date: string) => `survey-${date}`;

const fmtM = (v: number) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(3)} m`;

function pct(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
}

function ringCentroid(ring: readonly En[]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] ?? [0, 0];
    const [xj, yj] = ring[j] ?? [0, 0];
    const f = xj * yi - xi * yj;
    a += f;
    cx += (xi + xj) * f;
    cy += (yi + yj) * f;
  }
  if (Math.abs(a) < 1e-9) return ring[0] ? [ring[0][0], ring[0][1]] : [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

function dataUriBytes(uri: string): Uint8Array {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(uri);
  if (!m?.[1]) throw new Error('Texture is not a base64 data URI');
  return new Uint8Array(Buffer.from(m[1], 'base64'));
}

/** The viewer's site DSM (`data/dsm_<e>.js`): cm above zoff, row deltas, plus a validity mask. */
export function decodeDsmScript(text: string): HeightGrid {
  const r = z
    .object({
      res: z.number(),
      w: z.number().int(),
      h: z.number().int(),
      x0: z.number(),
      y1: z.number(),
      zoff: z.number(),
      z: z.string(),
      valid: z.string(),
    })
    .parse(parseVsDataJs(text, 'VS_DSM').value);
  const zz = decodeDeltaI16(r.z, r.w, r.h);
  const ok = decodeBits(r.valid, r.w * r.h);
  const out = new Float32Array(r.w * r.h);
  for (let i = 0; i < out.length; i++) out[i] = ok[i] ? (zz[i] ?? 0) / 100 + r.zoff : NaN;
  return { w: r.w, h: r.h, res: r.res, x0: r.x0, y1: r.y1, z: out };
}

/** Height at (E, N), or at the nearest lattice cell with data within 3 cells. */
function heightNear(g: HeightGrid, e: number, n: number): number | null {
  const h = sampleHeight(g, e, n);
  if (h !== null) return h;
  const ci = Math.floor((e - g.x0) / g.res);
  const cj = Math.floor((g.y1 - n) / g.res);
  for (let r = 0; r <= 3; r++)
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
        const v = g.z[j * g.w + i] ?? NaN;
        if (v === v) return v;
      }
  return null;
}

/** Closed toe line as line-segment pairs, lifted above the surface. */
function toeLine(
  ring: readonly En[],
  g: HeightGrid,
  local: (e: number, n: number, h: number) => Vec3,
): { positions: Float32Array; indices: Uint32Array } | null {
  const pts = ring.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && first?.[0] === last?.[0] && first?.[1] === last?.[1]) pts.pop();
  const pos: number[] = [];
  const keep: boolean[] = [];
  for (const [e, n] of pts) {
    const h = heightNear(g, e, n);
    keep.push(h !== null);
    pos.push(...local(e, n, (h ?? 0) + TOE_LIFT_M));
  }
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    if (keep[i] && keep[j]) idx.push(i, j);
  }
  if (!idx.length) return null;
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

function terrainGlb(
  e: string,
  t: { ground: TerrainPart; regions: TerrainPart[] },
  texture: Uint8Array,
  toe: (node: string) => { positions: Float32Array; indices: Uint32Array } | null,
): Uint8Array {
  const meshes: GlbMesh[] = [];
  const nodes: GlbNode[] = [{ name: `Stockyard_${e}`, children: [] }];
  const surface = (p: TerrainPart) => ({
    material: 0,
    positions: p.positions,
    normals: p.normals,
    uvs: p.uvs,
    indices: p.indices,
  });
  if (t.ground.indices.length) {
    meshes.push({ name: `Terrain_${e}`, primitives: [surface(t.ground)] });
    nodes.push({ name: `Terrain_${e}`, mesh: meshes.length - 1, extras: { type: 'terrain' } });
  }
  for (const r of t.regions) {
    const line = toe(r.name);
    meshes.push({
      name: r.name,
      primitives: [surface(r), ...(line ? [{ material: 1, mode: 'lines' as const, ...line }] : [])],
    });
    nodes.push({ name: r.name, mesh: meshes.length - 1, extras: { type: 'stockpile' } });
  }
  const root = nodes[0];
  if (root) root.children = nodes.slice(1).map((_, i) => i + 1);
  return encodeGlb({
    generator: 'Quadrion AI import (Volumetric Survey Kit terrain)',
    nodes,
    scene: [0],
    meshes,
    materials: [
      { name: `Ground_Ortho_${e}`, texture: 0 },
      { name: 'Toe_Line', color: TOE_COLOR },
    ],
    images: [{ mimeType: 'image/jpeg', data: texture }],
  });
}

/** Relative paths of every file under `dir` (forward slashes). */
function walk(root: string, dir: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const f of readdirSync(abs)) {
    const p = join(abs, f);
    if (statSync(p).isDirectory()) out.push(...walk(root, relative(root, p)));
    else out.push(relative(root, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

/**
 * Coverage overlap of the ortho (alpha of the coarsest kept level) and the DSM lattice (cells with
 * data), as intersection over union, with no shift and for the best shift within a few pixels.
 */
async function orthoAlignment(
  g: HeightGrid,
  tiles: readonly { file: string; x: number; y: number }[],
  o: { x0: number; y1: number; px: number; res: number },
): Promise<{
  iou: number;
  best: { dx: number; dy: number };
  bestIou: number;
  maxShift: number;
  res: number;
}> {
  const cols = Math.max(...tiles.map((t) => t.x)) + 1;
  const rows = Math.max(...tiles.map((t) => t.y)) + 1;
  const W = cols * o.px;
  const H = rows * o.px;
  const ortho = new Uint8Array(W * H);
  for (const t of tiles) {
    const s = imageSize(new Uint8Array(readFileSync(t.file))) ?? { width: o.px, height: o.px };
    const img = await readRgba(t.file, s.width, s.height);
    for (let y = 0; y < Math.min(o.px, s.height); y++)
      for (let x = 0; x < Math.min(o.px, s.width); x++)
        ortho[(t.y * o.px + y) * W + t.x * o.px + x] =
          (img.data[(y * s.width + x) * 4 + 3] ?? 0) > 127 ? 1 : 0;
  }
  const dsm = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = Math.floor(((x + 0.5) * o.res) / g.res);
      const j = Math.floor(((y + 0.5) * o.res) / g.res);
      if (i < g.w && j < g.h) {
        const v = g.z[j * g.w + i] ?? NaN;
        dsm[y * W + x] = v === v ? 1 : 0;
      }
    }
  const maxShift = 4;
  const iouAt = (dx: number, dy: number) => {
    let inter = 0;
    let uni = 0;
    for (let y = maxShift; y < H - maxShift; y++)
      for (let x = maxShift; x < W - maxShift; x++) {
        const a = ortho[(y + dy) * W + x + dx] ?? 0;
        const b = dsm[y * W + x] ?? 0;
        if (a && b) inter++;
        if (a || b) uni++;
      }
    return uni ? inter / uni : 0;
  };
  const iou = iouAt(0, 0);
  let best = { dx: 0, dy: 0 };
  let bestIou = iou;
  for (let dy = -maxShift; dy <= maxShift; dy++)
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const v = iouAt(dx, dy);
      if (v > bestIou + 1e-9) {
        bestIou = v;
        best = { dx, dy };
      }
    }
  return { iou, best, bestIou, maxShift, res: o.res };
}
