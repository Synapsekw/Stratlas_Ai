import { describe, expect, it } from 'vitest';
import { t } from '@aio/ui/i18n';
import { checkHardware, parseNvidiaSmi, pickedGpuIndex } from './hardware';

const ok = (stdout: string) => () => Promise.resolve({ code: 0, stdout });
const enoent = () =>
  Promise.reject(Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }));

describe('hardware check', () => {
  it('parses two GPUs and picks the most free', async () => {
    const csv = '0, NVIDIA GeForce RTX 5070 Ti, 16303, 9517\r\n1, NVIDIA RTX A2000, 12288, 11000\n';
    expect(parseNvidiaSmi(csv)).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 5070 Ti', totalMb: 16303, freeMb: 9517 },
      { index: 1, name: 'NVIDIA RTX A2000', totalMb: 12288, freeMb: 11000 },
    ]);
    const r = await checkHardware({ platform: 'win32', exec: ok(csv) });
    expect(r).toEqual({ ok: true, gpu: 'NVIDIA RTX A2000', totalMb: 12288, freeMb: 11000 });
    expect(pickedGpuIndex(r)).toBe(1);
  });

  it('no nvidia-smi is "No NVIDIA graphics card found"', async () => {
    const r = await checkHardware({ platform: 'win32', exec: enoent });
    expect(r).toEqual({ ok: false, reason: t('detect.preset.hw.noGpu') });
    expect(!r.ok && r.reason).toMatch(/^No NVIDIA graphics card found/);
    expect(pickedGpuIndex(r)).toBeNull();
  });

  it('total under 8192 MB uses tooSmall with whole GB', async () => {
    const r = await checkHardware({ platform: 'win32', exec: ok('0, GTX 1060, 6144, 6000') });
    expect(r).toEqual({ ok: false, reason: t('detect.preset.hw.tooSmall', { total: 6 }) });
  });

  it('free too low names both numbers', async () => {
    const r = await checkHardware({ platform: 'win32', exec: ok('0, RTX 4070, 12282, 3481') });
    expect(r).toEqual({ ok: false, reason: t('detect.preset.hw.tooBusy', { free: '3.4' }) });
  });

  it('darwin is the mac message', async () => {
    let called = false;
    const r = await checkHardware({
      platform: 'darwin',
      exec: () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: '' });
      },
    });
    expect(r).toEqual({ ok: false, reason: t('detect.preset.hw.mac') });
    expect(called).toBe(false);
  });

  it('garbage output is noGpu', async () => {
    for (const out of ['', 'NVIDIA-SMI has failed', 'a, b, c, d']) {
      const r = await checkHardware({ platform: 'win32', exec: ok(out) });
      expect(r).toEqual({ ok: false, reason: t('detect.preset.hw.noGpu') });
    }
    expect(
      await checkHardware({
        platform: 'win32',
        exec: () => Promise.resolve({ code: 9, stdout: '0, X, 16000, 9000' }),
      }),
    ).toMatchObject({ ok: false });
  });
});
