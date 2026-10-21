#!/usr/bin/env node
/* eslint-disable no-console -- command-line output */
// Licence inventory for 1.0 (docs/release/THIRD-PARTY-NOTICES.md): every third-party package that
// ships, from the lockfiles' installed trees.
//   - The app and the Team Server: `pnpm licenses list --json --prod -r` (what Settings, About
//     lists from the same report), workspace packages (`@aio/*`) left out.
//   - The pipeline pack: the runtime dependency tree of `aio-pipelines` in python/.venv (uv.lock),
//     licence from each distribution's metadata.
//   - The pack's native libraries (M10 G1): tools/release/native-libs.json (libraries inside the
//     wheels and CPython, and what the prebuilt pycolmap and OpenCV wheels bundle) and
//     tools/pipeline-pack/pdal-lock.json (conda-forge's PDAL and its libraries). Since the founder
//     decision of 8 Oct 2026 these carry GPL parts; their licences are listed as they are.
//   - Map and imagery data: tools/release/data-sources.json.
//   - Model weights in the pipeline pack: tools/pipeline-pack/sam.mjs (the boundary model, M11 G12).
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
import { SAM_MODEL } from '../pipeline-pack/sam.mjs';

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
  // A worktree has no venv of its own: AIO_NOTICES_PYTHON names another checkout's interpreter,
  // only read (no uv, so nothing is synced or re-pointed in that environment).
  const interpreter = process.env.AIO_NOTICES_PYTHON;
  if (!interpreter && !existsSync(venv))
    throw new Error(
      'No python/.venv: run uv sync --frozen in python/ first, or set AIO_NOTICES_PYTHON.',
    );
  const out = interpreter
    ? execFileSync(interpreter, ['-I', '-c', PY], { encoding: 'utf8' })
    : execFileSync('uv', ['run', '--frozen', '--offline', 'python', '-c', PY], {
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

/** The pack's native libraries: { libs, bundled, pdal, ffmpeg } as inventory entries. */
export function nativeInventory(
  libsDoc = readJson('tools/release/native-libs.json'),
  lockDoc = readJson('tools/pipeline-pack/pdal-lock.json'),
  ffmpegLockDoc = readJson('tools/pipeline-pack/ffmpeg-lock.json'),
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
  // a conda lock's packages, once each, with the platforms named when not on all of them
  const conda = (doc) => {
    const subdirs = Object.keys(doc.platforms ?? {});
    const byName = new Map();
    for (const [sub, pkgs] of Object.entries(doc.platforms ?? {}))
      for (const p of pkgs) {
        const e = byName.get(p.name) ?? { versions: new Set(), licences: new Set(), subs: [] };
        e.versions.add(p.version);
        e.licences.add(p.license || 'see package');
        e.subs.push(sub);
        byName.set(p.name, e);
      }
    return sort(
      [...byName].map(([name, e]) =>
        entry(
          e.subs.length === subdirs.length ? name : `${name} (${e.subs.join(', ')})`,
          [...e.versions].join(', '),
          [...e.licences].join(' / '),
        ),
      ),
    );
  };
  return {
    libs: sort(libsDoc.libs.map((r) => entry(r.name, r.version, r.spdx, r.source))),
    bundled,
    pdal: conda(lockDoc),
    ffmpeg: conda(ffmpegLockDoc),
    // licences quoted in full: a row's `licenceFile` (repo-relative) is its licence text
    licenceTexts: libsDoc.libs
      .filter((r) => r.licenceFile)
      .map((r) => ({
        name: r.name,
        text: readFileSync(join(repo, r.licenceFile), 'utf8').replaceAll('\r\n', '\n').trimEnd(),
      })),
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

/** Model weights the pipeline pack carries (the boundary model of ADR 0011). */
export function modelInventory(models = [SAM_MODEL]) {
  return models.map((m) => ({
    name: m.name,
    version: m.version,
    license: m.licence,
    use: 'Suggest boundaries, snapping cut and fill regions and the Review mask assist (`models/sam`)',
    source: m.source,
    files: Object.entries(m.files)
      .map(
        ([f, v]) =>
          `\`${f}\` ${(v.size / 1e6).toFixed(1)} MB, SHA-256 \`${v.sha256.slice(0, 16)}...\``,
      )
      .join('; '),
  }));
}

function modelTable(entries) {
  return [
    '| Model | Version | Licence | Used for | Source | Files |',
    '| ----- | ------- | ------- | -------- | ------ | ----- |',
    ...entries.map(
      (e) =>
        `| ${cell(e.name)} | ${cell(e.version)} | ${cell(e.license)} | ${cell(e.use)} | ${cell(e.source)} | ${cell(e.files)} |`,
    ),
  ].join('\n');
}

/** The Analytics pack (tools/analytics-pack/lock.json): fixed text, the pins are in the lock. */
export const ANALYTICS_PACK_NOTICES = `## Analytics pack

The Analytics pack (\`tools/analytics-pack\`) is a separate archive, installed by the person like the pipeline pack. It carries the local vision model for detectors; the app starts its server on 127.0.0.1 only and sends nothing off the computer. Each download is pinned by URL, size and SHA-256 in \`tools/analytics-pack/lock.json\` and refused when the hash differs.

| Component | Licence | Source |
| --------- | ------- | ------ |
| llama.cpp \`llama-server\` (release b11489) | MIT | https://github.com/ggml-org/llama.cpp |
| Qwen2.5-VL-7B-Instruct, GGUF Q4_K_M and its mmproj | Apache-2.0 | https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF |
| NVIDIA CUDA runtime libraries (cudart, cuBLAS), from llama.cpp's \`cudart\` archive | NVIDIA CUDA Toolkit EULA, redistributable runtime terms | https://docs.nvidia.com/cuda/eula/index.html |

The NVIDIA libraries are redistributed unmodified as the CUDA Toolkit licence allows for its runtime components; they are not covered by the MIT or Apache-2.0 licences above.
`;

/** The program the app downloads at run time (ODM): fixed text, the pin is in the app's main process. */
const DOWNLOADED_AT_RUN_TIME = `## Downloaded at run time

Software that is not part of the installer, the Team Server image or the pipeline pack: the person downloads it from its own project through the app, and it is never redistributed by us.

| Program | Version | Licence | Source |
| ------- | ------- | ------- | ------ |
| ODM (OpenDroneMap) | 3.6.2 | AGPL-3.0 | https://github.com/OpenDroneMap/ODM |

ODM (OpenDroneMap) 3.6.2 makes the orthomosaic, the surfaces, the point cloud and the textured mesh from photos. It is installed by the person from Settings, Processing tools: the app downloads ODM's Windows setup from ODM's GitHub release, checks its size and SHA-256 against the pin in \`apps/desktop/src/main/odm/pin.ts\` and runs it with its own silent switches. ODM is a separate program, started by the pipelines as its own process; the app, the Team Server and the pipeline pack never link it and never change its program code, and it is not bundled. Its source is available from the project above.
`;

function nativeSections(native, data, models) {
  const out = [];
  if (native) {
    out.push(`## Pipeline pack native libraries

Generated from \`tools/release/native-libs.json\`, \`tools/pipeline-pack/pdal-lock.json\` and \`tools/pipeline-pack/ffmpeg-lock.json\`. Since the founder decision of 8 Oct 2026 (ADR 0008, amended) the pack is built from prebuilt binaries: COLMAP's and OpenCV's PyPI wheels and conda-forge's PDAL, with their GPL and LGPL parts. The native licence report (\`tools/release/native-licences.mjs\`) lists every DLL, dylib and executable of each pack against these inventories; it never fails a build.

**GPL.** Our pipeline code (MIT) runs in one process with GPL libraries: SuiteSparse CHOLMOD and SPQR inside pycolmap (GPL-2.0-or-later), the ffmpeg tool (\`tools/ffmpeg\`, a GPL build with x264 and x265), the untwine tool (\`tools/pdal\`, GPL-3.0-or-later) and, on macOS, the GPL FFmpeg build inside OpenCV's wheel. A pipeline pack as a whole is therefore distributed under the terms of the GNU General Public License, version 3; the source of each GPL component is available from its project (the sources below), and the source of our pipeline code is available on request. The desktop app and the Team Server do not link any of it: they start the pack as a separate program.

### Inside the Python wheels and CPython

${String(native.libs.length)} libraries: ${counts(native.libs)}.

${table(native.libs)}

### Bundled in the photogrammetry wheels (Windows x64 and macOS arm64)

What the pycolmap and opencv-python-headless wheels carry, as their projects state it.

${table(native.bundled)}

### PDAL from conda-forge

The \`pdal\` and \`untwine\` tools of the pack (\`tools/pdal\`), installed from conda-forge's \`libpdal-core\` and \`untwine\` with the packages they need; ${String(native.pdal.length)} packages: ${counts(native.pdal)}. Each package's licence files ship in \`tools/pdal/licenses\`.

${table(native.pdal)}
${
  native.ffmpeg?.length
    ? `
### ffmpeg from conda-forge

The \`ffmpeg\` and \`ffprobe\` tools of the pack (\`tools/ffmpeg\`), installed from conda-forge's GPL \`ffmpeg\` build (configured with \`--enable-gpl --enable-version3\`, so GPL-3.0-or-later as a whole) and pruned to the libraries the two programs load; ${String(native.ffmpeg.length)} packages in the lock: ${counts(native.ffmpeg)}. Each package's licence files ship in \`tools/ffmpeg/licenses\`.

${table(native.ffmpeg)}
`
    : ''
}${
      native.licenceTexts?.length
        ? `
### Thermal tools

ExifTool (\`tools/exiftool\`, Artistic License or GPL, with its own Perl runtime) and the DJI Thermal SDK (\`tools/dji-tsdk\`), both prebuilt Windows x64 archives pinned by SHA-256 in \`tools/pipeline-pack/thermal-tools-lock.json\`. ExifTool runs as a separate program. The SDK's libraries are loaded by the pipelines; DJI's licence for them is quoted in full below and also ships as \`tools/dji-tsdk/License.txt\`. The libraries it links dynamically (libexif, libiconv, libintl) are LGPL-2.1 and replaceable.

${native.licenceTexts.map((t) => `#### ${t.name} licence\n\n\`\`\`text\n${t.text}\n\`\`\``).join('\n\n')}
`
        : ''
    }`);
  }
  if (models?.length) {
    out.push(`## Pipeline pack models

Model weights the pipeline pack carries, from \`tools/pipeline-pack/sam.mjs\`: fetched from the pinned source when the pack is built and refused unless the SHA-256 matches (ADR 0011). They run on this computer only; nothing is sent anywhere. Models a customer imports (detectors, Settings, Local detection) are theirs and are never redistributed by us.

${modelTable(models)}
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
export function render(js, py, native = null, data = null, models = null) {
  return `# Third-party notices

Inventory of the third-party software that ships with Quadrion AI 1.0: the desktop app, the Team Server image and the pipeline pack. Generated by \`node tools/release/notices.mjs\` from the installed trees of \`pnpm-lock.yaml\` and \`python/uv.lock\` and the native and data inventories; do not edit by hand. CI's licence reports list what they find and never fail a build (founder decision of 8 Oct 2026): \`pnpm license:check\` (npm), \`python/tests/test_licences.py\` (Python), \`tools/release/native-licences.mjs\` (native libraries) and \`tools/release/data-licences.mjs\` (data packs). The desktop app and the Team Server stay permissive; the pipeline pack has GPL parts (below).

The full licence texts ship with the software: the app lists every package with its licence in Settings, About, and the pipeline pack keeps each package's licence files in its \`site-packages\` folder.

## Desktop app and Team Server (npm)

${String(js.length)} packages: ${counts(js)}.

${table(js)}

## Pipeline pack (Python)

${String(py.length)} packages: ${counts(py)}. The pack also bundles CPython (PSF licence) from python-build-standalone; rasterio's wheel bundles GDAL (MIT) and its dependencies, and the pycolmap and opencv-python-headless wheels bundle the native libraries listed below, GPL parts included.

${table(py)}
${
  native || data || models
    ? `
${nativeSections(native, data, models)}`
    : ''
}

${ANALYTICS_PACK_NOTICES}

${DOWNLOADED_AT_RUN_TIME}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(
    jsInventory(),
    pythonInventory(),
    nativeInventory(),
    dataInventory(),
    modelInventory(),
  );
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
