#!/usr/bin/env node
/* eslint-disable no-console -- command-line output */
// Data licence gate (M10 G1): every imagery and terrain pack we build and distribute carries its
// licence, attribution and provenance (the data source) in its metadata (`aio.raster-pack/1`,
// data-conventions section 23), under a licence that allows redistribution of derived works.
//
//   node tools/release/data-licences.mjs [<folder>...]
//
// Checks tools/release/data-sources.json (the sources decision 4 names) and every
// `aio.raster-pack/1` JSON file under the folders given (a data folder's packs/imagery and
// packs/terrain, or a pack build's output). Refuses non-commercial (NC), share-alike (SA),
// no-derivatives (ND) and unknown licences, a missing attribution or provenance, a pack marked
// with the customer's own licence (never redistributed by us, decision 12), and the providers
// decision 4 rules out (Cesium ion, Bing, Google, Esri, Mapbox, EOX cloudless 2018 to 2025).
// Allowed licences: `allowed.data` in licence-exceptions.json.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCEPTIONS_FILE } from './licence-policy.mjs';

export const SOURCES_FILE = fileURLToPath(new URL('./data-sources.json', import.meta.url));

export function dataPolicy(doc = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8'))) {
  return { allowed: new Set(doc.allowed?.data ?? []) };
}

export function loadSources(path = SOURCES_FILE) {
  return JSON.parse(readFileSync(path, 'utf8')).sources;
}

const RULED_OUT = [
  [/\bion\b|cesium\s*ion/i, 'Cesium ion'],
  [/\bbing\b|virtualearth/i, 'Bing'],
  [/google/i, 'Google'],
  [/\besri\b|arcgis/i, 'Esri'],
  [/mapbox/i, 'Mapbox'],
  [
    /eox.*cloudless.*\b20(1[89]|2[0-5])\b/i,
    'EOX cloudless 2018 to 2025 (needs an EOX commercial licence)',
  ],
];

/** Problems with one raster pack's metadata (or one source entry); [] when it may ship. */
export function checkPackMeta(meta, policy) {
  const out = [];
  const licence = typeof meta.licence === 'string' ? meta.licence.trim() : '';
  if (meta.customerLicence === true)
    out.push('marked with the customer licence: never redistributed by us (decision 12)');
  if (!licence) out.push('no licence');
  else if (/(^|-)(NC|SA|ND)(-|$)/i.test(licence) || /^ODbL/i.test(licence))
    out.push(
      `${licence}: non-commercial, share-alike or no-derivatives data cannot go in a pack we distribute`,
    );
  else if (!policy.allowed.has(licence))
    out.push(`${licence}: not an allowed data licence (allowed.data in licence-exceptions.json)`);
  if (typeof meta.attribution !== 'string' || meta.attribution.trim() === '')
    out.push('no attribution (shown in the Globe, the map and every export)');
  if (typeof meta.provenance !== 'string' || meta.provenance.trim() === '')
    out.push('no provenance (where the data came from)');
  for (const [re, who] of RULED_OUT)
    if ([meta.provenance, meta.label].some((t) => typeof t === 'string' && re.test(t)))
      out.push(`${who} data is ruled out by decision 4`);
  return out;
}

/** Problems with the committed sources: imagery and terrain sources are judged like packs. */
export function checkSources(sources, policy) {
  return sources
    .filter((s) => s.kind === 'imagery' || s.kind === 'terrain')
    .flatMap((s) => checkPackMeta(s, policy).map((p) => `data-sources.json, ${s.name}: ${p}`));
}

/** Every `aio.raster-pack/1` metadata file under `dirs`, sorted by path. */
export function findPackMetas(dirs) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.json')) {
        try {
          const meta = JSON.parse(readFileSync(p, 'utf8'));
          if (meta?.schema === 'aio.raster-pack/1') out.push({ file: p, meta });
        } catch {
          /* not JSON: not a pack's metadata */
        }
      }
    }
  };
  for (const d of dirs) walk(d);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function runDataGate({ dirs = [], policy = dataPolicy(), sources = loadSources() }) {
  const problems = checkSources(sources, policy);
  const metas = findPackMetas(dirs);
  for (const { file, meta } of metas)
    problems.push(...checkPackMeta(meta, policy).map((p) => `${file}: ${p}`));
  return { problems, packs: metas.length, sources: sources.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = runDataGate({ dirs: process.argv.slice(2).map((d) => resolve(d)) });
  if (out.problems.length > 0) {
    console.error(`Data licence gate failed:\n  ${out.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `Data licence gate passed: ${String(out.sources)} sources, ${String(out.packs)} pack metadata files.`,
  );
}
