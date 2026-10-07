import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativePlan, probeProblems } from './pack-step.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pack-native-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const output = (platform, wheels) => {
  writeFileSync(
    join(dir, 'native-manifest.json'),
    JSON.stringify({ schema: 'aio.native-manifest/1', platform }),
  );
  mkdirSync(join(dir, 'wheels'));
  for (const w of wheels) writeFileSync(join(dir, 'wheels', w), 'zip');
};

describe('native step of the pack build', () => {
  it('takes the wheels and tools of a build for this platform', () => {
    output('win32-x64', [
      'pycolmap-4.2.1-cp313-cp313-win_amd64.whl',
      'opencv_python_headless-5.0.0.93-cp37-abi3-win_amd64.whl',
    ]);
    mkdirSync(join(dir, 'tools', 'pdal', 'bin'), { recursive: true });
    const plan = nativePlan(dir, 'win32-x64');
    expect(plan.wheels.map((w) => w.split(/[\\/]/).pop())).toEqual([
      'opencv_python_headless-5.0.0.93-cp37-abi3-win_amd64.whl',
      'pycolmap-4.2.1-cp313-cp313-win_amd64.whl',
    ]);
    expect(plan.tools).toBe(join(dir, 'tools'));
  });

  it('refuses a build for another platform, a missing wheel or no manifest', () => {
    expect(() => nativePlan(dir, 'win32-x64')).toThrow(/no native-manifest.json/);
    output('darwin-arm64', ['pycolmap-4.2.1-cp313-cp313-macosx_14_0_arm64.whl']);
    expect(() => nativePlan(dir, 'win32-x64')).toThrow(/built for darwin-arm64/);
    expect(() => nativePlan(dir, 'darwin-arm64')).toThrow(/no opencv_python_headless wheel/);
  });

  it('accepts a CPU build without CHOLMOD and FFmpeg, refuses anything else', () => {
    const good = {
      colmapBuild:
        'Commit bd1fcf6 on 2026-09-29 without GPU support, without CHOLMOD, std hash maps',
      cuda: false,
      ffmpeg: false,
      nonfree: false,
    };
    expect(probeProblems(good)).toEqual([]);
    expect(
      probeProblems({
        colmapBuild: 'Commit x on y with CUDA, with CHOLMOD, std hash maps',
        cuda: true,
        ffmpeg: true,
        nonfree: true,
      }),
    ).toHaveLength(5);
    // A PyPI pycolmap says nothing about CHOLMOD: refused too.
    expect(
      probeProblems({ ...good, colmapBuild: 'Commit x on y without GPU support, std hash maps' }),
    ).toEqual([expect.stringMatching(/without CHOLMOD/)]);
  });
});
