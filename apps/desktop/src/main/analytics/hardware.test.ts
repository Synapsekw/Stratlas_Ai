import { describe, expect, it } from 'vitest';
import { en } from '@aio/ui/i18n/en';
import { checkHardware, parseNvidiaSmi, pickedGpuIndex } from './hardware';

const ok = (stdout: string) => () => Promise.resolve({ code: 0, stdout });
const enoent = () =>
  Promise.reject(Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }));

describe('hardware check', () => {
  it('parses two GPUs and picks the most free', async () => {
    const csv =
      '0, NVIDIA GeForce RTX 5070 Ti, 16303, 9517, 591.86, 12.0\r\n1, NVIDIA RTX A2000, 12288, 11000, 591.86, 8.6\n';
    expect(parseNvidiaSmi(csv)).toEqual([
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 5070 Ti',
        totalMb: 16303,
        freeMb: 9517,
        driver: '591.86',
        computeCap: 12,
      },
      {
        index: 1,
        name: 'NVIDIA RTX A2000',
        totalMb: 12288,
        freeMb: 11000,
        driver: '591.86',
        computeCap: 8.6,
      },
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
    const csv =
      '0, NVIDIA RTX A1000, 8000, 7900, 591.86, 8.6\n1, NVIDIA GeForce RTX 4080, 16376, 7000, 591.86, 8.9\n';
    expect(await checkHardware({ platform: 'win32', exec: ok(csv) })).toEqual({
      ok: true,
      gpu: 'NVIDIA GeForce RTX 4080',
      gpuIndex: 1,
      totalMb: 16376,
      freeMb: 7000,
    });
    const three =
      '0, NVIDIA T400, 4096, 4000, 591.86, 7.5\n1, RTX A4000, 16376, 7000, 591.86, 8.6\n2, RTX 4070, 12282, 11000, 591.86, 8.9\n';
    expect(await checkHardware({ platform: 'win32', exec: ok(three) })).toMatchObject({
      ok: true,
      gpuIndex: 2,
    });
  });

  it('several GPUs: a busy big card is tooBusy, not tooSmall from a small idle card', async () => {
    const csv =
      '0, NVIDIA T600, 4096, 3990, 591.86, 7.5\n1, NVIDIA GeForce RTX 4080, 16376, 3584, 591.86, 8.9\n';
    expect(await checkHardware({ platform: 'win32', exec: ok(csv) })).toEqual({
      ok: false,
      code: 'tooBusy',
      reason: en['detect.preset.hw.tooBusy'].replace('{free}', '3.5'),
    });
  });

  it('several GPUs, none with 8192 MB: tooSmall', async () => {
    const csv = '0, NVIDIA T600, 4096, 3990, 591.86, 7.5\n1, RTX 2060, 6144, 3000, 591.86, 7.5\n';
    expect(await checkHardware({ platform: 'win32', exec: ok(csv) })).toEqual({
      ok: false,
      code: 'tooSmall',
      reason: en['detect.preset.hw.tooSmall'].replace('{total}', '4'),
    });
  });

  it('no nvidia-smi is "No NVIDIA graphics card found"', async () => {
    const r = await checkHardware({ platform: 'win32', exec: enoent });
    expect(r).toEqual({ ok: false, code: 'noGpu', reason: en['detect.preset.hw.noGpu'] });
    expect(!r.ok && r.reason).toMatch(/^No NVIDIA graphics card found/);
    expect(pickedGpuIndex(r)).toBeNull();
  });

  it('total under 8192 MB uses tooSmall with whole GB', async () => {
    const r = await checkHardware({
      platform: 'win32',
      exec: ok('0, RTX 2060, 6144, 6000, 591.86, 7.5'),
    });
    expect(r).toEqual({
      ok: false,
      code: 'tooSmall',
      reason: en['detect.preset.hw.tooSmall'].replace('{total}', '6'),
    });
  });

  it('free too low names both numbers', async () => {
    const r = await checkHardware({
      platform: 'win32',
      exec: ok('0, RTX 4070, 12282, 3481, 591.86, 8.9'),
    });
    expect(r).toEqual({
      ok: false,
      code: 'tooBusy',
      reason: en['detect.preset.hw.tooBusy'].replace('{free}', '3.4'),
    });
  });

  it('minFreeMb raises the free memory floor', async () => {
    const csv = '0, RTX 4070, 12282, 7000, 591.86, 8.9';
    expect(await checkHardware({ platform: 'win32', exec: ok(csv) })).toMatchObject({ ok: true });
    expect(await checkHardware({ platform: 'win32', exec: ok(csv), minFreeMb: 7400 })).toEqual({
      ok: false,
      code: 'tooBusy',
      reason: en['detect.preset.hw.tooBusy'].replace('{free}', '6.8'),
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
    expect(r).toEqual({ ok: false, code: 'mac', reason: en['detect.preset.hw.mac'] });
    expect(called).toBe(false);
  });

  it('garbage output is noGpu', async () => {
    for (const out of ['', 'NVIDIA-SMI has failed', 'a, b, c, d']) {
      const r = await checkHardware({ platform: 'win32', exec: ok(out) });
      expect(r).toEqual({ ok: false, code: 'noGpu', reason: en['detect.preset.hw.noGpu'] });
    }
    expect(
      await checkHardware({
        platform: 'win32',
        exec: () => Promise.resolve({ code: 9, stdout: '0, X, 16000, 9000, 591.86, 8.9' }),
      }),
    ).toMatchObject({ ok: false });
  });

  it('refuses a card older than compute 7.5', async () => {
    const r = await checkHardware({
      platform: 'win32',
      exec: ok('0, NVIDIA GeForce GTX 1080, 8192, 8000, 591.86, 6.1'),
    });
    expect(r).toEqual({
      ok: false,
      code: 'oldGpu',
      reason: en['detect.preset.hw.oldGpu'].replace('{gpu}', 'NVIDIA GeForce GTX 1080'),
    });
  });

  it('refuses a driver older than 580', async () => {
    const r = await checkHardware({
      platform: 'win32',
      exec: ok('0, NVIDIA GeForce RTX 4080, 16376, 15000, 572.16, 8.9'),
    });
    expect(r).toEqual({
      ok: false,
      code: 'oldDriver',
      reason: en['detect.preset.hw.oldDriver'].replace('{version}', '572.16'),
    });
  });

  it('checks the driver before the card and the card before its memory', async () => {
    // an old driver on an old, small card: the driver is named first
    const old = ok('0, NVIDIA GeForce GTX 1060, 6144, 6000, 572.16, 6.1');
    expect(await checkHardware({ platform: 'win32', exec: old })).toMatchObject({
      code: 'oldDriver',
    });
    // a new driver: the old card, not its memory
    const card = ok('0, NVIDIA GeForce GTX 1060, 6144, 6000, 591.86, 6.1');
    expect(await checkHardware({ platform: 'win32', exec: card })).toMatchObject({
      code: 'oldGpu',
    });
    // a new card beside an old one is picked though the old one has more free memory
    const two = ok(
      '0, NVIDIA GeForce GTX 1080 Ti, 11264, 11000, 591.86, 6.1\n1, RTX 4070, 12282, 8000, 591.86, 8.9',
    );
    expect(await checkHardware({ platform: 'win32', exec: two })).toMatchObject({
      ok: true,
      gpuIndex: 1,
    });
  });

  it('falls back when compute_cap is not a query field', async () => {
    const asked: string[][] = [];
    const r = await checkHardware({
      platform: 'win32',
      exec: (_file, args) => {
        asked.push(args);
        if (args.some((a) => a.includes('compute_cap')))
          return Promise.reject(new Error('Field "compute_cap" is not a valid field to query.'));
        return Promise.resolve({ code: 0, stdout: '0, RTX 4070, 12282, 11000, 591.86' });
      },
    });
    expect(r).toEqual({ ok: true, gpu: 'RTX 4070', gpuIndex: 0, totalMb: 12282, freeMb: 11000 });
    expect(asked).toHaveLength(2);
    expect(asked[1]?.[0]).toBe('--query-gpu=index,name,memory.total,memory.free,driver_version');
    expect(parseNvidiaSmi('0, RTX 4070, 12282, 11000, 591.86', false)).toEqual([
      {
        index: 0,
        name: 'RTX 4070',
        totalMb: 12282,
        freeMb: 11000,
        driver: '591.86',
        computeCap: null,
      },
    ]);
  });

  it('falls back when nvidia-smi exits naming compute_cap as not a valid field', async () => {
    const asked: string[][] = [];
    const r = await checkHardware({
      platform: 'win32',
      exec: (_file, args) => {
        asked.push(args);
        return Promise.resolve(
          args.some((a) => a.includes('compute_cap'))
            ? { code: 2, stdout: 'Field "compute_cap" is not a valid field to query.' }
            : { code: 0, stdout: '0, RTX 4070, 12282, 11000, 591.86' },
        );
      },
    });
    expect(r).toMatchObject({ ok: true, gpuIndex: 0 });
    expect(asked).toHaveLength(2);
  });

  it('does not ask again without compute_cap when nvidia-smi times out', async () => {
    const asked: string[][] = [];
    const r = await checkHardware({
      platform: 'win32',
      exec: (file, args) => {
        asked.push(args);
        // what execFile says of a run it killed: the command line, compute_cap included
        return Promise.reject(new Error(`Command failed: ${file} ${args.join(' ')}`));
      },
    });
    expect(r).toMatchObject({ ok: false, code: 'noGpu' });
    // once per place nvidia-smi may be, never the shorter query
    expect(asked).toHaveLength(2);
    expect(asked.every((a) => a[0]?.endsWith(',compute_cap'))).toBe(true);
  });

  it('every refusal carries its code', async () => {
    const checks = [
      checkHardware({ platform: 'darwin', exec: ok('') }),
      checkHardware({ platform: 'win32', exec: enoent }),
      checkHardware({ platform: 'win32', exec: ok('0, RTX 2060, 6144, 6000, 591.86, 7.5') }),
      checkHardware({ platform: 'win32', exec: ok('0, RTX 4070, 12282, 3481, 591.86, 8.9') }),
      checkHardware({ platform: 'win32', exec: ok('0, GTX 1080, 8192, 8000, 591.86, 6.1') }),
      checkHardware({ platform: 'win32', exec: ok('0, RTX 4070, 12282, 11000, 572.16, 8.9') }),
    ];
    const codes = (await Promise.all(checks)).map((r) => (r.ok ? null : r.code));
    expect(codes).toEqual(['mac', 'noGpu', 'tooSmall', 'tooBusy', 'oldGpu', 'oldDriver']);
  });
});
