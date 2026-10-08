#!/usr/bin/env node
/* eslint-disable no-console -- command-line output */
// Licence inventory for 1.0 (docs/release/THIRD-PARTY-NOTICES.md): every third-party package that
// ships, from the lockfiles' installed trees.
//   - The app and the Team Server: `pnpm licenses list --json --prod -r` (what Settings, About
//     lists from the same report), workspace packages (`@aio/*`) left out.
//   - The pipeline pack: the runtime dependency tree of `aio-pipelines` in python/.venv (uv.lock),
//     licence from each distribution's metadata.
//   - The pack's native libraries (M10 G1): tools/release/native-libs.json (libraries inside the
//     wheels and CPython, and what the prebuilt pycolmap, OpenCV and pymeshlab wheels bundle) and
//     tools/pipeline-pack/pdal-lock.json (conda-forge's PDAL and its libraries). Since the founder
//     decision of 8 Oct 2026 these carry GPL parts; their licences are listed as they are.
//   - Map and imagery data: tools/release/data-sources.json.
//
//   node tools/release/notices.mjs          write docs/release/THIRD-PARTY-NOTICES.md
//   node tools/release/notices.mjs --check  fail when the committed file is out of date
//
// Needs `pnpm install` and, for the pack, `uv sync` in python/. The full licence texts ship in the
// app (Settings, About) and in the pack's site-packages; this file is the inventory for
// procurement and the release checklist.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
export const NOTICES = join(repo, 'docs', 'release', 'THIRD-PARTY-NOTICES.md');

/** pnpm's licence report (licence to packages) to sorted entries without workspace packages. */
export function jsEntries(report) {
  const out = [];
  for (const [license, pkgs] of Object.entries(report ?? {})) {
    for (const p of Array.isArray(pkgs) ? pkgs : []) {
      if (typeof p.name !== 'string' || p.name.startsWith('@aio/')) continue;
      out.push({
        name: p.name,
        version: (Array.isArray(p.versions) ? p.versions : []).join(', '),
        license: typeof p.license === 'string' ? p.license : license,
        homepage: typeof p.homepage === 'string' ? p.homepage : '',
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Native builds for the platforms the app ships on; pnpm installs only this machine's one. */
const PLATFORM_BUILD = /-(win32|darwin)-(x64|arm64)(-[a-z]+)?$/;

/**
 * Adds the Windows and macOS builds of each native package that ships (for example
 * `@napi-rs/keyring-darwin-arm64` when the list was made on Windows), from the lockfile's package
 * keys, with the licence of the build that is installed here.
 */
export function withPlatformBuilds(entries, lockText) {
  const names = new Set(entries.map((e) => e.name));
  const out = [...entries];
  for (const e of entries) {
    const m = PLATFORM_BUILD.exec(e.name);
    if (!m) continue;
    const base = e.name.slice(0, m.index);
    for (const [, name, version] of lockText.matchAll(/^ {2}'?(@?[^@'\s]+)@([^'():\s]+)'?:/gm)) {
      if (names.has(name) || !name.startsWith(`${base}-`)) continue;
      if (!PLATFORM_BUILD.test(name) || name.slice(0, PLATFORM_BUILD.exec(name).index) !== base)
        continue;
      names.add(name);
      out.push({ ...e, name, version });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function jsInventory() {
  const out = execSync('pnpm licenses list --json --prod -r', {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return withPlatformBuilds(
    jsEntries(JSON.parse(out)),
    readFileSync(join(repo, 'pnpm-lock.yaml'), 'utf8'),
  );
}

/** Python run in the pack's environment: the runtime tree of aio-pipelines with licences. */
const PY = `
import json
from importlib.metadata import PackageNotFoundError, distribution
from packaging.requirements import Requirement
seen, todo = {}, ["aio-pipelines"]
while todo:
    name = todo.pop()
    key = name.lower().replace("_", "-")
    if key in seen:
        continue
    try:
        d = distribution(name)
    except PackageNotFoundError:
        continue
    m = d.metadata
    seen[key] = {
        "name": m["Name"],
        "version": d.version,
        "expression": m.get("License-Expression") or "",
        "license": (m.get("License") or "")[:200],
        "classifiers": [c for c in (m.get_all("Classifier") or []) if c.startswith("License ::")],
        "homepage": m.get("Home-page") or "",
    }
    for req in d.requires or []:
        r = Requirement(req)
        if r.marker and not r.marker.evaluate({"extra": ""}):
            continue
        todo.append(r.name)
seen.pop("aio-pipelines", None)
print(json.dumps(sorted(seen.values(), key=lambda x: x["name"].lower())))
`;

/** One short licence name from Python metadata: the SPDX expression, a classifier or the text. */
export function pythonLicense(d) {
  if (d.expression) return d.expression;
  if (d.name && PYTHON_READ[d.name]) return PYTHON_READ[d.name];
  const first = (d.license ?? '').split('\n')[0].trim();
  const named =
    first && first.length <= 60 && !/^copyright/i.test(first) && !first.includes(':')
      ? first
      : null;
  const c = (d.classifiers ?? []).map((x) => x.split('::').pop().trim());
  const name = named ?? (c.length > 0 ? c.join(' OR ') : null);
  if (!name) return first ? `${first.slice(0, 57)}...` : 'see package';
  return SPDX[name] ?? name;
}

/**
 * Distributions whose metadata names no licence we can read, as their licence file states it:
 * python-dateutil says only "Dual License" (code since 2017 Apache-2.0, older code BSD-3-Clause).
 */
const PYTHON_READ = {
  'python-dateutil': 'Apache-2.0 AND BSD-3-Clause',
};

/** Common free-text licence names to their SPDX id. */
const SPDX = {
  'The MIT License (MIT)': 'MIT',
  'MIT License': 'MIT',
  'BSD 3-Clause': 'BSD-3-Clause',
  'BSD-3-Clause License': 'BSD-3-Clause',
  'Apache Software License': 'Apache-2.0',
  'BSD License': 'BSD (classifier)',
  GPL3: 'GPL-3.0-only',
  'Apache 2.0': 'Apache-2.0',
};

export function pythonInventory() {
  const python = join(repo, 'python');
  const venv = join(python, '.venv');
  if (!existsSync(venv)) throw new Error('No python/.venv: run uv sync --frozen in python/ first.');
  const out = execFileSync('uv', ['run', '--frozen', '--offline', 'python', '-c', PY], {
    cwd: python,
    encoding: 'utf8',
  });
  return JSON.parse(out).map((d) => ({
    name: d.name,
    version: d.version,
    license: pythonLicense(d),
    homepage: d.homepage,
  }));
}

const cell = (s) => String(s).replaceAll('|', '\\|');

function table(entries) {
  return [
    '| Package | Version | Licence |',
    '| ------- | ------- | ------- |',
    ...entries.map((e) => `| ${cell(e.name)} | ${cell(e.version)} | ${cell(e.license)} |`),
  ].join('\n');
}

function counts(entries) {
  const by = new Map();
  for (const e of entries) by.set(e.license, (by.get(e.license) ?? 0) + 1);
  return [...by]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l, n]) => `${l} (${String(n)})`)
    .join(', ');
}

const readJson = (rel) => JSON.parse(readFileSync(join(repo, rel), 'utf8'));

/** The pack's native libraries: { libs, bundled, pdal } as inventory entries. */
export function nativeInventory(
  libsDoc = readJson('tools/release/native-libs.json'),
  lockDoc = readJson('tools/pipeline-pack/pdal-lock.json'),
) {
  const entry = (name, version, license, homepage = '') => ({
    name,
    version: version ?? '',
    license,
    homepage: homepage ?? '',
  });
  const sort = (list) => list.sort((a, b) => a.name.localeCompare(b.name));
  const bundled = libsDoc.libs.flatMap((r) =>
    (r.includes ?? []).map((i) =>
      entry(
        `${i.name} (in ${r.name.split(' (')[0]}${i.where ? `, ${i.where}` : ''})`,
        r.version,
        i.spdx,
        r.source,
      ),
    ),
  );
  const subdirs = Object.keys(lockDoc.platforms ?? {});
  const byName = new Map();
  for (const [sub, pkgs] of Object.entries(lockDoc.platforms ?? {}))
    for (const p of pkgs) {
      const e = byName.get(p.name) ?? { versions: new Set(), licences: new Set(), subs: [] };
      e.versions.add(p.version);
      e.licences.add(p.license || 'see package');
      e.subs.push(sub);
      byName.set(p.name, e);
    }
  const pdal = [...byName].map(([name, e]) =>
    entry(
      e.subs.length === subdirs.length ? name : `${name} (${e.subs.join(', ')})`,
      [...e.versions].join(', '),
      [...e.licences].join(' / '),
    ),
  );
  return {
    libs: sort(libsDoc.libs.map((r) => entry(r.name, r.version, r.spdx, r.source))),
    bundled,
    pdal: sort(pdal),
  };
}

/** Map and imagery data we distribute or ship. */
export function dataInventory(doc = readJson('tools/release/data-sources.json')) {
  return doc.sources.map((s) => ({
    name: s.name,
    kind: s.kind,
    license: s.licence,
    attribution: s.attribution,
  }));
}

function dataTable(entries) {
  return [
    '| Data | Kind | Licence | Attribution |',
    '| ---- | ---- | ------- | ----------- |',
    ...entries.map(
      (e) => `| ${cell(e.name)} | ${cell(e.kind)} | ${cell(e.license)} | ${cell(e.attribution)} |`,
    ),
  ].join('\n');
}

function nativeSections(native, data) {
  const out = [];
  if (native) {
    out.push(`## Pipeline pack native libraries

Generated from \`tools/release/native-libs.json\` and \`tools/pipeline-pack/pdal-lock.json\`. Since the founder decision of 8 Oct 2026 (ADR 0008, amended) the pack is built from prebuilt binaries: COLMAP's, OpenCV's and MeshLab's PyPI wheels and conda-forge's PDAL, with their GPL and LGPL parts. The native licence report (\`tools/release/native-licences.mjs\`) lists every DLL, dylib and executable of each pack against these inventories; it never fails a build.

**GPL.** Our pipeline code (MIT) runs in one process with GPL libraries: SuiteSparse CHOLMOD and SPQR inside pycolmap (GPL-2.0-or-later), MeshLab inside pymeshlab (GPL-3.0) and, on macOS, the GPL FFmpeg build inside OpenCV's wheel. A pipeline pack as a whole is therefore distributed under the terms of the GNU General Public License, version 3; the source of each GPL component is available from its project (the sources below), and the source of our pipeline code is available on request. The desktop app and the Team Server do not link any of it: they start the pack as a separate program.

### Inside the Python wheels and CPython

${String(native.libs.length)} libraries: ${counts(native.libs)}.

${table(native.libs)}

### Bundled in the photogrammetry wheels (Windows x64 and macOS arm64)

What the pycolmap, opencv-python-headless and pymeshlab wheels carry, as their projects state it.

${table(native.bundled)}

### PDAL from conda-forge

The \`pdal\` tool of the pack (\`tools/pdal\`), installed from conda-forge's \`libpdal-core\` with the packages it needs; ${String(native.pdal.length)} packages: ${counts(native.pdal)}. Each package's licence files ship in \`tools/pdal/licenses\`.

${table(native.pdal)}
`);
  }
  if (data) {
    out.push(`## Map and imagery data

From \`tools/release/data-sources.json\`; every imagery and terrain pack we build carries its licence, attribution and provenance, checked by \`tools/release/data-licences.mjs\`. The attribution shows in the Globe, the map and every export that contains the data. Imagery a customer imports under their own licence is never redistributed by us.

${dataTable(data)}
`);
  }
  return out.join('\n');
}

/** The Markdown inventory. */
export function render(js, py, native = null, data = null) {
  return `# Third-party notices

Inventory of the third-party software that ships with Quadrion AI 1.0: the desktop app, the Team Server image and the pipeline pack. Generated by \`node tools/release/notices.mjs\` from the installed trees of \`pnpm-lock.yaml\` and \`python/uv.lock\` and the native and data inventories; do not edit by hand. CI's licence reports list what they find and never fail a build (founder decision of 8 Oct 2026): \`pnpm license:check\` (npm), \`python/tests/test_licences.py\` (Python), \`tools/release/native-licences.mjs\` (native libraries) and \`tools/release/data-licences.mjs\` (data packs). The desktop app and the Team Server stay permissive; the pipeline pack has GPL parts (below).

The full licence texts ship with the software: the app lists every package with its licence in Settings, About, and the pipeline pack keeps each package's licence files in its \`site-packages\` folder.

## Desktop app and Team Server (npm)

${String(js.length)} packages: ${counts(js)}.

${table(js)}

## Pipeline pack (Python)

${String(py.length)} packages: ${counts(py)}. The pack also bundles CPython (PSF licence) from python-build-standalone; rasterio's wheel bundles GDAL (MIT) and its dependencies, and the pycolmap, opencv-python-headless and pymeshlab wheels bundle the native libraries listed below, GPL parts included.

${table(py)}
${native || data ? `\n${nativeSections(native, data)}` : ''}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(jsInventory(), pythonInventory(), nativeInventory(), dataInventory());
  const { format, resolveConfig } = await import('prettier');
  const pretty = await format(text, {
    ...((await resolveConfig(NOTICES)) ?? {}),
    parser: 'markdown',
  });
  if (process.argv.includes('--check')) {
    const now = existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8') : '';
    if (now !== pretty) {
      console.error(`${NOTICES} is out of date: run node tools/release/notices.mjs`);
      process.exit(1);
    }
    console.log('Third-party notices are up to date.');
  } else {
    writeFileSync(NOTICES, pretty);
    console.log(`Wrote ${NOTICES}`);
  }
}
