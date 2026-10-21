import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scrubPackagedEnv } from './packagedEnv';

const ud = join(process.cwd(), 'smoke-ud');

describe('scrubPackagedEnv', () => {
  it('keeps every switch in an unpackaged build', () => {
    const env = { ELECTRON_RENDERER_URL: 'http://x', QUADRION_PIPELINE_PYTHON: 'p' };
    expect(scrubPackagedEnv(env, false)).toEqual([]);
    expect(env.ELECTRON_RENDERER_URL).toBe('http://x');
  });

  it('drops code- and URL-loading switches from a packaged build', () => {
    const env: Record<string, string | undefined> = {
      ELECTRON_RENDERER_URL: 'https://evil.example',
      QUADRION_FFMPEG: 'C:\\evil.exe',
      QUADRION_PIPELINE_PYTHON: 'C:\\evil.exe',
      QUADRION_PIPELINE_PACK: 'C:\\pack',
      QUADRION_ODM_DIR: 'C:\\odm',
      QUADRION_AI_TEST_PROVIDER: '1',
      QUADRION_E2E: '1',
      QUADRION_PACK_SOURCE: 'http://127.0.0.1/',
      STRATLAS_FFMPEG: 'C:\\evil.exe',
      QUADRION_DATA: 'D:\\Data',
      QUADRION_WINDOW_SIZE: '1100x720',
      PATH: 'C:\\Windows',
    };
    const removed = scrubPackagedEnv(env, true);
    expect(removed).toEqual(
      expect.arrayContaining([
        'ELECTRON_RENDERER_URL',
        'QUADRION_FFMPEG',
        'QUADRION_PIPELINE_PYTHON',
        'QUADRION_PIPELINE_PACK',
        'QUADRION_ODM_DIR',
        'QUADRION_AI_TEST_PROVIDER',
        'QUADRION_E2E',
        'QUADRION_PACK_SOURCE',
        'STRATLAS_FFMPEG',
      ]),
    );
    expect(Object.keys(env).sort()).toEqual(['PATH', 'QUADRION_DATA', 'QUADRION_WINDOW_SIZE']);
  });

  it('keeps what the packaged smoke test sets', () => {
    const env: Record<string, string | undefined> = {
      QUADRION_SMOKE: '1',
      QUADRION_USER_DATA: ud,
      QUADRION_SMOKE_REPORT: join(ud, 'smoke-report.json'),
      QUADRION_TEST_VAULT: '1',
      QUADRION_DATA: join(ud, 'data'),
    };
    expect(scrubPackagedEnv(env, true)).toEqual([]);
  });

  it('drops the test vault and the report outside a smoke run or outside its folder', () => {
    const noSmoke: Record<string, string | undefined> = {
      QUADRION_USER_DATA: ud,
      QUADRION_TEST_VAULT: '1',
      QUADRION_SMOKE_REPORT: join(ud, 'r.json'),
    };
    scrubPackagedEnv(noSmoke, true);
    expect(noSmoke.QUADRION_TEST_VAULT).toBeUndefined();
    expect(noSmoke.QUADRION_SMOKE_REPORT).toBeUndefined();

    const outside: Record<string, string | undefined> = {
      QUADRION_SMOKE: '1',
      QUADRION_USER_DATA: ud,
      QUADRION_SMOKE_REPORT: join(ud, '..', 'elsewhere.json'),
    };
    scrubPackagedEnv(outside, true);
    expect(outside.QUADRION_SMOKE_REPORT).toBeUndefined();
  });
});
