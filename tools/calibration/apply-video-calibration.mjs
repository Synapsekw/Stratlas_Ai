#!/usr/bin/env node
// Apply a video calibration patch (lens, orientation bias, camera position offset per clip) to a
// native project's manifest.json, the way Calibrate video saves it, for calibrations fitted
// outside the app (BLD-3).
//
//   node tools/calibration/apply-video-calibration.mjs --project <project dir> --patch <file>
//        [--backup manifest.before-orientation.json] [--dry-run]
//
// Patch: { "schema": "aio.video-calibration-patch/1", "layers": { "<video layer id>": {
//   "lens"?: LensModel, "orientation"?: { yawDeg, pitchDeg, rollDeg } | null,
//   "positionOffsetM"?: [x, y, z] | null, "offsetMs"?: number } } }
//
// Only manifest.json is written: first copied to the backup name (refused if that file exists),
// then replaced atomically (written beside it, then renamed). Every patched layer must exist and
// be a video layer; values are range-checked; nothing is written if any check fails.
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function args(argv) {
  const out = { backup: 'manifest.before-orientation.json', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--patch') out.patch = argv[++i];
    else if (a === '--backup') out.backup = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!out.project || !out.patch) throw new Error('Give --project <dir> and --patch <file>.');
  return out;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Check one layer's patch; returns the problems found. */
export function checkLayerPatch(id, p) {
  const bad = [];
  if (p.lens !== undefined) {
    const l = p.lens;
    if (!l || (l.model !== 'pinhole' && l.model !== 'ftheta')) bad.push(`${id}: lens model`);
    else if (
      !finite(l.hfovDeg) ||
      l.hfovDeg <= 0 ||
      l.hfovDeg >= (l.model === 'pinhole' ? 180 : 360)
    )
      bad.push(`${id}: lens hfovDeg`);
    else if (!finite(l.aspect) || l.aspect <= 0) bad.push(`${id}: lens aspect`);
  }
  if (p.orientation !== undefined && p.orientation !== null) {
    const o = p.orientation;
    if (!finite(o.yawDeg) || Math.abs(o.yawDeg) > 180) bad.push(`${id}: orientation yawDeg`);
    if (!finite(o.pitchDeg) || Math.abs(o.pitchDeg) > 90) bad.push(`${id}: orientation pitchDeg`);
    if (!finite(o.rollDeg) || Math.abs(o.rollDeg) > 180) bad.push(`${id}: orientation rollDeg`);
  }
  if (p.positionOffsetM !== undefined && p.positionOffsetM !== null) {
    const d = p.positionOffsetM;
    if (!Array.isArray(d) || d.length !== 3 || !d.every(finite)) bad.push(`${id}: positionOffsetM`);
  }
  if (p.offsetMs !== undefined && !finite(p.offsetMs)) bad.push(`${id}: offsetMs`);
  const known = new Set(['lens', 'orientation', 'positionOffsetM', 'offsetMs']);
  for (const k of Object.keys(p)) if (!known.has(k)) bad.push(`${id}: unknown field ${k}`);
  return bad;
}

/** The manifest with the patch applied (pure). Throws with every problem found. */
export function applyPatch(manifest, patch) {
  if (patch?.schema !== 'aio.video-calibration-patch/1')
    throw new Error('Patch schema must be "aio.video-calibration-patch/1".');
  const problems = [];
  const byId = new Map(manifest.layers.map((l) => [l.id, l]));
  for (const [id, p] of Object.entries(patch.layers ?? {})) {
    const l = byId.get(id);
    if (!l) problems.push(`${id}: not in the manifest`);
    else if (l.kind !== 'video') problems.push(`${id}: not a video layer`);
    problems.push(...checkLayerPatch(id, p));
  }
  if (problems.length) throw new Error(`Patch refused:\n  ${problems.join('\n  ')}`);
  const layers = manifest.layers.map((l) => {
    const p = patch.layers[l.id];
    if (!p) return l;
    const next = { ...l };
    if (p.lens) next.lens = p.lens;
    if (p.offsetMs !== undefined) next.offsetMs = Math.round(p.offsetMs);
    if (p.orientation === null) delete next.orientation;
    else if (p.orientation) next.orientation = p.orientation;
    if (p.positionOffsetM === null) delete next.positionOffsetM;
    else if (p.positionOffsetM) next.positionOffsetM = p.positionOffsetM;
    return next;
  });
  return { ...manifest, layers };
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const file = join(a.project, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const patch = JSON.parse(await readFile(a.patch, 'utf8'));
  const next = applyPatch(manifest, patch);
  const ids = Object.keys(patch.layers);
  if (a.dryRun) {
    process.stdout.write(`Dry run: ${String(ids.length)} video layers would change in ${file}.\n`);
    return;
  }
  const backup = join(a.project, a.backup);
  if (await exists(backup)) throw new Error(`${backup} exists; choose another --backup name.`);
  await copyFile(file, backup);
  const tmp = `${file}.partial`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  JSON.parse(await readFile(tmp, 'utf8'));
  await rename(tmp, file);
  process.stdout.write(
    `Patched ${String(ids.length)} video layers in ${file}; backup ${backup}.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
