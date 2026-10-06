import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeOnnx,
  findPackagedApp,
  missingOnnxFiles,
  onnxBinaryDir,
  onnxProbeProblem,
  onnxRequired,
} from './onnx-probe.mjs';

const RES = 'dist/win-unpacked/resources';
const WIN_DIR = join(RES, onnxBinaryDir('win32', 'x64'));
const lister = (files) => (dir) => files[dir] ?? null;

describe('findPackagedApp', () => {
  it('finds the Windows app, then the Mac ones, else nothing', () => {
    expect(findPackagedApp((p) => p === 'dist/win-unpacked/Stratlas.exe')).toMatchObject({
      resources: RES,
      platform: 'win32',
      arch: 'x64',
    });
    expect(
      findPackagedApp((p) => p === 'dist/mac-universal/Stratlas.app/Contents/MacOS/Stratlas'),
    ).toMatchObject({
      resources: 'dist/mac-universal/Stratlas.app/Contents/Resources',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(findPackagedApp(() => false)).toBeNull();
  });
});

describe('missingOnnxFiles', () => {
  it('is empty when the Windows binding and DLLs are unpacked', () => {
    const list = lister({
      [WIN_DIR]: [
        'DirectML.dll',
        'dxcompiler.dll',
        'dxil.dll',
        'onnxruntime.dll',
        'onnxruntime_binding.node',
      ],
    });
    expect(missingOnnxFiles(RES, 'win32', 'x64', list)).toEqual([]);
  });

  it('names each missing Windows file', () => {
    const list = lister({ [WIN_DIR]: ['onnxruntime_binding.node'] });
    expect(missingOnnxFiles(RES, 'win32', 'x64', list)).toEqual([
      `${onnxBinaryDir('win32', 'x64')}/onnxruntime.dll`,
      `${onnxBinaryDir('win32', 'x64')}/DirectML.dll`,
    ]);
  });

  it('says when the unpacked folder is missing altogether', () => {
    const [only, ...rest] = missingOnnxFiles(RES, 'win32', 'x64', lister({}));
    expect(rest).toEqual([]);
    expect(only).toContain(
      'app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/',
    );
    expect(only).toContain('asarUnpack');
  });

  it('accepts any versioned dylib on the Mac', () => {
    const res = 'dist/mac/Stratlas.app/Contents/Resources';
    const dir = join(res, onnxBinaryDir('darwin', 'arm64'));
    expect(
      missingOnnxFiles(
        res,
        'darwin',
        'arm64',
        lister({ [dir]: ['libonnxruntime.1.30.0.dylib', 'onnxruntime_binding.node'] }),
      ),
    ).toEqual([]);
    expect(
      missingOnnxFiles(res, 'darwin', 'arm64', lister({ [dir]: ['onnxruntime_binding.node'] })),
    ).toEqual([`${onnxBinaryDir('darwin', 'arm64')}/libonnxruntime*.dylib`]);
  });
});

describe('onnxProbeProblem', () => {
  const ok = {
    via: 'renderer',
    inference: {
      runtime: { available: true, provider: 'dml', version: '1.30.0', backends: ['cpu', 'dml'] },
      models: [],
    },
  };

  it('accepts a runtime with a version and the CPU provider', () => {
    expect(onnxProbeProblem(ok)).toBeNull();
    expect(describeOnnx(ok)).toBe(
      'onnxruntime 1.30.0 on dml (lists cpu, dml), asked from the window',
    );
    // an older app without the provider list still passes on its provider
    const older = { available: true, provider: 'cpu', version: '1.30.0' };
    expect(onnxProbeProblem({ inference: { runtime: older } })).toBeNull();
  });

  it('explains every way the probe can fail', () => {
    expect(onnxProbeProblem(null)).toBe('the app wrote no smoke report.');
    expect(onnxProbeProblem({ via: 'main', inference: { error: 'timed out' } })).toBe(
      'inference:models failed: timed out',
    );
    expect(onnxProbeProblem({ inference: {} })).toBe(
      'inference:models answered without a runtime.',
    );
    expect(
      onnxProbeProblem({
        inference: {
          runtime: { available: false, problem: 'The ONNX runtime could not be loaded: x' },
        },
      }),
    ).toBe('onnxruntime is not available: The ONNX runtime could not be loaded: x');
    expect(onnxProbeProblem({ inference: { runtime: { available: true, provider: 'cpu' } } })).toBe(
      'onnxruntime loaded but reported no version.',
    );
    expect(
      onnxProbeProblem({
        inference: { runtime: { available: true, version: '1', provider: 'tpu' } },
      }),
    ).toContain('unknown execution provider');
    expect(
      onnxProbeProblem({
        inference: {
          runtime: { available: true, version: '1', provider: 'dml', backends: ['dml'] },
        },
      }),
    ).toBe('onnxruntime does not list the CPU provider (it lists dml).');
  });

  it('says when main had to ask because the window call failed', () => {
    expect(
      describeOnnx({ ...ok, via: 'main', rendererError: 'window.aio is undefined' }),
    ).toContain('asked from main because the window call failed: window.aio is undefined');
  });
});

describe('onnxRequired', () => {
  it('requires local detection except on an Intel Mac', () => {
    expect(onnxRequired('win32', 'x64')).toBe(true);
    expect(onnxRequired('darwin', 'arm64')).toBe(true);
    expect(onnxRequired('darwin', 'x86_64')).toBe(false);
    expect(onnxRequired('darwin', 'x64')).toBe(false);
  });
});
