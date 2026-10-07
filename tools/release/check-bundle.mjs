#!/usr/bin/env node
/* eslint-disable no-console -- release script output */
// Fails when the built main or preload bundle loads a package that the installed app does not
// ship (build-time tools such as sharp). Run from apps/desktop after `electron-vite build`.
// When a packaged app is in dist/, also requires onnxruntime-node's native files in
// app.asar.unpacked (on Windows onnxruntime_binding.node, onnxruntime.dll and DirectML.dll).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findPackagedApp, missingOnnxFiles, onnxBinaryDir } from './onnx-probe.mjs';

const FORBIDDEN = ['sharp', 'jiti', 'vitest', '@playwright/test', 'electron-builder'];
const ROOTS = ['out/main', 'out/preload'];

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.js') || p.endsWith('.cjs') || p.endsWith('.mjs') ? [p] : [];
  });
}

/** True when `text` imports or requires `name` (or a subpath of it). */
export function loads(text, name) {
  const quoted = [`"${name}"`, `'${name}'`, `"${name}/`, `'${name}/`];
  return quoted.some((q) =>
    ['from ', 'from', 'require(', 'import('].some((prefix) => text.includes(prefix + q)),
  );
}

const problems = [];
for (const root of ROOTS) {
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    for (const name of FORBIDDEN) {
      if (loads(text, name)) problems.push(`${file} loads "${name}"`);
    }
  }
}
if (problems.length) {
  console.error('Bundle check failed: the installed app would crash on start.');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Bundle check passed (${ROOTS.join(', ')}).`);

// M10 decision 3: the Globe stays offline. No built renderer file (the Globe's chunk and the
// copied Cesium assets in out/renderer/cesium included) may name an online imagery, terrain or
// geocoder host (the list of packages/globe/src/offline.ts `ONLINE_GLOBE_HOSTS`).
const ONLINE_GLOBE_HOSTS = [
  'cesium.com',
  'virtualearth.net',
  'googleapis.com',
  'arcgisonline.com',
  'mapbox.com',
];
const RENDERER = 'out/renderer';
const TEXT = /\.(c?m?js|html|json|css)$/;
function rendererFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return rendererFiles(p);
    return TEXT.test(p) ? [p] : [];
  });
}
const named = [];
for (const file of rendererFiles(RENDERER)) {
  const text = readFileSync(file, 'utf8');
  for (const host of ONLINE_GLOBE_HOSTS) if (text.includes(host)) named.push(`${file}: ${host}`);
}
if (named.length) {
  console.error(
    'Bundle check failed: the renderer names an online map host (the Globe is offline).',
  );
  for (const n of named) console.error(`  ${n}`);
  process.exit(1);
}
console.log(`Bundle check passed: no online map host in ${RENDERER}.`);

// After packaging (dist.mjs runs this after electron-builder): local detection's native files
// must be unpacked next to app.asar, or the inference process cannot load onnxruntime.
const app = findPackagedApp();
if (app) {
  const missing = missingOnnxFiles(app.resources, app.platform, app.arch);
  if (missing.length) {
    console.error('Bundle check failed: local detection would not load in the packaged app.');
    for (const m of missing) console.error(`  missing ${join(app.resources, m)}`);
    process.exit(1);
  }
  console.log(
    `Bundle check passed: onnxruntime binaries unpacked in ${join(app.resources, onnxBinaryDir(app.platform, app.arch))}.`,
  );
}
