// Local detection (BLD-10) in the packaged app: onnxruntime-node's native files must sit in
// app.asar.unpacked (electron-builder asarUnpack; native libraries never load from inside app.asar),
// and the running app must load the runtime and report a version and its execution providers.
// Used by check-bundle.mjs (files) and smoke-packaged.mjs (files and the app's answer).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const brand = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../packages/brand/brand.json'),
    'utf8',
  ),
);

/**
 * The unpacked apps electron-builder leaves in dist/, per platform (paths from apps/desktop):
 * `<executableName>.exe` on Windows, `<productName>.app` on macOS.
 */
export const PACKAGED_APPS = [
  {
    exe: `dist/win-unpacked/${brand.executableName}.exe`,
    resources: 'dist/win-unpacked/resources',
    platform: 'win32',
    arch: 'x64',
  },
  ...['mac-universal', 'mac-arm64', 'mac'].map((d) => ({
    exe: `dist/${d}/${brand.productName}.app/Contents/MacOS/${brand.productName}`,
    resources: `dist/${d}/${brand.productName}.app/Contents/Resources`,
    platform: 'darwin',
    // onnxruntime-node ships an arm64 binary only; universal apps carry it in both slices
    arch: 'arm64',
  })),
];

/** The first packaged app found in `dist/`, or null (store-only build). */
export function findPackagedApp(exists = existsSync) {
  return PACKAGED_APPS.find((a) => exists(a.exe)) ?? null;
}

/** Where the onnxruntime binaries of `platform`/`arch` sit, relative to the resources folder. */
export function onnxBinaryDir(platform, arch) {
  return `app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/${platform}/${arch}`;
}

/** The files local detection needs on each platform (name, or a pattern with a label). */
export const ONNX_FILES = {
  win32: ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll'],
  darwin: [
    'onnxruntime_binding.node',
    { label: 'libonnxruntime*.dylib', test: /^libonnxruntime.*\.dylib$/ },
  ],
  linux: ['onnxruntime_binding.node', { label: 'libonnxruntime.so*', test: /^libonnxruntime\.so/ }],
};

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/**
 * The onnxruntime files missing from the unpacked app (empty when all are there). `list` returns
 * a folder's file names, or null when the folder does not exist.
 */
export function missingOnnxFiles(resourcesDir, platform, arch, list = listDir) {
  const rel = onnxBinaryDir(platform, arch);
  const names = list(join(resourcesDir, rel));
  const wanted = ONNX_FILES[platform] ?? [];
  if (names === null)
    return [`${rel}/ (the folder is missing: is asarUnpack set for onnxruntime-node?)`];
  return wanted
    .filter((w) =>
      typeof w === 'string' ? !names.includes(w) : !names.some((n) => w.test.test(n)),
    )
    .map((w) => `${rel}/${typeof w === 'string' ? w : w.label}`);
}

const PROVIDERS = ['dml', 'coreml', 'cpu'];

/**
 * What is wrong with the app's smoke report (`main/smoke.ts`), or null when onnxruntime loaded,
 * reported a version and offers the CPU provider.
 */
export function onnxProbeProblem(report) {
  if (!report || typeof report !== 'object') return 'the app wrote no smoke report.';
  const inference = report.inference;
  if (!inference || typeof inference !== 'object')
    return 'the smoke report has no inference answer.';
  if (typeof inference.error === 'string') return `inference:models failed: ${inference.error}`;
  const rt = inference.runtime;
  if (!rt || typeof rt !== 'object') return 'inference:models answered without a runtime.';
  if (rt.available !== true)
    return `onnxruntime is not available: ${typeof rt.problem === 'string' ? rt.problem : 'no reason given'}`;
  if (typeof rt.version !== 'string' || rt.version === '')
    return 'onnxruntime loaded but reported no version.';
  if (!PROVIDERS.includes(rt.provider))
    return `onnxruntime reported an unknown execution provider (${String(rt.provider)}).`;
  if (Array.isArray(rt.backends) && !rt.backends.includes('cpu'))
    return `onnxruntime does not list the CPU provider (it lists ${rt.backends.join(', ') || 'none'}).`;
  return null;
}

/** One line for the log: version, provider in use, providers listed, and how it was asked. */
export function describeOnnx(report) {
  const rt = report?.inference?.runtime ?? {};
  const listed = Array.isArray(rt.backends) ? ` (lists ${rt.backends.join(', ')})` : '';
  const via =
    report?.via === 'main'
      ? `, asked from main because the window call failed: ${report.rendererError ?? 'unknown'}`
      : ', asked from the window';
  return `onnxruntime ${rt.version ?? '?'} on ${rt.provider ?? '?'}${listed}${via}`;
}

/** Local detection is required except on an Intel Mac (arm64 binary only; Settings says so). */
export function onnxRequired(platform, smokeArch) {
  return !(platform === 'darwin' && (smokeArch === 'x86_64' || smokeArch === 'x64'));
}
