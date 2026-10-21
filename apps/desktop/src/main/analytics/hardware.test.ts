import { describe, expect, it } from 'vitest';
import { en } from '@aio/ui/i18n/en';
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
    expect(r).toEqual({
      ok: true,
      gpu: 'NVIDIA RTX A2000',
      gpuIndex: 1,
      totalMb: 12288,
      freeMb: 11000,
    });
    expect(pickedGpuIndex(r)).toBe(1);
  });

  it('several GPUs: picks among cards with 8192 MB or more first, then the most free', async () => {
    // a small card with more free memory does not win over a big one with enough free
    const csv = '0, NVIDIA RTX A1000, 8000, 7900\n1, NVIDIA GeForce RTX 4080, 16376, 7000\n';
    expect(await checkHardware({ platform: 'win32', exec: ok(csv) })).toEqual({
      ok: true,
      gpu: 'NVIDIA GeForce RTX 4080',
      gpuIndex: 1,
      totalMb: 16376,
      freeMb: 7000,
    });
    const three =
      '0, NVIDIA T400, 4096, 4000\n1, RTX A4000, 16376, 7000\n2, RTX 4070, 12282, 11000\n';
    expect(await checkHardware({ platform: 'win32', exec: ok(three) })).toMatchObject({
      ok: true,
      gpuIndex: 2,
    });
  });

  it('several GPUs: a busy big card is tooBusy, not tooSmall from a small idle card', async () => {
    const csv = '0, NVIDIA T600, 4096, 3990\n1, NVIDIA GeForce RTX 4080, 16376, 3584\n';
    expect(await checkHardware({ platform: 'win32', exec: ok(csv) })).toEqual({
      ok: false,
      reason: en['detect.preset.hw.tooBusy'].replace('{free}', '3.5'),
    });
  });

  it('several GPUs, none with 8192 MB: tooSmall', async () => {
    const csv = '0, NVIDIA T600, 4096, 3990\n1, GTX 1060, 6144, 3000\n';
    expect(await checkHardware({ platform: 'win32', exec: ok(csv) })).toEqual({
      ok: false,
      reason: en['detect.preset.hw.tooSmall'].replace('{total}', '4'),
    });
  });

  it('no nvidia-smi is "No NVIDIA graphics card found"', async () => {
    const r = await checkHardware({ platform: 'win32', exec: enoent });
    expect(r).toEqual({ ok: false, reason: en['detect.preset.hw.noGpu'] });
    expect(!r.ok && r.reason).toMatch(/^No NVIDIA graphics card found/);
    expect(pickedGpuIndex(r)).toBeNull();
  });

  it('total under 8192 MB uses tooSmall with whole GB', async () => {
    const r = await checkHardware({ platform: 'win32', exec: ok('0, GTX 1060, 6144, 6000') });
    expect(r).toEqual({
      ok: false,
      reason: en['detect.preset.hw.tooSmall'].replace('{total}', '6'),
    });
  });

  it('free too low names both numbers', async () => {
    const r = await checkHardware({ platform: 'win32', exec: ok('0, RTX 4070, 12282, 3481') });
    expect(r).toEqual({
      ok: false,
      reason: en['detect.preset.hw.tooBusy'].replace('{free}', '3.4'),
    });
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
    expect(r).toEqual({ ok: false, reason: en['detect.preset.hw.mac'] });
    expect(called).toBe(false);
  });

  it('garbage output is noGpu', async () => {
    for (const out of ['', 'NVIDIA-SMI has failed', 'a, b, c, d']) {
      const r = await checkHardware({ platform: 'win32', exec: ok(out) });
      expect(r).toEqual({ ok: false, reason: en['detect.preset.hw.noGpu'] });
    }
    expect(
      await checkHardware({
        platform: 'win32',
        exec: () => Promise.resolve({ code: 9, stdout: '0, X, 16000, 9000' }),
      }),
    ).toMatchObject({ ok: false });
  });
});
