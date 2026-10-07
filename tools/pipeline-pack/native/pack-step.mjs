// The native tools step of the pipeline pack build (tools/pipeline-pack/build.mjs --native, M10
// G1): which files of a build-native output go into the pack, the probe the pack's Python runs
// against them, and how to read its answer.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a build-native output (`<native>`) puts into a pack for `platform` (`win32-x64`...):
 * `{ wheels: [paths], tools: path | null, manifest }`, or an error naming what is wrong.
 */
export function nativePlan(native, platform) {
  const manifestPath = join(native, 'native-manifest.json');
  if (!existsSync(manifestPath))
    throw new Error(`${native} has no native-manifest.json (run native/build-native.mjs)`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'native-manifest/1')
    throw new Error(`${manifestPath} is not a native-manifest/1 file`);
  if (manifest.platform !== platform)
    throw new Error(
      `${native} was built for ${String(manifest.platform)}, this pack is ${platform}`,
    );
  const wheelDir = join(native, 'wheels');
  const wheels = existsSync(wheelDir)
    ? readdirSync(wheelDir)
        .filter((f) => f.endsWith('.whl'))
        .sort()
    : [];
  for (const want of ['pycolmap', 'opencv_python_headless'])
    if (!wheels.some((w) => w.startsWith(`${want}-`)))
      throw new Error(`${wheelDir} has no ${want} wheel`);
  const tools = join(native, 'tools');
  return {
    wheels: wheels.map((w) => join(wheelDir, w)),
    tools: existsSync(tools) ? tools : null,
    manifest,
  };
}

/** Python run with the pack's interpreter: what the native builds report about themselves. */
export const PROBE = `
import json, pycolmap, cv2
info = cv2.getBuildInformation()
video = info.split("Video I/O:", 1)[1].split("\\n\\n", 1)[0] if "Video I/O:" in info else ""
ffmpeg = any(l.strip().startswith(("FFMPEG:", "GStreamer:")) and "YES" in l for l in video.splitlines())
print(json.dumps({
    "pycolmap": pycolmap.__version__,
    "colmapBuild": pycolmap.COLMAP_build,
    "cuda": bool(pycolmap.has_cuda),
    "opencv": cv2.__version__,
    "ffmpeg": ffmpeg,
    "nonfree": "Non-free algorithms:" in info and "YES" in info.split("Non-free algorithms:", 1)[1].split("\\n", 1)[0],
}))
`;

/** Problems in the probe's answer: a GPU, CHOLMOD, FFmpeg or non-free build must never ship. */
export function probeProblems(p) {
  const out = [];
  if (p.cuda) out.push('pycolmap reports CUDA');
  if (!/without GPU support/.test(p.colmapBuild ?? ''))
    out.push(`pycolmap build is "${String(p.colmapBuild)}", expected one without GPU support`);
  if (!/without CHOLMOD/.test(p.colmapBuild ?? ''))
    out.push(`pycolmap build is "${String(p.colmapBuild)}", expected one without CHOLMOD`);
  if (p.ffmpeg) out.push('OpenCV has an FFmpeg or GStreamer video backend');
  if (p.nonfree) out.push('OpenCV has the non-free algorithms');
  return out;
}
